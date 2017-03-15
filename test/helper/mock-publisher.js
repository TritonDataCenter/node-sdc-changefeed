/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/* Test the publisher components */

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_moray = require('moray');
var mod_restify = require('restify');
var mod_libuuid = require('libuuid');
var mod_util = require('util');
var mod_vasync = require('vasync');

var Publisher = require('../../lib/publisher');

var resources = [
    {
        resource: 'vm',
        subResources: ['nic', 'alias'],
        bootstrapRoute: '/vms'
    }
];

var TEST_BUCKET_NAME = 'sdc_changefeed_test_pub_change_bucket';
var testLogger = mod_bunyan.createLogger({
    name: 'publisher_test',
    level: process.env['LOG_LEVEL'] || 'error',
    stream: process.stderr
});


var PUBLISHER_OPTIONS = {
    log: testLogger,
    moray: {
        bucketName: TEST_BUCKET_NAME,
        host: '10.99.99.17',
        resolvers: {
            resolvers: ['10.99.99.11']
        },
        timeout: 200,
        minTimeout: 1000,
        maxTimeout: 2000,
        port: 2020
    },
    resources: resources,
    maxAge: 2
};

function MockPublisher(options) {
    mod_events.EventEmitter.call(this);

    mod_assert.object(options, 'options');

    mod_assert.number(options.nbPrimaryChangesToPublish,
        'options.nbPrimaryChangesToPublish');
    mod_assert.number(options.nbSecondaryChangesToPublish,
        'options.nbSecondaryChangesToPublish');
    mod_assert.optionalBool(options.publishBonusRound,
        'options.publishBonusRound');
    mod_assert.optionalNumber(options.nbMountSrvRoutesAfterCreate,
        'options.nbMountSrvRoutesAfterCreate');

    this.nbPrimaryChangesToPublish = options.nbPrimaryChangesToPublish;
    this.nbSecondaryChangesToPublish = options.nbSecondaryChangesToPublish;
    this.publishBonusRound = options.publishBonusRound;
    this.nbMountSrvRoutesAfterCreate = options.nbMountSrvRoutesAfterCreate;

    this.server = mod_restify.createServer();
}
mod_util.inherits(MockPublisher, mod_events.EventEmitter);

function publishChanges(publisher, options) {
    mod_assert.object(publisher, 'publisher');
    mod_assert.object(options, 'options');
    mod_assert.number(options.nbPrimaryChanges, 'options.nbPrimaryChanges');
    mod_assert.number(options.nbSecondaryChanges, 'options.nbSecondaryChanges');
    mod_assert.optionalBool(options.publishBonusRound,
        'options.publishBonusRound');

    var testChange = {
        changeKind: {
            resource: 'vm',
            subResources: ['nic']
        },
        changedResourceId: ''
    };

    var testChange2 = {
        changeKind: {
            resource: 'vm',
            subResources: ['alias']
        },
        changedResourceId: ''
    };

    var nbPrimaryChangesToPublish = options.nbPrimaryChanges;
    var nbSecondaryChangesToPublish = options.nbSecondaryChanges;
    for (var i = 0; i < nbPrimaryChangesToPublish; i++) {
        testChange.changedResourceId = mod_libuuid.create();
        publisher.publish(testChange, publishHandler);
    }
    for (var j = 0; j < nbSecondaryChangesToPublish; j++) {
        testChange2.changedResourceId = mod_libuuid.create();
        publisher.publish(testChange2, publishHandler);
    }

    if (options.publishBonusRound) {
        setInterval(function () {
            for (var p = 0; p < nbPrimaryChangesToPublish; p++) {
                testChange.changedResourceId = mod_libuuid.create();
                publisher.publish(testChange, publishHandler);
            }
        }, 2000);
    }

    function publishHandler(err) {
        if (err) {
            console.log(err);
        }
    }
}

MockPublisher.prototype.start = function start(callback) {
    mod_assert.func(callback, 'callback');

    var publisher;
    var self = this;

    mod_vasync.pipeline({funcs: [
        function cleanupTestBucket(ctx, next) {
            var morayClientOptions =
                mod_jsprim.deepCopy(PUBLISHER_OPTIONS.moray);
            morayClientOptions.log =
                testLogger.child({component: 'moray-client'});

            var morayClient = mod_moray.createClient(morayClientOptions);

            morayClient.on('connect', function onMorayConnected() {
                morayClient.delBucket(TEST_BUCKET_NAME,
                    function onBucketDeleted(delBucketErr) {
                        morayClient.close();

                        if (delBucketErr &&
                            delBucketErr.name !== 'BucketNotFoundError') {
                            next(new Error('error when deleting test bucket: ' +
                                delBucketErr));
                            return;
                        } else {
                            next();
                            return;
                        }
                    });
            });
        },
        function doStartPublisher(ctx, next) {
            var i = 0;

            if (!this.nbMountSrvRoutesAfterCreate) {
                PUBLISHER_OPTIONS.restifyServer = self.server;
            }

            self.publisher = publisher = new Publisher(PUBLISHER_OPTIONS);

            for (i = 0; i < this.nbMountSrvRoutesAfterCreate; ++i) {
                publisher.mountRestifyServerRoutes(self.server);
            }

            publisher.on('moray-ready', function () {
                publisher.start();

                next();
            });

            publisher.on('registration', function () {
                publishChanges(publisher, {
                    nbPrimaryChanges: self.nbPrimaryChangesToPublish,
                    nbSecondaryChanges: self.nbSecondaryChangesToPublish,
                    publishBonusRound: self.publishBonusRound
                });
            });
        }
    ]}, function onPublisherStarted(publisherStartErr) {
        if (publisherStartErr) {
            callback(publisherStartErr);
        } else {
            self.server.listen(0, 'localhost', function () {
                callback(null, {
                    address: self.server.address().address,
                    port: self.server.address().port
                });
            });
        }
    });
};

MockPublisher.prototype.closeClientConnections =
    function closeClientConnections() {
    var instance;
    var self = this;
    var websocket;

    for (instance in self.publisher.websockets) {
        websocket = self.publisher.websockets[instance];
        websocket.destroy();
    }
};

MockPublisher.prototype.close = function close() {
    mod_assert.object(this.server, 'this.server');

    var self = this;

    self.publisher.stop();
    self.server.close();

    self.server.on('close', function onServerClosed() {
        self.emit('close');
    });
};

module.exports = MockPublisher;
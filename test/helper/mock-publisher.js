/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/* Test the publisher components */

var Publisher = require('../../lib/publisher');
var mod_bunyan = require('bunyan');
var mod_restify = require('restify');
var mod_libuuid = require('libuuid');

var client = mod_restify.createJsonClient({
    url: 'http://localhost:8080'
});
var server = mod_restify.createServer();
var resources = [
    {
        resource: 'vm',
        subResources: ['nic', 'alias'],
        bootstrapRoute: '/vms'
    }
];
var options = {
    log: mod_bunyan.createLogger({
        name: 'publisher_test',
        level: process.env['LOG_LEVEL'] || 'trace',
        stream: process.stderr
    }),
    moray: {
        bucketName: 'pub_change_bucket',
        host: '10.99.99.17',
        resolvers: {
            resolvers: ['10.99.99.11']
        },
        timeout: 200,
        minTimeout: 1000,
        maxTimeout: 2000,
        port: 2020
    },
    restifyServer: server,
    resources: resources,
    maxAge: 2
};

var publisher = new Publisher(options);

publisher.on('moray-ready', function () {
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

    publisher.once('registration', function () {
        var changes = process.argv[2];
        var changes2 = process.argv[3];
        for (var i = 0; i < changes; i++) {
            testChange.changedResourceId = mod_libuuid.create();
            publisher.publish(testChange, publishHandler);
        }
        for (var j = 0; j < changes2; j++) {
            testChange2.changedResourceId = mod_libuuid.create();
            publisher.publish(testChange2, publishHandler);
        }

        if (process.argv[4] === 'bonus') {
            setInterval(function () {
                console.log('Publishing bonus round!');
                for (var p = 0; p < changes; p++) {
                    testChange.changedResourceId = mod_libuuid.create();
                    publisher.publish(testChange, publishHandler);
                }
            }, 2000);
        }
    });

    publisher.start();
    publisher.on('item-published', function () {
        console.log('item-published');
    });
    publisher.on('no-items', function () {
        console.log('no-items');
    });
});

server.listen(8080, function () {
    console.log('%s listening at %s', server.name, server.url);
});

function publishHandler(err) {
    if (err) {
        console.log(err);
    }
    console.log('Published!');
}

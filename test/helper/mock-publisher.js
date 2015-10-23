#!/opt/pkg/bin/node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/* Test the publisher components */

var Publisher = require('../../lib/publisher');
var Bunyan = require('bunyan');
var restify = require('restify');
var libuuid = require('node-libuuid');

var client = restify.createJsonClient({
    url: 'http://localhost:8080'
});
var server = restify.createServer();
var resources = [
    {
        resource: 'vm',
        subResources: ['nic', 'alias'],
        bootstrapRoute: '/vms'
    }
];
var options = {
    log: new Bunyan({
        name: 'publisher_test',
        level: process.env['LOG_LEVEL'] || 'trace',
        stream: process.stderr
    }),
    morayBucketName: 'pub_change_bucket',
    morayHost: '10.99.99.17',
    morayResolvers: {
        resolvers: ['10.99.99.11']
    },
    morayTimeout: 200,
    morayMinTimeout: 1000,
    morayMaxTimeout: 2000,
    morayPort: 2020,
    restifyServer: server,
    resources: resources
};

var publisher = new Publisher(options);

publisher.on('moray-ready', function () {
    var testChange = {
        changeKind: {
            resource: 'vm',
            subResources: ['nic']
        },
        changedResourceId: '',
        published: 'no'
    };

    var testChange2 = {
        changeKind: {
            resource: 'vm',
            subResources: ['alias']
        },
        changedResourceId: '',
        published: 'no'
    };

    var changes = process.argv[2];
    var changes2 = process.argv[3];
    for (var i = 0; i < changes; i++) {
        testChange.changedResourceId = libuuid.v4();
        publisher.publish(testChange, publishHandler);
    }
    for (var j = 0; j < changes2; j++) {
        testChange2.changedResourceId = libuuid.v4();
        publisher.publish(testChange2, publishHandler);
    }

    // setTimeout(function () {
    //     console.log('Publishing bonus round!');
    //     for (var i = 0; i < changes; i++) {
    //         testChange.changedResourceId = libuuid.v4();
    //         publisher.publish(testChange, publishHandler);
    //     }
    // }, 20000);

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

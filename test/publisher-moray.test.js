/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/* Test the publisher components */

var test = require('tape');
var mod_publisher = require('../lib/publisher');
var mod_bunyan = require('bunyan');
var mod_restify = require('restify');


var server = mod_restify.createServer();
var options = {
    log: mod_bunyan.createLogger({
        name: 'publisher_test',
        level: process.env['LOG_LEVEL'] || 'info',
        stream: process.stderr
    }),
    morayBucketName: 'z_change_bucket',
    morayHost: '10.99.99.17',
    morayResolvers: {
        resolvers: ['10.99.99.11']
    },
    morayTimeout: 200,
    morayMinTimeout: 1000,
    morayMaxTimeout: 2000,
    morayPort: 2020,
    restifyServer: server
};

test('test publisher moray operations', function (t) {
    t.plan(4);
    var testChange = {
        changeKind: {
            resource: 'vm',
            subResources: ['nic']
        },
        changedResourceId: '78615996-1a0e-40ca-974e-8b484774711a',
        published: 'no'
    };
    var publisher = new mod_publisher(options);

    t.ok(publisher, 'Publisher successfully created.');

    publisher.on('moray-ready', function () {
        t.ok(true, 'moray-ready');
        publisher.publish(testChange, function (err) {
            t.ok(err === null, 'published to bucket');
        });

        publisher.start();
        publisher.on('item-published', function () {
            t.ok(true, 'item published from bucket');
        });
        publisher.on('no-items', function () {
            t.ok(true, 'all items published');
            publisher.stop();
        });
    });
});

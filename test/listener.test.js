/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/* Test the listener components */


var test = require('tape');
var mod_bunyan = require('bunyan');
var mod_listener = require('../lib/listener');
var mod_spawn = require('child_process').spawn;

var options = {
    log: mod_bunyan.createLogger({
        name: 'listener_test',
        level: process.env['LOG_LEVEL'] || 'error',
        stream: process.stderr
    }),
    endpoint: '127.0.0.1',
    port: 8080,
    instance: 'uuid goes here',
    service: 'tcns',
    changeKind: {
        resource: 'vm',
        subResources: ['nic', 'alias']
    }
};
var options2 = {
    log: mod_bunyan.createLogger({
        name: 'listener_test2',
        level: process.env['LOG_LEVEL'] || 'error',
        stream: process.stderr
    }),
    endpoint: '127.0.0.1',
    port: 8080,
    instance: 'uuid goes here2',
    service: 'tcns2',
    changeKind: {
        resource: 'vm',
        subResources: ['nic']
    }
};

var serverKilled = false;

test('test listener creation', function (t) {
    t.plan(33);
    var server = mod_spawn('./test/helper/mock-publisher.js', ['10', '5']);
    var itemsProcessed = 0;
    var itemsProcessed2 = 0;
    server.stderr.once('data', function (data) {
        var listener = new mod_listener(options);
        var listener2 = new mod_listener(options2);

        t.equal(typeof (listener), 'object', 'listener is object');
        t.equal(typeof (listener2), 'object', 'listener2 is object');

        listener.register();
        listener2.register();

        listener.on('bootstrap', function () {
            // console.log('bootstrap');
            t.ok(true, 'listener bootstrap called');
        });
        listener2.on('bootstrap', function () {
            // console.log('bootstrap2');
            t.ok(true, 'listener2 bootstrap called');
        });

        listener.on('readable', function () {
            var changeItem = listener.read();
            t.equal(typeof (changeItem), 'object', 'changeItem is object');
            itemsProcessed++;
            // var processedItem1 = changeItem.changeKind;
            // console.log('listener resource:%j subResources:%j',
            //     processedItem1.resource,
            //     processedItem1.subResources);
            if (itemsProcessed === 14) {
                t.equal(itemsProcessed, 14, 'listener 15 changes');
            }
        });
        listener2.on('readable', function () {
            var changeItem = listener2.read();
            t.equal(typeof (changeItem), 'object', 'changeItem is object');
            itemsProcessed2++;
            // var processedItem2 = changeItem.changeKind;
            // console.log('listener2 resource:%j subResources:%j',
            //     processedItem2.resource,
            //     processedItem2.subResources);
            if (itemsProcessed2 === 9) {
                t.equal(itemsProcessed2, 9, 'listener2 10 changes');
            }
        });
        t.ok(listener, 'listener is truthy');
        t.ok(listener2, 'listener2 is truthy');
    });

    server.stderr.on('data', function (data) {
        // console.log('STDOUT: %s', data.toString());
    });

    server.stdout.on('data', function (data) {
        // Detect that the publisher has no items to publish and quit
        if (data.toString().indexOf('no-items') > -1) {
            // console.log('STDOUT: %s', data.toString());
            setTimeout(function () {
                server.kill('SIGHUP');
            }, 2000);
        }
        // console.log('STDOUT: ' + data.toString());
    });

    server.on('close', function (code) {
        // console.log('child process exited with code ' + code);
        t.end();
    });
});

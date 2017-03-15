/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/* Test the listener components */


var test = require('tape');
var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_listener = require('../lib/listener');
var mod_spawn = require('child_process').spawn;

var publisher_path = './test/helper/mock-publisher.js';

test('test listener creation', function (t) {
    t.plan(34);
    var primaryListenerOpts = {
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

    var secondaryListenerOpts = {
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

    var server = mod_spawn(process.execPath, [publisher_path, '10', '5']);
    var primaryItemsProcessed = 0;
    var secondaryItemsProcessed = 0;
    var primaryListener = new mod_listener(primaryListenerOpts);
    var secondaryListener = new mod_listener(secondaryListenerOpts);

    mod_assert.object(primaryListener, 'primaryListener');
    mod_assert.object(secondaryListener, 'secondaryListener');

    primaryListener.register();
    secondaryListener.register();

    primaryListener.on('bootstrap', function () {
        t.ok(true, 'primaryListener bootstrap called');
    });
    secondaryListener.on('bootstrap', function () {
        t.ok(true, 'secondaryListener bootstrap called');
    });

    primaryListener.on('readable', function () {
        var changeItem = primaryListener.read();
        t.equal(typeof (changeItem), 'object', 'primary change is object');
        primaryItemsProcessed++;
        if (primaryItemsProcessed === 15) {
            t.equal(primaryItemsProcessed, 15, 'primary handled 15');
        }
    });

    primaryListener.on('connection-end', function () {
        t.ok(true, 'got connection-end');
    });

    secondaryListener.on('readable', function () {
        var changeItem = secondaryListener.read();
        t.equal(typeof (changeItem), 'object', 'secondary change is object');
        secondaryItemsProcessed++;
        if (secondaryItemsProcessed === 10) {
            t.equal(secondaryItemsProcessed, 10, 'secondary handled 10');
        }
    });
    t.ok(primaryListener, 'primaryListener is truthy');
    t.ok(secondaryListener, 'secondaryListener is truthy');

    server.stdout.on('data', function (data) {
        // Detect that the publisher has no items to publish and quit
        if (data.toString().indexOf('no-items') > -1) {
            server.kill('SIGHUP');
        }
    });

    server.stderr.once('data', function (data) {
        t.ok(data.toString().indexOf('publisher_test') > -1, 'stderr');
    });

    server.on('exit', function () {
        t.ok(true, 'server exited');
        t.end();
    });

});

test('test listener backoff', function (t) {
    t.plan(6);
    var listenerOpts = {
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
        },
        backoff: {
            maxTimeout: 10000,
            minTimeout: 2000,
            retries: 2
        }
    };

    var bootstrap_count = 0;
    var failServer = mod_spawn(process.execPath, [publisher_path, '0', '0']);
    var fallbackServer;
    var listener = new mod_listener(listenerOpts);

    mod_assert.object(listener, 'listener');

    listener.on('bootstrap', function () {
        t.ok(true, 'listener bootstrap called');
        bootstrap_count++;

        if (bootstrap_count === 1) {
            failServer.kill('SIGHUP');
        }
    });

    listener.on('connection-end', function () {
        if (bootstrap_count === 1) {
            t.ok(true, 'got connection-end');
            fallbackServer = mod_spawn(process.execPath,
                [publisher_path, '1', '0']);
        }
    });

    listener.on('readable', function () {
        var change = listener.read();
        mod_assert.object(change, 'change');
        t.ok(true, 'readable');
        fallbackServer.kill('SIGHUP');
    });


    listener.on('error', function (error) {
        var backoffError = new Error('Backoff failed');
        t.deepEqual(error, backoffError, 'Backoff error');
        t.ok(true, 'Got error after backoff retries maxed out');
        t.end();
    });

    listener.register();
});

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

var MockPublisher = require('./helper/mock-publisher');

function testListener(t, mockPublisher, publisherAddressAndPort) {
    mod_assert.object(t, 't');
    mod_assert.object(mockPublisher, 'mockPublisher');
    mod_assert.object(publisherAddressAndPort, 'publisherAddressAndPort');
    mod_assert.string(publisherAddressAndPort.address,
        'publisherAddressAndPort.address');
    mod_assert.number(publisherAddressAndPort.port,
        'publisherAddressAndPort.port');

    t.plan(33);

    var primaryListenerOpts = {
        log: mod_bunyan.createLogger({
            name: 'listener_test',
            level: process.env['LOG_LEVEL'] || 'error',
            stream: process.stderr
        }),
        endpoint: publisherAddressAndPort.address,
        port: publisherAddressAndPort.port,
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
        endpoint: publisherAddressAndPort.address,
        port: publisherAddressAndPort.port,
        instance: 'uuid goes here2',
        service: 'tcns2',
        changeKind: {
            resource: 'vm',
            subResources: ['nic']
        }
    };

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

    primaryListener.on('readable', function onPrimaryReadable() {
        var changeItem = primaryListener.read();
        t.equal(typeof (changeItem), 'object', 'primary change is object');
        primaryItemsProcessed++;
        if (primaryItemsProcessed === 15) {
            t.equal(primaryItemsProcessed, 15, 'primary handled 15');
            primaryListener.removeListener('readable', onPrimaryReadable);
            primaryListener.close();
            if (secondaryItemsProcessed === 10) {
                mockPublisher.close();
            }
        }
    });

    primaryListener.on('connection-end', function () {
        t.equal(primaryItemsProcessed, 15,
            'connection ended after processing 15 events');
        t.ok(true, 'got connection-end');
    });

    secondaryListener.on('readable', function onSecondaryReadable() {
        var changeItem = secondaryListener.read();
        t.equal(typeof (changeItem), 'object', 'secondary change is object');
        secondaryItemsProcessed++;
        if (secondaryItemsProcessed === 10) {
            t.equal(secondaryItemsProcessed, 10, 'secondary handled 10');
            secondaryListener.removeListener('readable', onSecondaryReadable);
            secondaryListener.close();
            if (primaryItemsProcessed === 15) {
                mockPublisher.close();
            }
        }
    });

    t.ok(primaryListener, 'primaryListener is truthy');
    t.ok(secondaryListener, 'secondaryListener is truthy');

    mockPublisher.on('close', function onClosed() {
        t.end();
    });
}

function testListenerBackoff(t, mockPublisher, publisherAddressAndPort) {
    mod_assert.object(t, 't');
    mod_assert.object(mockPublisher, 'mockPublisher');
    mod_assert.object(publisherAddressAndPort, 'publisherAddressAndPort');
    mod_assert.string(publisherAddressAndPort.address,
        'publisherAddressAndPort.address');
    mod_assert.number(publisherAddressAndPort.port,
        'publisherAddressAndPort.port');

    t.plan(8);

    var listenerOpts = {
        log: mod_bunyan.createLogger({
            name: 'listener_test',
            level: process.env['LOG_LEVEL'] || 'error',
            stream: process.stderr
        }),
        endpoint: publisherAddressAndPort.address,
        port: publisherAddressAndPort.port,
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
    var listener = new mod_listener(listenerOpts);

    mod_assert.object(listener, 'listener');

    listener.on('bootstrap', function () {
        t.ok(true, 'listener bootstrap called');
        bootstrap_count++;

        console.log('bootstrap in test backoff, bootstrap count: %d',
            bootstrap_count);

        if (bootstrap_count === 1) {
            mockPublisher.closeClientConnections();
        }
    });

    listener.on('connection-end', function () {
        if (bootstrap_count === 1) {
            t.ok(true, 'got connection-end');
        }
    });

    listener.on('readable', function () {
        var change;

        change = listener.read();
        mod_assert.object(change, 'change');
        t.ok(true, 'readable');

        if (bootstrap_count === 2) {
            mockPublisher.close();
            listener.close();
            mockPublisher.closeClientConnections();
        }
    });


    listener.on('error', function (error) {
        var backoffError = new Error('Backoff failed');
        t.deepEqual(error, backoffError, 'Backoff error');
        t.ok(true, 'Got error after backoff retries maxed out');
        t.equal(bootstrap_count, 2,
            'Got error after bootstrapping succesfully twice');
        t.end();
    });

    listener.register();
}

test('test listener creation', function (t) {

    var mockPublisher = new MockPublisher({
        nbPrimaryChangesToPublish: 10,
        nbSecondaryChangesToPublish: 5
    });

    mockPublisher.start(function onStart(startErr, publisherHttpSrvInfo) {
        if (startErr) {
            t.ifError(startErr, 'mock publisher should start successfully');
            t.end();
        } else {
            testListener(t, mockPublisher, publisherHttpSrvInfo);
        }
    });
});

test('test listener backoff', function (t) {
    var mockPublisher = new MockPublisher({
        nbPrimaryChangesToPublish: 1,
        nbSecondaryChangesToPublish: 1
    });

    mockPublisher.start(function onStart(startErr, publisherHttpSrvInfo) {
        if (startErr) {
            t.ifError(startErr, 'mock publisher should start successfully');
            t.end();
        } else {
            testListenerBackoff(t, mockPublisher, publisherHttpSrvInfo);
        }
    });
});
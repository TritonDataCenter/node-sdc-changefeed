/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/* Test the publisher components */

var assert = require('assert-plus');
var MockPublisher = require('./helper/mock-publisher');
var mod_bunyan = require('bunyan');
var mod_http = require('http');
var mod_listener = require('../lib/listener');
var mod_util = require('util');
var mod_restify = require('restify');
var spawn = require('child_process').spawn;
var test = require('tape');
var util = require('util');
var Watershed = require('watershed').Watershed;

function testChangefeedList(t, publisherAddressAndPort, callback) {
    assert.object(t, 't');
    assert.object(publisherAddressAndPort, 'publisherAddressAndPort');
    assert.func(callback, 'callback');

    t.plan(6);

    var client = mod_restify.createJsonClient({
        url: util.format('http://%s:%d', publisherAddressAndPort.address,
            publisherAddressAndPort.port)
    });

    client.get('/changefeeds', function (err, req, res, obj) {
        var resources = [
            {
                resource: 'vm',
                subResources: ['nic', 'alias'],
                bootstrapRoute: '/vms'
            }
        ];
        var subResources = resources[0].subResources;
        var subLen = subResources.length;
        var bootstrapRoute = resources[0].bootstrapRoute;
        t.equal(obj.length, 1, '1 resource');
        t.equal(obj[0].resource, resources[0].resource, 'resource equal');
        t.equal(obj[0].subResources.length, subLen, 'subResources length');
        t.equal(obj[0].subResources[0], subResources[0], 'subResources[0]');
        t.equal(obj[0].subResources[1], subResources[1], 'subResources[1]');
        t.equal(obj[0].bootstrapRoute, bootstrapRoute, 'bootstrap');

        client.close();

        callback();
    });
}

function testChangefeedStats(t, publisherAddressAndPort, callback) {
    assert.object(t, 't');
    assert.object(publisherAddressAndPort, 'publisherAddressAndPort');
    assert.func(callback, 'callback');

    t.plan(3);
    var client = mod_restify.createJsonClient({
        url: util.format('http://%s:%d', publisherAddressAndPort.address,
            publisherAddressAndPort.port)
    });

    client.get('/changefeeds/stats', function (err, req, res, obj) {
        t.ifErr(err, 'getting changefeed stats should not error');
        t.equal(obj.listeners, 0, 'listener count 0');
        t.equal(Object.keys(obj.registrations).length, 0, 'registrations');

        client.close();

        process.nextTick(callback);
    });
}

function testChangefeedStatsWithListener(t, mockPublisher,
    publisherAddressAndPort, callback) {
    assert.object(t, 't');
    assert.object(mockPublisher, 'mockPublisher');
    assert.object(publisherAddressAndPort, 'publisherAddressAndPort');
    assert.func(callback, 'callback');

    t.plan(3);

    var client = mod_restify.createJsonClient({
        url: util.format('http://%s:%d', publisherAddressAndPort.address,
            publisherAddressAndPort.port)
    });

    var options = {
        log: new mod_bunyan({
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
    var options2 = {
        log: new mod_bunyan({
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

    var listener = new mod_listener(options);
    var listener2 = new mod_listener(options2);

    listener.register();
    listener.on('bootstrap', function () {
        listener2.register();
        listener2.on('bootstrap', function () {
            var statsPath = '/changefeeds/stats';
            client.get(statsPath, function (err, req, res, obj) {
                var regCount = Object.keys(obj.registrations).length;

                client.close();

                t.ifErr(err, 'getting changefeed stats should not error');
                t.equal(obj.listeners, 2, 'listener count 2');
                t.equal(regCount, 2, 'length 2');

                listener.close();
                listener2.close();

                callback();
            });
        });
    });
}

function testChangefeedStatsWithListenerAfterRemoval(t, mockPublisher,
    publisherAddressAndPort, callback) {
    assert.object(t, 't');
    assert.object(mockPublisher, 'mockPublisher');
    assert.object(publisherAddressAndPort, 'publisherAddressAndPort');
    assert.func(callback, 'callback');

    var client = mod_restify.createJsonClient({
        url: util.format('http://%s:%d', publisherAddressAndPort.address,
            publisherAddressAndPort.port)
    });

    t.plan(7);

    var options = {
        log: new mod_bunyan({
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
    var options2 = {
        log: new mod_bunyan({
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

    var listener = new mod_listener(options);
    var listener2 = new mod_listener(options2);
    var statsPath = '/changefeeds/stats';

    listener.register();
    listener.on('bootstrap', function () {
        listener2.register();
        listener2.on('bootstrap', function () {
            client.get(statsPath, function (err, req, res, obj) {
                var regCount = Object.keys(obj.registrations).length;
                t.ifErr(err, 'getting changefeed stats should not error');
                t.equal(obj.listeners, 2, 'listener count 2');
                t.equal(regCount, 2, 'length 2');

                listener.close();
            });
        });
    });

    listener.on('connection-end', function () {
        client.get(statsPath, function (err, req, res, obj) {
            var regCount = Object.keys(obj.registrations).length;
            t.equal(obj.listeners, 1, 'listener count 1');
            t.equal(regCount, 1, 'length 1');

            listener2.close();
        });
    });

    listener2.on('connection-end', function () {
        client.get(statsPath, function (err, req, res, obj) {
            var regCount = Object.keys(obj.registrations).length;
            t.equal(obj.listeners, 0, 'listener count 0');
            t.equal(regCount, 0, 'length 0');

            client.close();

            callback();
        });
    });
}

function startMockPublisher(t, mockPublisherOpts, callback) {
    assert.object(t, 't');
    assert.object(mockPublisherOpts, 'mockPublisherOpts');
    assert.func(callback, 'callback');

    var mockPublisher = new MockPublisher(mockPublisherOpts);

    mockPublisher.start(function onStart(startErr, publisherHttpSrvInfo) {
        if (startErr) {
            t.ifErr(startErr, 'mock publisher should start successfully');
            t.end();
        } else {
            callback(mockPublisher, publisherHttpSrvInfo);
        }
    });
}

test('test publisher change feed list', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0
    }, function onMockPublisherStarted(mockPublisher, serverAddressAndPort) {
        testChangefeedList(t, serverAddressAndPort, function onTestDone() {
            mockPublisher.on('close', function onServerExited() {
                t.end();
            });

            mockPublisher.close();
        });
    });
});

test('test publisher change feed list when server routes mounted after ' +
    'creation', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0,
        nbMountSrvRoutesAfterCreate: 1
    }, function onMockPublisherStarted(mockPublisher, serverAddressAndPort) {
        testChangefeedList(t, serverAddressAndPort, function onTestDone() {
            mockPublisher.on('close', function onServerExited() {
                t.end();
            });

            mockPublisher.close();
        });
    });
});

test('test publisher change feed list when server routes mounted twice after ' +
    'creation', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0,
        nbMountSrvRoutesAfterCreate: 2
    }, function onMockPublisherStarted(mockPublisher, serverAddressAndPort) {
        testChangefeedList(t, serverAddressAndPort, function onTestDone() {
            mockPublisher.on('close', function onServerExited() {
                t.end();
            });

            mockPublisher.close();
        });
    });
});

test('test publisher change feed stats with no listeners', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0
    }, function onMockPublisherStarted(mockPublisher, serverAddressAndPort) {
        testChangefeedStats(t, serverAddressAndPort, function onTestDone() {
            mockPublisher.on('close', function onServerExited() {
                t.end();
            });

            mockPublisher.close();
        });
    });
});

test('test publisher change feed stats with no listeners and srv routes ' +
    'mounted after creation', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0,
        nbMountSrvRoutesAfterCreate: 1
    }, function onMockPublisherStarted(mockPublisher, serverAddressAndPort) {
        testChangefeedStats(t, serverAddressAndPort, function onTestDone() {
            mockPublisher.on('close', function onServerExited() {
                t.end();
            });

            mockPublisher.close();
        });
    });
});

test('test publisher change feed stats with listeners', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0
    }, function onMockPublisherStarted(mockPublisher, publisherAddressAndPort) {
        testChangefeedStatsWithListener(t, mockPublisher,
            publisherAddressAndPort, function onTestDone() {
            mockPublisher.on('close', function onPublisherExited() {
                t.end();
            });

            mockPublisher.close();
        });
    });
});

test('test publisher change feed stats with listeners and srv routes mounted ' +
    'after creation', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0,
        nbMountSrvRoutesAfterCreate: 1
    }, function onMockPublisherStarted(mockPublisher, publisherAddressAndPort) {
        testChangefeedStatsWithListener(t, mockPublisher,
            publisherAddressAndPort, function onTestDone() {
                mockPublisher.on('close', function onPublisherExited() {
                    t.end();
                });

                mockPublisher.close();
            });
    });
});

test('test publisher change feed stats after removal', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0
    }, function onMockPublisherStarted(mockPublisher, publisherAddressAndPort) {
        testChangefeedStatsWithListenerAfterRemoval(t, mockPublisher,
            publisherAddressAndPort, function onTestDone() {
                mockPublisher.on('close', function onPublisherExited() {
                    t.end();
                });

                mockPublisher.close();
            });
    });
});

test('test publisher change feed stats after removal and srv routes mounted ' +
    'after creation', function (t) {
    startMockPublisher(t, {
        nbPrimaryChangesToPublish: 0,
        nbSecondaryChangesToPublish: 0,
        nbMountSrvRoutesAfterCreate: 1
    }, function onMockPublisherStarted(mockPublisher, publisherAddressAndPort) {
        testChangefeedStatsWithListenerAfterRemoval(t, mockPublisher,
            publisherAddressAndPort, function onTestDone() {
                mockPublisher.on('close', function onPublisherExited() {
                    t.end();
                });

                mockPublisher.close();
            });
    });
});
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/* Test the publisher components */

var test = require('tape');
var spawn = require('child_process').spawn;
var mod_restify = require('restify');
var Watershed = require('watershed').Watershed;
var mod_http = require('http');
var mod_bunyan = require('bunyan');
var mod_listener = require('../lib/listener');
var mod_util = require('util');

test('test publisher change feed list', function (t) {
    t.plan(6);
    var server = spawn(process.execPath,
        ['./test/helper/mock-publisher.js', '0', '0']);
    var client = mod_restify.createJsonClient({
        url: 'http://localhost:8080'
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
        server.kill('SIGHUP');
        t.end();
    });
});

test('test publisher change feed stats with no listeners', function (t) {
    t.plan(2);
    var server = spawn(process.execPath,
        ['./test/helper/mock-publisher.js', '0', '0']);
    var client = mod_restify.createJsonClient({
        url: 'http://localhost:8080'
    });

    client.get('/changefeeds/stats', function (err, req, res, obj) {
        t.equal(obj.listeners, 0, 'listener count 0');
        t.equal(Object.keys(obj.registrations).length, 0, 'registrations');
        process.nextTick(function () {
            server.kill('SIGHUP');
            t.end();
        });
    });
});

test('test publisher change feed stats with listeners', function (t) {
    t.plan(2);
    var publisher = spawn(process.execPath,
        ['./test/helper/mock-publisher.js', '0', '0']);
    var client = mod_restify.createJsonClient({
        url: 'http://localhost:8080'
    });

    publisher.stderr.once('data', function (data) {
        console.log('publisher ready...');
        var options = {
            log: new mod_bunyan({
                name: 'listener_test',
                level: process.env['LOG_LEVEL'] || 'trace',
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
            log: new mod_bunyan({
                name: 'listener_test2',
                level: process.env['LOG_LEVEL'] || 'info',
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

        var listener = new mod_listener(options);
        var listener2 = new mod_listener(options2);

        listener.register();
        listener.on('bootstrap', function () {
            listener2.register();
            listener2.on('bootstrap', function () {
                var statsPath = '/changefeeds/stats';
                client.get(statsPath, function (err, req, res, obj) {
                    var regCount = Object.keys(obj.registrations).length;
                    t.equal(obj.listeners, 2, 'listener count 2');
                    t.equal(regCount, 2, 'length 2');
                    publisher.kill('SIGHUP');
                });
            });
        });
    });

    publisher.on('close', function (code) {
        // console.log('child process exited with code ' + code);
        t.end();
    });
});

test('test publisher change feed stats after removal', function (t) {
    t.plan(6);
    var publisher = spawn(process.execPath,
        ['./test/helper/mock-publisher.js', '0', '0']);
    var client = mod_restify.createJsonClient({
        url: 'http://localhost:8080'
    });

    publisher.stderr.once('data', function (data) {
        console.log('publisher ready...');
        var options = {
            log: new mod_bunyan({
                name: 'listener_test',
                level: process.env['LOG_LEVEL'] || 'trace',
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
            log: new mod_bunyan({
                name: 'listener_test2',
                level: process.env['LOG_LEVEL'] || 'info',
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

        var listener = new mod_listener(options);
        var listener2 = new mod_listener(options2);
        var statsPath = '/changefeeds/stats';

        listener.register();
        listener.on('bootstrap', function () {
            listener2.register();
            listener2.on('bootstrap', function () {
                client.get(statsPath, function (err, req, res, obj) {
                    var regCount = Object.keys(obj.registrations).length;
                    t.equal(obj.listeners, 2, 'listener count 2');
                    t.equal(regCount, 2, 'length 2');
                    setTimeout(function () {
                        listener._endSocket();
                        listener2._endSocket();
                    }, 1000);
                });
            });
        });

        listener.on('connection-end', function () {
            client.get(statsPath, function (err, req, res, obj) {
                var regCount = Object.keys(obj.registrations).length;
                t.equal(obj.listeners, 1, 'listener count 1');
                t.equal(regCount, 1, 'length 1');
            });
        });

        listener2.on('connection-end', function () {
            client.get(statsPath, function (err, req, res, obj) {
                var regCount = Object.keys(obj.registrations).length;
                t.equal(obj.listeners, 0, 'listener count 0');
                t.equal(regCount, 0, 'length 0');
                setTimeout(function () {
                    publisher.kill('SIGHUP');
                }, 1000);
            });
        });
    });

    publisher.on('close', function (code) {
        // console.log('child process exited with code ' + code);
        t.end();
    });
});

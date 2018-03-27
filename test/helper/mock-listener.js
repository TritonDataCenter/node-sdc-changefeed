/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/* Test the listener components */


var mod_bunyan = require('bunyan');
var mod_listener = require('../../lib/listener');

var options = {
    log: mod_bunyan.createLogger({
        name: 'listener_test',
        level: process.env['LOG_LEVEL'] || 'info',
        stream: process.stderr
    }),
    endpoint: '127.0.0.1',
    instance: 'uuid goes here',
    service: 'tcns',
    changeKind: {
        resource: 'vm',
        subResources: ['nic', 'alias']
    },
    zk: {
        servers: [ { address: '192.168.9.6', port: 2181 } ],
        sessionTimeout: 10000
    }
};
var options2 = {
    log: mod_bunyan.createLogger({
        name: 'listener_test2',
        level: process.env['LOG_LEVEL'] || 'info',
        stream: process.stderr
    }),
    endpoint: '127.0.0.1',
    instance: 'uuid goes here2',
    service: 'tcns2',
    changeKind: {
        resource: 'vm',
        subResources: ['nic']
    },
    zk: {
        servers: [ { address: '192.168.9.6', port: 2181 } ],
        sessionTimeout: 10000
    }
};

var listener = new mod_listener(options);
var listener2 = new mod_listener(options2);
listener.register();
listener2.register();

listener.on('bootstrap', function () {
    console.log('bootstrap');
});
listener2.on('bootstrap', function () {
    console.log('bootstrap2');
});

listener.on('readable', function () {
    console.log('listener readable');
});
listener2.on('readable', function () {
    console.log('listener2 readable');
});

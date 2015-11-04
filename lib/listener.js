/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var mod_assert = require('assert');
var mod_assertplus = require('assert');
var mod_bunyan = require('bunyan');
var mod_http = require('http');
var mod_util = require('util');
var Readable = require('stream').Readable;
var Watershed = require('watershed').Watershed;

var shed = new Watershed();

/*
 * Listener module constructor that takes an options object.
 *
 * Example options object:
 * var options = {
 *   log: new mod_bunyan({
 *       name: 'my_logger',
 *       level: 'info',
 *       stream: process.stderr
 *   }),
 *   endpoint: '127.0.0.1',
 *   port: 80,
 *   instance: '<UUID>',
 *   service: '<service name>',
 *   changeKind: {
 *       resource: '<resource name>',
 *       subResources: ['subresource1', 'subresource2']
 *   }
 * };
 */
function Listener(options) {
    var self = this;

    Readable.call(self, { objectMode: true });

    self.log = options.log;
    self.endpoint = options.endpoint;
    self.publisherPort = options.port;
    self.instance = options.instance;
    self.service = options.service;
    self.changeKind = options.changeKind;

    self.initBootstrap = true;
}

mod_util.inherits(Listener, Readable);

/*
 * Registers the listener with publisher endpoint specified in options.
 * Once registered, this method also handles pushing stream data to the consumer
 * of the Listener object.
 */
Listener.prototype.register = function register() {
    var self = this;
    var registration = {
        instance: self.instance,
        service: self.service,
        changeKind: self.changeKind
    };
    var wskey = shed.generateKey();
    var options = {
        port: self.publisherPort,
        hostname: self.endpoint,
        headers: {
            'connection': 'upgrade',
            'upgrade': 'websocket',
            'Sec-WebSocket-Key': wskey
        }
    };
    var req = mod_http.request(options);
    req.end();
    req.on('upgrade', function _upgrade(res, socket, head) {
        var wsc = self.wsc = shed.connect(res, socket, head, wskey);

        // Send registration
        try {
            wsc.send(JSON.stringify(registration));
        } catch (ex) {
            self.log.error('ex: %s', ex.message);
        }

        wsc.on('end', function _end() {
            self.emit('connection-end');
            self.log.info('websocket ended');
        });

        wsc.on('connectionReset', function _connectionReset() {
            self.emit('connection-end');
            self.log.info('websocket ended');
        });

        // Handles publisher change feed items and bootstrap response.
        // The only valid response from the publisher when the listener is in
        // the initBootstrap state, is a bootstrap object. From that point
        // forward it is expected that all items are change feed items.
        wsc.on('text', function _recieveRegistration(text) {
            var item = JSON.parse(text);
            if (self.initBootstrap && item.hasOwnProperty('bootstrapRoute')) {
                self.initBootstrap = false;
                self.emit('bootstrap', item);
            } else if (!self.initBootstrap) {
                self.push(item);
            } else {
                self.log.error(
                    'Invalid socket state! text: %s initBootstrap: %s',
                    text,
                    self.initBootstrap);
                self.emit('error');
            }
        });
    });
};

Listener.prototype._read = function _read() {
    // This function is required, but I'm not sure we should do anything
};

Listener.prototype._endSocket = function _endSocket() {
    this.wsc.end();
};

module.exports = Listener;

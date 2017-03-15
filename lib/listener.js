/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_backoff = require('backoff');
var mod_bunyan = require('bunyan');
var mod_restify = require('restify-clients');
var mod_util = require('util');
var Readable = require('stream').Readable;
var sprintf = require('sprintf-js').sprintf;
var Watershed = require('watershed').Watershed;

var shed = new Watershed();
var pollInterval = 27817;
var attempt = 0;
var HTTP_MODIFIER = 'http://%s';
var PORT_MODIFIER = ':%s';
var ROOT_PATH = '/changefeeds';

/*
 * Listener module constructor that takes an options object.
 *
 * Example options object:
 * var options = {
 *   backoff: {
 *       maxTimeout: Infinity,
 *       minTimeout: 10,
 *       retries: Infinity
 *   },
 *   log: new mod_bunyan({
 *       name: 'my_logger',
 *       level: 'info',
 *       stream: process.stderr
 *   }),
 *   url: 'http://127.0.0.1',
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

    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.string(options.instance, 'options.instance');
    mod_assert.string(options.service, 'options.service');
    mod_assert.object(options.changeKind, 'options.changeKind');
    mod_assert.string(
        options.changeKind.resource,
        'options.changeKind.resource');
    mod_assert.arrayOfString(
        options.changeKind.subResources,
        'options.changeKind.subResources');

    Readable.call(self, { objectMode: true });

    // retain backwards compatibility w/ non restify-clients listeners
    if (options.endpoint && options.port) {
        self.url = sprintf(HTTP_MODIFIER, options.endpoint);
        if (options.port !== 80) {
            self.url += sprintf(PORT_MODIFIER, options.port);
        }
    } else {
        mod_assert.string(options.url, 'options.url');
        self.url = options.url;
    }


    self.log = options.log;
    self.instance = options.instance;
    self.service = options.service;
    self.changeKind = options.changeKind;
    self.backoff_opts = options.backoff;

    self.initBootstrap = false;
}

mod_util.inherits(Listener, Readable);

/*
 * Registers the listener with publisher endpoint specified in options.
 * Once registered, this method also handles pushing stream data to the consumer
 * of the Listener object.
 */
Listener.prototype.register = function register() {
    var self = this;
    var log = self.log;
    var registration = {
        instance: self.instance,
        service: self.service,
        changeKind: self.changeKind
    };
    log.info({ cfRegistration: registration }, 'register: start');
    var wskey = shed.generateKey();

    var clientOpts = {
        log: log,
        url: self.url,
        retry: self.backoff_opts
    };

    var upgradeOpts = {
        path: ROOT_PATH,
        headers: {
            'connection': 'upgrade',
            'upgrade': 'websocket',
            'Sec-WebSocket-Key': wskey
        }
    };

    var client = self.client = mod_restify.createClient(clientOpts);

    var expBackoff_opts = self.backoff_opts ? {
            initialDelay: self.backoff_opts.minTimeout,
            maxDelay: self.maxTimeout
        } : null;
    var expBackoff = mod_backoff.exponential(expBackoff_opts);
    if (self.backoff_opts) {
        log.info('cf: backoff enabled');
        expBackoff.failAfter(self.backoff_opts.retries);
    }

    function _upgrade() {
        log.info('cf: _upgrade');
        client.get(upgradeOpts, function _getUpgrade(err, res, socket, head) {
            log.info('cf: _getUpgrade');
            if (err) {
                log.error('err: %j', err);
                self.emit('error', err);
            }

            res.once('upgradeResult', function _ur(err2, res2, socket2, head2) {
                log.info('cf: _ur');
                var wsc = self.wsc = shed.connect(res2, socket2, head2, wskey);

                // Send registration
                try {
                    wsc.send(JSON.stringify(registration));
                } catch (ex) {
                    log.error('ex: %s', ex.message);
                    self.emit('error', new Error(ex.message));
                }

                var heartbeat = setInterval(function _poll() {
                    log.debug('cf: _poll: start');
                    wsc.send('heartbeat');
                }, pollInterval);

                wsc.on('end', function _end() {
                    log.debug('cf: _end: start');
                    self.emit('connection-end');
                    clearInterval(heartbeat);
                    if (self.backoff_opts) {
                        log.warn('cf: websocket end event, calling backoff');
                        expBackoff.backoff();
                    }
                });

                wsc.on('connectionReset', function _connectionReset() {
                    log.debug('cf: _connectionReset: start');
                    self.emit('connection-reset');
                    clearInterval(heartbeat);
                });

                // Handles publisher change feed items and bootstrap response.
                // The only valid response from the publisher when the listener
                // is in the initBootstrap state, is a bootstrap object. From
                // that point forward it is expected that all items are change
                // feed items
                wsc.on('text', function _receivedText(text) {
                    log.trace(
                        { cfText: text },
                        'cf: _receivedText: start');
                    var item = JSON.parse(text);
                    var isBootstrap = item.hasOwnProperty('bootstrapRoute');
                    if (self.initBootstrap && isBootstrap) {
                        log.info('cf: bootstrap');
                        self.initBootstrap = false;
                        self.emit('bootstrap', item);
                        expBackoff.reset();
                        log.info('cf: expBackoff reset');
                    } else if (!self.initBootstrap && !isBootstrap) {
                        log.trace({ cfItem: item }, 'cf: change item received');
                        self.push(item);
                    } else {
                        log.error(
                            'Invalid socket state! text: %s initBootstrap: %s',
                            text,
                            self.initBootstrap);
                        self.emit('error', new Error('Invalid socket state'));
                    }
                });
            });
        });

    }

    function _init() {
        log.debug('cf: _init');
        client.get(ROOT_PATH, function _test(err, res, socket, head) {
            log.debug('cf: _test');
            res.on('result', function _result(err2, res2) {
                log.debug('cf: _result');
                if (err2) {
                    log.error('cf: Error testing for compatibility.');
                    expBackoff.backoff();
                } else {
                    self.initBootstrap = true;
                    _upgrade();
                }
            });
        });
    }

    client.on('attempt', function _attempt() {
        attempt = attempt + 1;
        log.warn('cf: restify backoff attempt: %s', attempt);
    });

    expBackoff.on('backoff', function _backoff(number, delay) {
        log.warn('cf: Backoff retry count: %s delay: %s', number, delay);
    });
    expBackoff.on('fail', function _fail() {
        log.error('cf: Backoff failed.');
        self.emit('error', new Error('Backoff failed'));
    });
    expBackoff.on('ready', function _ready(number, delay) {
        log.info('cf: _ready');
        _init();
    });

    _init();
};

Listener.prototype._read = function _read() {
    this.log.trace('cf: _read: start');
    // This function is required, but the push logic is handled in register.
};

Listener.prototype.close =
Listener.prototype._endSocket = function _endSocket() {
    this.log.trace('cf: _endSocket: start');
    if (this.wsc) {
        this.wsc.end();
    }

    if (this.client) {
        this.client.close();
    }
};

module.exports = Listener;

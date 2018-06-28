/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_backoff = require('backoff');
var mod_restify = require('restify-clients');
var mod_util = require('util');
var Readable = require('stream').Readable;
var sprintf = require('sprintf-js').sprintf;
var VError = require('verror');
var Watershed = require('watershed').Watershed;

var shed = new Watershed();
var pollInterval = 27817;
var HTTP_MODIFIER = 'http://%s';
var PORT_MODIFIER = ':%s';
var ROOT_PATH = '/changefeeds';

var CF_ROUTE_V1 = '~1';
var CF_ROUTE_V2 = '~2';

function assertResource(resource, i) {
    var name = 'options.resources[' + i + ']';

    mod_assert.object(resource, name);
    mod_assert.string(resource.resource, name + '.resource');
    mod_assert.arrayOfString(resource.subResources, name + '.subResources');
}

function assertListenerOptions(options) {
    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.string(options.instance, 'options.instance');
    mod_assert.string(options.service, 'options.service');
    mod_assert.optionalObject(options.backoff, 'options.backoff');
    if (options.resources) {
        mod_assert.array(options.resources, 'options.resources');
        mod_assert.ok(options.resources.length > 0,
            'options.resources.length > 0');
        options.resources.forEach(assertResource);
        mod_assert.equal(options.changeKind, undefined, 'options.changeKind');
    } else {
        mod_assert.object(options.changeKind, 'options.changeKind');
        mod_assert.string(options.changeKind.resource,
            'options.changeKind.resource');
        mod_assert.arrayOfString(options.changeKind.subResources,
            'options.changeKind.subResources');
        mod_assert.equal(options.resources, undefined, 'options.resources');
    }
}

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
    assertListenerOptions(options);
    var self = this;


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

    if (options.resources) {
        self.resources = options.resources;
    } else {
        self.resources = [
            {
                resource: options.changeKind.resource,
                subResources: options.changeKind.subResources
            }
        ];
    }

    self.log = options.log;
    self.instance = options.instance;
    self.service = options.service;
    self.backoff_opts = options.backoff;

    self.closed = false;
    self.initBootstrap = false;
}
mod_util.inherits(Listener, Readable);

/*
 * Perform a V1-style registration against the server.
 */
Listener.prototype._registerV1 = function registerV1() {
    var self = this;
    var log = self.log;

    return {
        registration: {
            instance: self.instance,
            service: self.service,
            changeKind: self.resources[0]
        },
        client: {
            log: log,
            url: self.url,
            version: CF_ROUTE_V1,
            agent: false,
            retry: false
        },
        onBootstrap: function onBootstrapV1(text, expBackoff) {
            var item;

            log.trace({
                cfText: text
            }, 'cf: _receivedText: start');

            try {
                item = JSON.parse(text);
                mod_assert.object(item, 'item');
            } catch (e) {
                log.error(e, 'cf: bad bootstrap message');
                self.emit('error', new VError(e, 'invalid bootstrap'));
                return;
            }

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
                log.error({
                    text: text,
                    initBootstrap: self.initBootstrap
                }, 'Invalid socket state!');

                self.emit('error', new Error('Invalid socket state'));
            }
        }
    };
};

/*
 * Perform a V2-style registration against the server.
 */
Listener.prototype._registerV2 = function registerV2() {
    var self = this;
    var log = self.log;

    return {
        registration: {
            instance: self.instance,
            service: self.service,
            resources: self.resources
        },
        client: {
            log: log,
            url: self.url,
            version: CF_ROUTE_V2,
            agent: false,
            retry: false
        },
        onBootstrap: function onBootstrapV2(text, expBackoff) {
            var item;

            log.trace({
                cfText: text
            }, 'cf: _receivedText: start');

            try {
                item = JSON.parse(text);
                mod_assert.object(item, 'item');
            } catch (e) {
                log.error(e, 'cf: bad bootstrap message');
                self.emit('error', new VError(e, 'invalid bootstrap'));
                return;
            }

            var isBootstrap = item.hasOwnProperty('bootstrapRoutes');

            if (self.initBootstrap && isBootstrap) {
                log.info('cf: bootstrap');
                self.initBootstrap = false;
                item.bootstrapRoutes.forEach(function (bs) {
                    self.emit('bootstrap', bs);
                });
                expBackoff.reset();
                log.info('cf: expBackoff reset');
            } else if (!self.initBootstrap && !isBootstrap) {
                log.trace({ cfItem: item }, 'cf: change item received');
                self.push(item);
            } else {
                log.error({
                    text: text,
                    initBootstrap: self.initBootstrap
                }, 'Invalid socket state!');

                self.emit('error', new Error('Invalid socket state'));
            }
        }
    };
};

/*
 * Registers the listener with publisher endpoint specified in options. Once
 * registered, this method also handles pushing stream data to the consumer of
 * the Listener object.
 */
Listener.prototype.register = function register() {
    var self = this;
    var log = self.log;
    var wskey = shed.generateKey();

    var regOpts = (self.resources.length === 1)
        ? self._registerV1()
        : self._registerV2();

    log.info({ regstration: regOpts }, 'register: start');

    var upgradeOpts = {
        path: ROOT_PATH,
        headers: {
            'connection': 'upgrade',
            'upgrade': 'websocket',
            'Sec-WebSocket-Key': wskey,
            'Sec-WebSocket-Version': '13'
        }
    };

    var client = self.client = mod_restify.createClient(regOpts.client);

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
                expBackoff.backoff();
                return;
            }

            res.once('upgradeResult', function _ur(err2, res2, socket2, head2) {
                log.info('cf: _ur');
                var wsc = self.wsc = shed.connect(res2, socket2, head2, wskey);

                // Send registration
                try {
                    wsc.send(JSON.stringify(regOpts.registration));
                } catch (ex) {
                    log.error(ex, 'failed to send registration');
                    self.emit('error', new VError(ex, 'failed to register'));
                    expBackoff.backoff();
                    return;
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
                wsc.on('text', function (text) {
                    regOpts.onBootstrap(text, expBackoff);
                });
            });
        });
    }

    function _init() {
        log.debug('cf: _init');
        client.get(ROOT_PATH, function _test(err, res, socket, head) {
            if (err) {
                log.warn(err, 'cf: _test: error');
                expBackoff.backoff();
                return;
            }

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

    expBackoff.on('backoff', function _backoff(number, delay) {
        log.debug('cf: Backoff retry count: %s delay: %s', number, delay);
    });
    expBackoff.on('fail', function _fail() {
        log.error('cf: Backoff failed.');
        self.emit('error', new Error('Backoff failed'));
    });
    expBackoff.on('ready', function _ready(number, delay) {
        if (self.closed) {
            log.info('cf: _ready: listener closed, resetting');
            expBackoff.reset();
            return;
        }

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

    this.closed = true;
};

module.exports = Listener;

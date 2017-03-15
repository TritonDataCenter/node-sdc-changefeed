/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var mod_assert = require('assert-plus');
var mod_backoff = require('backoff');
var mod_bunyan = require('bunyan');
var mod_libuuid = require('libuuid');
var mod_moray = require('moray');
var mod_util = require('util');
var mod_vasync = require('vasync');
var Watershed = require('watershed').Watershed;

var shed = new Watershed();
var pollTime = 2000; // Poll moray bucket every 2 seconds
var gcPollTime = 6361; // Prime number chosen to alleviate overlap with pollTime

/*
 * Publisher module constructor that takes an options object.
 *
 * Example options object:
 * var options = {
 *    backoff: {
 *       maxTimeout: Infinity,
 *       minTimeout: 10,
 *       retries: Infinity
 *    },
 *    log: new Bunyan({
 *       name: 'publisher_test',
 *       level: process.env['LOG_LEVEL'] || 'trace',
 *       stream: process.stderr
 *    }),
 *   maxAge: 28800,
 *   moray: {
 *       bucketName: 'change_feed_bucket',
 *       host: '10.99.99.17',
 *       resolvers: {
 *           resolvers: ['10.99.99.11']
 *       },
 *       timeout: 200,
 *       minTimeout: 1000,
 *       maxTimeout: 2000,
 *       port: 2020
 *   },
 *   restifyServer: server,
 *   resources: resources
 * };
 */
function Publisher(options) {
    var self = this;
    self.pollInterval = null;
    self.gcPollInterval = null;
    EventEmitter.call(self);

    // registrations and websockets track listener details, and are used for GC.
    self.registrations = {};
    self.websockets = {};

    // Users specify maxAge in seconds, but it is easier to work with
    // milliseconds from here on out. We need to also make sure this number is
    // safe for JavaScript.
    self.maxAge = options.maxAge * 1000;

    if (options.backoff) {
        self.minTimeout = options.backoff.minTimeout || 10;
        self.maxTimeout = options.backoff.maxTimeout || Infinity;
        self.retries = options.backoff.retries || Infinity;
    } else {
        self.minTimeout = 10;
        self.maxTimeout = Infinity;
        self.retries = Infinity;
    }

    var morayOptions = options.moray;
    self.morayHost = morayOptions.host;
    self.morayResovlers = morayOptions.resolvers;
    self.morayTimeout = morayOptions.timeout;
    self.morayMinTimeout = morayOptions.minTimeout;
    self.morayMaxTimeout = morayOptions.maxTimeout;
    self.morayPort = morayOptions.port;
    self.morayBucket = {
        name: morayOptions.bucketName,
        config: {
            index: {
                published: { type: 'string' }
            }
        }
    };

    self.resources = options.resources;

    var log = this.log = options.log;
    var morayClient = this.morayClient = mod_moray.createClient({
        dns: this.morayResolvers,
        connectTimeout: this.morayTimeout || 200,
        log: this.log,
        host: this.morayHost,
        port: this.morayPort,
        reconnect: false,
        retry: {
            retries: Infinity,
            minTimeout: this.morayMinTimeout || 1000,
            maxTimeout: this.morayMaxTimeout || 16000
        }
    });

    var expBackoff = mod_backoff.exponential({
        initialDelay: self.minTimeout,
        maxDelay: self.maxTimeout
    });

    expBackoff.failAfter(self.retries);

    morayClient.on('connect', function _morayConnect() {
        log.trace('cf: _morayConnect: started');
        log.info({ moray: morayClient.toString() }, 'cf: moray: connected');
        self.emit('moray-connected');

        // Handles bucket initilization and backoff on failure
        function _bucketInit() {
            morayClient.getBucket(self.morayBucket.name, function _gb(err) {
                if (err && err.name === 'BucketNotFoundError') {
                    var name = self.morayBucket.name;
                    var config = self.morayBucket.config;
                    morayClient.createBucket(name, config, function _cb(err2) {
                        log.info({ n: name, c: config }, 'cf: creating bucket');
                        if (err2) {
                            log.error({ cErr: err2 }, 'cf: Bucket not created');
                            expBackoff.backoff();
                        } else {
                            log.info('cf: Bucket successfully setup');
                            self.emit('moray-ready');
                            expBackoff.reset();
                        }
                    });
                } else if (err) {
                    log.error({ cErr: err }, 'cf: Bucket was not loaded');
                    expBackoff.backoff();
                } else {
                    log.info('cf: Bucket successfully setup');
                    self.emit('moray-ready');
                    expBackoff.reset();
                }
            });
        }

        morayClient.on('error', function _morayError(err) {
            log.error(err, 'cf: moray client error');
        });

        expBackoff.on('backoff', function _backoff(number, delay) {
            log.warn('cf: Backoff -- retry count: %s delay: %s', number, delay);
        });

        expBackoff.on('ready', function _ready(number, delay) {
            log.info('cf: Backoff ready -- retry count: %s:', number);
            _bucketInit();
        });

        expBackoff.on('fail', function _fail() {
            log.error('cf: backoff failed');
            self.emit('moray-fail');
        });

        _bucketInit();
    });

    if (options && options.restifyServer) {
        self.mountRestifyServerRoutes(options.restifyServer);
    }
}
mod_util.inherits(Publisher, EventEmitter);

/*
 * Sets up the restify handlers required for changefeed listeners to be able to
 * use (query and connect to) this changefeed publisher instance.
 *
 * @params {Object} restifyServer - A restify server instance on which restify
 *  handlers will be registered
 *
 * Returns undefined.
 */
Publisher.prototype.mountRestifyServerRoutes =
    function mountRestifyServerRoutes(restifyServer) {
    mod_assert.object(restifyServer, 'restifyServer');

    var log = this.log;
    var self = this;
    var server = restifyServer;

    server.get({
        name: 'changefeeds',
        path: '/changefeeds'
    }, self._getResources.bind(this));
    server.get({
        name: 'changefeeds_stats',
        path: '/changefeeds/stats'
    }, self._getStats.bind(this));
    server.on('upgrade', function _upgrade(req, socket, head) {
        log.trace('cf: upgrade: start');
        var websocket = null;
        try {
            websocket = shed.accept(req, socket, head);
        } catch (ex) {
            log.error('error: ' + ex.message);
            return socket.end();
        }

        // The use of once is deliberate. This should accept no data from the
        // listener after bootstrap.
        websocket.once('text', function _register(text) {
            log.trace('cf: _register: start');
            var registration = JSON.parse(text);
            self.websockets[registration.instance] = websocket;
            self.registrations[registration.instance] = registration;
            var response = null;
            for (var i = 0; i < self.resources.length; i++) {
                var resource = self.resources[i];
                if (resource.resource === registration.changeKind.resource) {
                    log.info('Accepting valid registration response');
                    self.emit('registration');
                    response = resource;
                }
            }
            // If the registration was valid, send the bootstrap response
            if (response) {
                websocket.send(JSON.stringify(response));
            } else {
                var regResource = registration.changeKind.resource;
                log.warn('Invalid registration resource: %s', regResource);
            }
        });

        // When a listener disconnects, for any reason, clean up listeners
        websocket.on('end', function _end() {
            log.trace('cf: _end: start');
            for (var instance in self.registrations) {
                if (this._id === self.websockets[instance]._id) {
                    log.info('Collecting instance: %s', instance);
                    delete self.websockets[instance];
                    delete self.registrations[instance];
                }
            }
        });
        websocket.on('connectionReset', function _connectionReset() {
            log.trace('cf: _connectionReset: start');
            for (var instance in self.registrations) {
                if (this._id === self.websockets[instance]._id) {
                    log.info('Collecting instance: %s', instance);
                    delete self.websockets[instance];
                    delete self.registrations[instance];
                }
            }
        });

        return null;
    });
};

/*
 * Halts all publishing operations including Moray polling and WebSocket push
 */
Publisher.prototype.stop = function stop() {
    var self = this;
    self.log.trace('cf: stop: start');
    clearInterval(self.pollInterval);
    clearInterval(self.gcPollInterval);
    self.morayClient.close();
};

/*
 * This causes the publisher module to begin polling its moray bucket and push
 * change feed events to registered listeners. Items in the moray bucket are
 * initially marked with `published=no`, and subsequently updated with a
 * published value of date when they were sent to listeners.
 */
Publisher.prototype.start = function start() {
    var self = this;
    self.log.trace('cf: start: start');
    var client = self.morayClient;
    var bucketName = self.morayBucket.name;
    var log = self.log;

    // Start the gc process
    self._gcItems();

    // Start the publishing poller
    self.pollInterval = setInterval(function _poll() {
        self.log.trace('cf: _poll: start');
        var req = client.findObjects(bucketName, '(published=no)');
        req.on('error', function _reqErr(err) {
            log.warn(err);
        });

        req.on('record', function _record(record) {
            self.log.trace({ cfRecord: record }, 'cf: record: start');
            var value = record.value;
            value.published = Date.now().toString();
            var strValue = null;
            try {
                strValue = JSON.stringify(value);
            } catch (ex) {
                log.error('Error serializing value: %s', ex.message);
            }

            // The double for loop is not the most efficent choice, however
            // in practice it shouldn't see enough iterations to matter at this
            // point. The simplicity out weighs the complexity of implementing
            // a more sophisticated structure at this point.
            for (var instance in self.registrations) {
                var regWebsocket = self.websockets[instance];
                var regChangeKind = self.registrations[instance].changeKind;
                var resource = value.changeKind.resource;
                if (regChangeKind.resource === resource) {
                    var regSubResources = regChangeKind.subResources;
                    var subResources = value.changeKind.subResources;
                    for (var i = 0; i < subResources.length; i++) {
                        if (regSubResources.indexOf(subResources[i]) !== -1) {
                            regWebsocket.send(strValue);
                            log.info('Published: %s', strValue);
                            self.emit('item-published');
                            break;
                        }
                    }
                } else {
                    log.info('No registrations for value: %j', value);
                }
            }

            // Mark each change feed item as published so that they aren't
            // re-sent to registered listeners.
            var key = record.key;
            client.putObject(bucketName, key, value, function _mark(err) {
                if (err) {
                    log.warn('Error putting object to moray. Error: %j', err);
                } else {
                    log.info('marking %s published', key);
                }
            });
        });

        req.on('end', function _noItems() {
            self.emit('no-items');
            log.info('findObjects ended');
        });
    }, pollTime);
};

/*
 * Add item to change feed Moray bucket so that it can be picked up and fully
 * published by the polling mechanism in start().
 *
 * Example item:
 * {
 *    changeKind: {
 *        resource: 'vm',
 *        subResources: ['alias']
 *    },
 *    changedResourceId: 'uuid_of_changed_resource'
 * };
 */
Publisher.prototype.publish = function publish(item, cb) {
    mod_assert.ok(item.hasOwnProperty('changeKind'),
        'changeKind object required on item to publish');
    mod_assert.ok(item.hasOwnProperty('changedResourceId'),
        'changedResourceId required on item to publish');

    // Tack on published property for tracking purposes
    item.published = 'no';

    this._putObject(item, function (err) {
        cb(err);
    });
};

Publisher.prototype._getBucket = function _getBucket(cb) {
    this.morayClient.getBucket(this.morayBucket.name, cb);
};

Publisher.prototype._gcItems = function () {
    var self = this;
    var client = self.morayClient;
    var bucketName = self.morayBucket.name;
    var log = self.log;

    self.gcPollInterval = setInterval(function _gcPoll() {
        var sweepDate = Date.now() - self.maxAge;
        var req = client.findObjects(bucketName, '(!(published=no))');
        req.on('error', function _gcReqErr(err) {
            log.warn(err);
        });

        req.on('record', function _gcRecord(record) {
            var value = record.value.published;
            if (parseInt(value, 10) <= sweepDate) {
                client.delObject(bucketName, record.key, function _gcItem(err) {
                    if (err) {
                        log.warn({ gcError: err }, 'Error collecting record');
                    } else {
                        log.info('%s deleted', record.key);
                    }
                });
            }
        });

        req.on('end', function _noGcItems(err) {
            if (err) {
                log.warn('Error deleting object from moray. Error: %j', err);
            } else {
                log.info('No more items to GC');
            }
        });
    }, gcPollTime);
};

Publisher.prototype._getStats = function _getStats(req, res, next) {
    var listenerCount = 0;
    var listenerRegistrations = null;
    if (this.registrations) {
        listenerCount = Object.keys(this.registrations).length;
        listenerRegistrations = this.registrations;
    }

    var stats = {
        listeners: listenerCount,
        registrations: listenerRegistrations
    };
    res.send(stats);
    next();
};

Publisher.prototype._getResources = function _getResources(req, res, next) {
    res.send(this.resources);
    next();
};

Publisher.prototype._putObject = function _putObject(item, cb) {
    var bucket = this.morayBucket;
    this.morayClient.putObject(bucket.name, mod_libuuid.create(), item, cb);
};

module.exports = Publisher;

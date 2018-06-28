/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var mod_assert = require('assert-plus');
var mod_backoff = require('backoff');
var mod_jsprim = require('jsprim');
var mod_libuuid = require('libuuid');
var mod_moray = require('moray');
var mod_semver = require('semver');
var mod_util = require('util');
var mod_vasync = require('vasync');
var VError = require('verror');
var Watershed = require('watershed').Watershed;

var shed = new Watershed();
var pollTime = 2000; // Poll moray bucket every 2 seconds
var gcPollTime = 6361; // Prime number chosen to alleviate overlap with pollTime

/*
 * ROUTE VERSIONS:
 *
 * - 1.0.0: the original changefeed API
 * - 2.0.0: new listener registration format to support multiple resources
 */
var ROUTE_VERSIONS = [
    '1.0.0',
    '2.0.0'
];

function assertResource(resource, i) {
    var name = 'options.resources[' + i + ']';

    mod_assert.object(resource, name);
    mod_assert.string(resource.resource, name + '.resource');
    mod_assert.string(resource.bootstrapRoute, name + '.bootstrapRoute');
    mod_assert.arrayOfString(resource.subResources, name + '.subResources');
}

function assertPublisherOptions(options) {
    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.object(options.moray, 'options.moray');
    mod_assert.string(options.moray.bucketName, 'options.moray.bucketName');
    mod_assert.optionalObject(options.backoff, 'options.backoff');
    mod_assert.optionalObject(options.moray.client, 'options.moray.client');
    mod_assert.optionalObject(options.restifyServer, 'options.restifyServer');
    if (options.moray.client === undefined || options.moray.client === null) {
        mod_assert.string(options.moray.host, 'options.moray.host');
        mod_assert.number(options.moray.port, 'options.moray.port');
    } else {
        mod_assert.equal(options.moray.host, undefined, 'options.moray.host');
        mod_assert.equal(options.moray.port, undefined, 'options.moray.port');
    }
    mod_assert.array(options.resources, 'options.resources');
    options.resources.forEach(assertResource);
}

function isBucketNotFoundError(err) {
    return err && VError.hasCauseWithName(err, 'BucketNotFoundError');
}

function isObject(obj) {
    if (typeof (obj) !== 'object') {
        return false;
    }

    return (obj !== null && !Array.isArray(obj));
}

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
    assertPublisherOptions(options);
    var self = this;
    self.pollInterval = null;
    self.gcPollInterval = null;
    EventEmitter.call(self);

    // registrations and websockets track listener details, and are used for GC.
    self.websockets = {};
    self.registrations = {};
    self.resources = {};

    self._setupResources(options.resources);

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
    self.morayBucket = {
        name: morayOptions.bucketName,
        config: {
            index: {
                published: { type: 'string' }
            }
        }
    };

    if (morayOptions.client) {
        self.morayClient = morayOptions.client;
        self.morayClientNeedsClose = false;
        setImmediate(onMorayConnect);
    } else {
        self.morayClient = mod_moray.createClient({
            log: options.log,
            host: morayOptions.host,
            port: morayOptions.port
        });
        self.morayClient.on('connect', onMorayConnect);
        self.morayClientNeedsClose = true;
    }

    var log = self.log = options.log;
    var morayClient = self.morayClient;
    var expBackoff = mod_backoff.exponential({
        initialDelay: self.minTimeout,
        maxDelay: self.maxTimeout
    });

    expBackoff.failAfter(self.retries);

    function onMorayConnect() {
        log.trace('cf: _morayConnect: started');
        log.info({ moray: morayClient.toString() }, 'cf: moray: connected');
        self.emit('moray-connected');

        // Handles bucket initilization and backoff on failure
        function _bucketInit() {
            morayClient.getBucket(self.morayBucket.name, function _gb(err) {
                if (isBucketNotFoundError(err)) {
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
    }

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
        path: '/changefeeds',
        version: ROUTE_VERSIONS
    }, self._getResources.bind(this));

    server.get({
        name: 'changefeeds_stats',
        path: '/changefeeds/stats',
        version: ROUTE_VERSIONS
    }, self._getStats.bind(this));

    server.on('upgrade', function _upgrade(req, socket, head) {
        log.trace('cf: upgrade: start');
        var websocket = null;
        try {
            websocket = shed.accept(req, socket, head);
        } catch (ex) {
            log.error(ex, 'failed to accept new websocket');
            return socket.end();
        }

        /*
         * The use of once is deliberate. This should accept no data from the
         * listener after bootstrap. Changefeed clients take advantage of this
         * and send periodic "heartbeat" messages to test whether the
         * connection's alive.
         *
         * If a version is unspecified, we assume the old registration format
         * for now.
         */
        websocket.once('text', function _register(text) {
            var v = req.getVersion();

            log.trace('cf: _register: start');

            if (v === '*' || mod_semver.gtr('2.0.0', v)) {
                self._acceptRegistrationV1(text, websocket);
            } else {
                self._acceptRegistrationV2(text, websocket);
            }
        });

        // When a listener disconnects, for any reason, clean up listeners
        websocket.on('end', function _end() {
            log.trace('cf: _end: start');
            self._detachWebsocket(websocket);
        });

        websocket.on('connectionReset', function _connectionReset() {
            log.trace('cf: _connectionReset: start');
            self._detachWebsocket(websocket);
        });

        return null;
    });
};

Publisher.prototype._setupResources = function setupResources(resources) {
    var self = this;

    resources.forEach(function _setupResource(r) {
        var name = r.resource;

        if (mod_jsprim.hasKey(self.resources, name)) {
            throw new VError(
                'Resource %j appears multiple times in configuration', name);
        }

        self.resources[name] = r;
        self.registrations[name] = {};
    });
};

Publisher.prototype._detachWebsocket = function detachWebsocket(websocket) {
    if (!mod_jsprim.hasKey(this.websockets, websocket._id.toString())) {
        /*
         * This WebSocket never completed registration.
         */
        return;
    }

    var instance = this.websockets[websocket._id];

    mod_jsprim.forEachKey(this.registrations, function (_, registrations) {
        if (!mod_jsprim.hasKey(registrations, instance)) {
            return;
        }

        if (websocket === registrations[instance].websocket) {
            delete registrations[instance];
        }
    });

    delete this.websockets[websocket._id];
};

/*
 * The original registration format was an object that looked like
 * the following:
 *
 * {
 *     "instance": "d378568c-6707-c7cb-fb7f-804ef90adf11",
 *     "resource": "foo",
 *     "subResources": [
 *         "create",
 *         "delete"
 *     ]
 * }
 *
 * This registration format and the old publisher implementation only allowed
 * for subscribing to a single resource per instance identifier, which meant
 * that consumers who cared about multiple feeds needed to create multiple
 * websockets, each with a different identifier.
 */
Publisher.prototype._acceptRegistrationV1 =
    function acceptRegistrationOld(text, websocket) {
    var registration, resource, response;
    var log = this.log;

    function fail(reason) {
        log.warn({
            registration: registration
        }, 'Invalid v1 changefeed registration: %s', reason);

        websocket.end(reason);
    }

    /*
     * Parse the incoming response, and then validate it.
     */
    try {
        registration = JSON.parse(text);
    } catch (e) {
        fail('failed to parse v1 registration payload');
        return;
    }

    if (!isObject(registration)) {
        fail('v1 registration should be an object');
        return;
    }

    if (typeof (registration.instance) !== 'string') {
        fail('v1 registration should contain an "instance" identifier');
        return;
    }

    if (!isObject(registration.changeKind)) {
        fail('v1 registration should contain a "changeKind"');
        return;
    }

    if (typeof (registration.changeKind.resource) !== 'string') {
        fail('v1 registration should contain a valid "resource"');
        return;
    }

    if (!Array.isArray(registration.changeKind.subResources)) {
        fail('v1 registration should contain a valid "subResources" array');
        return;
    }

    resource = registration.changeKind.resource;

    /*
     * Response successfully validated, finish registration.
     */
    if (!mod_jsprim.hasKey(this.resources, resource)) {
        fail('unknown resource: ' + resource);
        return;
    }

    response = this.resources[resource];
    registration.websocket = websocket;

    this.websockets[websocket._id] = registration.instance;
    this.registrations[resource][registration.instance] = {
        resource: registration.changeKind.resource,
        subResources: registration.changeKind.subResources,
        websocket: registration.websocket
    };

    log.info('Accepting valid registration response');

    this.emit('registration');

    // Send the bootstrap response.
    websocket.send(JSON.stringify(response));
};


Publisher.prototype._acceptRegistrationV2 =
    function acceptRegistration(text, websocket) {
    var log = this.log;
    var responses = [];
    var registration;
    var r, i;

    function fail(reason) {
        log.warn({
            registration: registration
        }, 'Invalid v2 changefeed registration: %s', reason);

        websocket.end(reason);
    }

    /*
     * Parse the incoming response, and then validate it.
     */
    try {
        registration = JSON.parse(text);
    } catch (e) {
        fail('failed to parse v2 registration payload');
        return;
    }

    if (!isObject(registration)) {
        fail('v2 registration should be an object');
        return;
    }

    if (typeof (registration.instance) !== 'string') {
        fail('v2 registration should contain an "instance" identifier');
        return;
    }

    if (!Array.isArray(registration.resources)) {
        fail('v2 registration should contain a "resources" array');
        return;
    }

    if (registration.resources.length === 0) {
        fail('no resources specified');
        return;
    }

    for (i = 0; i < registration.resources.length; ++i) {
        r = registration.resources[i];

        if (!isObject(r)) {
            fail('v2 registration "resources" array should contain objects');
            return;
        }

        if (typeof (r.resource) !== 'string' || r.resource.length === 0) {
            fail('v2 registration resources should contain a "resource"');
            return;
        }

        if (!Array.isArray(r.subResources)) {
            fail('v2 registration resources should contain "subResources"');
            return;
        }

        if (!mod_jsprim.hasKey(this.resources, r.resource)) {
            /*
             * If we don't recognize a resource, then we reject the connection,
             * since we can't send any bootstrap information.
             *
             * If we're running in a multi-publisher standup, and one publisher
             * has upgraded ahead of the others (possibly gaining a new
             * resource), then this allows the client to attempt reconnecting
             * until it discovers the upgraded publisher.
             */
            fail('unknown resource: ' + r.resource);
            return;
        }

        responses.push(this.resources[r.resource]);
    }

    /*
     * The registration is valid, we can move on to actually
     * setting things up.
     */
    this.websockets[websocket._id] = registration.instance;

    for (i = 0; i < registration.resources.length; ++i) {
        r = registration.resources[i];
        r.websocket = websocket;

        this.registrations[r.resource][registration.instance] = r;
    }

    websocket.send(JSON.stringify({
        bootstrapRoutes: responses
    }));
};

Publisher.prototype._notifySubscribers = function notifySubscribers(value) {
    var log = this.log;
    var strValue = null;

    if (!mod_jsprim.hasKey(value, 'changeKind')) {
        log.warn({ value: value },
            'found malformed changefeed record');
        return;
    }

    var resource = value.changeKind.resource;
    if (!mod_jsprim.hasKey(this.resources, resource)) {
        log.warn({ value: value },
            'found changefeed record with unknown resource');
        return;
    }

    try {
        strValue = JSON.stringify(value);
    } catch (ex) {
        log.error('Error serializing value: %s', ex.message);
    }

    var registrations = this.registrations[resource];
    var subscribers = Object.keys(registrations);
    if (subscribers.length === 0) {
        log.info('No subscribers for "%s" changes', resource);
        return;
    }

    for (var i = 0; i < subscribers.length; ++i) {
        var reg = this.registrations[subscribers[i]];
        var subResources = value.changeKind.subResources;
        for (var j = 0; j < subResources.length; j++) {
            if (reg.subResources.indexOf(subResources[j]) !== -1) {
                reg.websocket.send(strValue);
                this.emit('item-published');
                break;
            }
        }
    }

    log.debug({ value: value },
        'Published "%s" change to %d subscribers',
        resource, subscribers.length);
};

/*
 * Halts all publishing operations including Moray polling and WebSocket push
 */
Publisher.prototype.stop = function stop() {
    var self = this;
    self.log.trace('cf: stop: start');
    clearInterval(self.pollInterval);
    clearInterval(self.gcPollInterval);
    if (self.morayClientNeedsClose) {
        self.morayClient.close();
    }
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
            log.warn(err, 'cf: _poll: error');
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

            var resource = value.changeKind.resource;
            if (!mod_jsprim.hasKey(self.resources, resource)) {
                log.warn({ value: value },
                    'cannot publish unknown resource %j', resource);
                return;
            }

            var registrations = self.registrations[resource];
            var instances = Object.keys(registrations);
            var subResources = value.changeKind.subResources;

            /*
             * The double for loop is not the most efficent choice, however
             * in practice it shouldn't see enough iterations to matter at this
             * point. The simplicity out weighs the complexity of implementing
             * a more sophisticated structure at this point.
             */
            for (var i = 0; i < instances.length; ++i) {
                var registration = registrations[instances[i]];
                var regSubResources = registration.subResources;
                for (var j = 0; j < subResources.length; j++) {
                    if (regSubResources.indexOf(subResources[j]) === -1) {
                        continue;
                    }

                    registration.websocket.send(strValue);
                    log.info('Published: %s', strValue);
                    self.emit('item-published');
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

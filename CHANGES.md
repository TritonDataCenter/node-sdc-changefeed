# node-sdc-changefeed changelog
 * Please note that not all changes will be listed here. Only changes which
   impact the API of the module will be listed. You'll likely only see minor
   version change statements.

## 1.1.0
 * Switch to using restify-clients for the listener. This is to take advantage
   of the backoff functionality and built in bunyan tracing.
 * The `host` and `port` options properties are now deprecated and have been
   replaced by the `url` options property. The `host` and `port` properties will
   continue to work, but they will go away in a future version.
 * A `backoff` object has been added as an optional part of the `options`
   object. This lets the publisher and listener handle unavailability at init.

## 1.1.7
 * The publisher now emits a `registration` event when listeners register.

## 1.2.0
 * Listener properly emits `bootstrap` after successful backoff.
 * Listener returns error objects when `error` is emitted.
 * Listener changefeed item recieved logs are now trace instead of debug.
 * Listener emits `connection-reset` instead of `connection-end` when a
   watershed `connectionReset` event is handled. `connection-end` is still
   emitted when watershed emits `connectionReset`.

## 1.2.1
 * Support up to node version 4.

## 1.2.2
 * Upgrade to watershed v0.3.3 which fixes a write-after-end issue in the
   publisher.

## 1.3.0
 * Make `options.restifyServer` parameter optional for the `Publisher`
   constructor.
 * Add `Publisher.prototype.mountRestifyServerRoutes(restifyServer)` to the
   `Publisher`'s API.
 * Make `Listener.prototype.close` an alias for `Listener.prototype._endSocket`.

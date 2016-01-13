# Changes
 * Please note that not all changes will be listed here. Only changes which
   impact the API of the module will be listed. You'll likely only see minor
   version change statements.

### 1.1.0
 * Switch to using restify-clients for the listener. This is to take advantage
   of the backoff functionality and built in bunyan tracing.
 * The `host` and `port` options properties are now deprecated and have been
   replaced by the `url` options property. The `host` and `port` properties will
   continue to work, but they will go away in a future version.
 * A `backoff` object has been added as an optional part of the `options`
   object. This lets the publisher and listener handle unavailability at init.

### 1.1.7
 * The publisher now emits a `registration` event when listeners register.

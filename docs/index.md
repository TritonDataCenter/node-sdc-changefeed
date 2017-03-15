---
title: node-sdc-changefeed documentation
markdown2extras: tables, code-friendly
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

Please see [Joyent Engineering
Guidelines](https://github.com/joyent/eng/blob/master/docs/index.md) for a
general set of guidelines that apply to all Joyent repositories.

# API

## Publisher

### Constructor options

* The `backoff` object is optional and defaults will be set if not provided.
* The `restifyServer` is optional. If no `restifyServer` parameter is passed,
  the publisher instance won't be reachable via HTTP using the routes documented
  below, but will still record changes that need to be published. Users can
  separately call the `mountRestifyServerRoutes` method to mount these routes at
  any time.

```
{
    backoff: {
        maxTimeout: Infinity,
        minTimeout: 10,
        retries: Infinity
    },
    log: bunynan_instance,
    maxAge: 28800,
    moray: {
        bucketName: 'name_of_feed_bucket',
        host: '10.99.99.17',
        resolvers: {
            resolvers: ['10.99.99.11']
        },
        timeout: 200,
        minTimeout: 1000,
        maxTimeout: 2000,
        port: 2020
    },
    restifyServer: restify_instance,
    resources: resource_array
}
```

### Public methods

#### `mountRestifyServerRoutes(restifyServer)`

Mounts [the routes documented below]()#publisher-added-http-routes) on the
restify server instance `restifyServer`.

## Listener

### constructor options

* The backoff object is optional and defaults will be set if not provided.

```
{
    backoff: {
        maxTimeout: Infinity,
        minTimeout: 10,
        retries: Infinity
    },
    log: bunynan_instance,
    url: 'http://localhost',
    instance: 'uuid_of_listener_service',
    service: 'listener_service_name',
    changeKind: changeKind
}

# Objects

## ChangeKind

```
{
    resource: 'resource_name',
    subResources: ['resource_property1']
}
```

### ChangeItem

```
{
    changeKind: changeKind,
    changedResourceId: 'id_of_resource'
}
```

## Resource

```
{
    resource: 'resource_name',
    subResources: ['resource_property1', 'resource_property2'],
    bootstrapRoute: '/resource_name'
}
```

```

## Registration

```
{
    instance: 'uuid_of_listener_service',
    service: 'listener_service_name',
    changeKind: changeKind
}
```

## Stats

```
{
    listeners: 10,
    registrations: registrations
}
```

# Publisher events emitted

## moray-connected

 * Emitted when the publisher module has connected to the supplied moray
   instance.

## moray-fail

 * Emitted when the publisher module hits max backoff retries without
   successfully creating a changefeed bucket.

## moray-ready

 * Emitted when the publisher has ensured the change feed bucket exists.

## item-published

 * Emitted when the publisher has sent a ChangeItem to a listener.

## no-items

 * Emitted when the publisher finds no ChangeItems in the moray bucket during a
   polling interval.

# Listener events emitted

## connection-end

 * Emitted when the listener has disconnected from the publisher for any reason.

## bootstrap

 * Emitted when the listener receives a bootstrap payload from the publisher.

## Error

 * Emitted when the listener detects an out of state object from the publisher,
   or when the listener fails to connect to the publisher.

# Publisher added HTTP routes

## GetChangeFeeds (GET /changefeeds)

Returns an array of change feed Resource objects that represent the set of
change feed resources a listener can register for.

### GetChangeFeeds Responses

| Code | Description                     | Response                      |
| ---- | ------------------------------- | ----------------------------- |
| 200  | OK                              | Array of resource objects     |
| 500  | SERVER ERROR                    | Error object                  |

## GetChangeFeedsStats (GET /changefeeds/stats)

Returns an object containing the current count of listeners and an array of
listener registrations.

### GetChangeFeedStats Responses

| Code | Description                     | Response                      |
| ---- | ------------------------------- | ----------------------------- |
| 200  | OK                              | Stats object                  |
| 500  | SERVER ERROR                    | Error object                  |

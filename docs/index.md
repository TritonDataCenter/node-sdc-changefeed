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
    Copyright (c) 2015, Joyent, Inc.
-->

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

## Publisher options

```
{
    log: bunynan_instance,
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
    resources: resource_array,
    maxAge: 28800
}
```

## Listener options

```
{
    log: bunynan_instance,
    endpoint: '127.0.0.1',
    port: 8080,
    instance: 'uuid_of_listener_service',
    service: 'listener_service_name',
    changeKind: changeKind
}
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

 * Emitted when the listener detects an out of state object from the publisher.

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





Please see [Joyent Engineering Guidelines](https://github.com/joyent/eng/blob/master/docs/index.md)
for a general set of guidelines that apply to all Joyent repositories.

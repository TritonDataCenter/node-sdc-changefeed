<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# node-sdc-changefeed

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

SDC Changefeed provides support for publishing and listening to change
feeds in Triton via Node.js libraries and a CLI.


## Installation

```
$ npm install changefeed
```


## Development

Before committing be sure to, at least run:

```
$ make check      # lint and style checks
$ make test       # run tests
```


## Test

Simple tests (requires a running CoaL) can be run using:

```
$ make test
```

## CLI

```
$ changefeedsnoop -h 127.0.0.1 -p 8080 -r vm -s nic,alias | bunyan --color
```

## Setup

Publisher

```
var mod_bunyan = require('bunyan');
var mod_changefeed = require('changefeed');
var mod_restify = require('restify');

var options = {
    backoff: {
        maxTimeout: Infinity,
        minTimeout: 10,
        retries: Infinity
    },
    log: mod_bunyan.createLogger({
        name: 'publisher_test',
        level: process.env['LOG_LEVEL'] || 'trace',
        stream: process.stderr
    }),
    maxAge: 2000,
    moray: {
        bucketName: 'pub_change_bucket',
        host: '10.99.99.17',
        resolvers: {
            resolvers: ['10.99.99.11']
        },
        timeout: 200,
        minTimeout: 1000,
        maxTimeout: 2000,
        port: 2020
    }
    restifyServer: server,
    resources: resources
};

var publisher = mod_changefeed.createPublisher(options);
```

Listener

```
var mod_bunyan = require('bunyan');
var mod_changefeed = require('changefeed');

var options = {
    backoff: {
        maxTimeout: Infinity,
        minTimeout: 10,
        retries: Infinity
    },
    log: mod_bunyan.createLogger({
        name: 'listener_test',
        level: process.env['LOG_LEVEL'] || 'error',
        stream: process.stderr
    }),
    url: 'http://localhost',
    instance: 'uuid goes here',
    service: 'tcns',
    changeKind: {
        resource: 'vm',
        subResources: ['nic', 'alias']
    }
};

var listener = mod_changefeed.createListener(options);
```

## Documentation

[Detailed documentation is located at docs/index.md](docs/index.md).

See [RFD 0005 Triton Change Feed Support](https://github.com/joyent/rfd/blob/master/rfd/0005/README.md)
for current design and architecture decisions.

## License

"node-sdc-changefeed" is licensed under the
[Mozilla Public License version 2.0](http://mozilla.org/MPL/2.0/).
See the file LICENSE.

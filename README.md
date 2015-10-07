<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->

# node-sdc-changefeed

Provides support for publishing and listening to change feeds in SmartDataCenter
/ Triton via Node.js libraries and a CLI.


## Installation

```
$ npm install node-sdc-changefeed       # use -g if you'd like the CLI portion
```


## Development

Before committing be sure to, at least run:

```
$ make check      # lint and style checks
$ make test       # run tests
```


## Test

Simple tests can be run using:

```
$ make test
```

If you'd like to integration test against CoaL:

```
$ make test-integration-in-coal
```


## Documentation

[Detailed documentation is located at docs/index.md](docs/index.md).

See [RFD 0005 Triton Change Feed Support](https://github.com/joyent/rfd/blob/master/rfd/0005/README.md)
for current design and architecture decisions.

## License

"node-sdc-changefeed" is licensed under the
[Mozilla Public License version 2.0](http://mozilla.org/MPL/2.0/).
See the file LICENSE.

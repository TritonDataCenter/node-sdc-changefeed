/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var publisher = require('./publisher');
var listener = require('./listener');

module.exports = {
    createPublisher: function (options) {
        return new publisher(options);
    },
    createListener: function (options) {
        return new listener(options);
    }
};

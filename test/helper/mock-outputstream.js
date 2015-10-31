/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var mod_vstream = require('vstream');
var mod_stream = require('stream');
var mod_util = require('util');

function TestOutputStream(opts) {
    opts = { objectMode : true };

    mod_stream.Transform.call(this, opts);
    mod_vstream.wrapTransform(this);
}
mod_util.inherits(TestOutputStream, mod_stream.Transform);

TestOutputStream.prototype._transform = function (buf, enc, cb) {
    // buf is a line-oriented chunk
    var chunk = buf;
    console.log(chunk);
    this.push(chunk);
    cb();
};

module.exports = TestOutputStream;

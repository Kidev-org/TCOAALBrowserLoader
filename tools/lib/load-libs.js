/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details: <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
"use strict";

/*
 * The browser libraries under app/js/libs, run unmodified in one Node vm
 * context, for the build tools (build-mod.js, base-index.js). A package built
 * here is then made by exactly the code create.html runs.
 *
 * tools/mod-loader.js keeps its own copy of this: it is embedded in the
 * installer stub file by file (TOOL_FILES in tools/desktop/user), and a
 * require() of this file would be one the stub does not carry.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const LIB_DIR = path.join(__dirname, "..", "..", "app", "js", "libs");

/**
 * Load `names` (file names under app/js/libs, without ".js") in order into a
 * fresh context and return its `self`, where each library publishes itself
 * (TcoaalCodec, JsonDiff, ModPackage, ModDiff, StubStamp, ...).
 */
function loadLibs(names) {
  const self = {};
  const ctx = vm.createContext({
    self,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    Response,
    Blob,
    URL,
    console,
  });
  for (const name of names) {
    const abs = path.join(LIB_DIR, name + ".js");
    vm.runInContext(fs.readFileSync(abs, "utf8"), ctx, { filename: abs });
  }
  return self;
}

module.exports = { loadLibs, LIB_DIR };

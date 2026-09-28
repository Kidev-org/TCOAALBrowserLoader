#!/usr/bin/env node
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
 * Writes .config/base-index.json for a mod repository: the reference index of
 * the game release the mod is built on (ModDiff.baseIndex in
 * app/js/libs/mod-diff-worker.js; the hash of every game file's decoded
 * bytes, and the fingerprint, nothing of the game itself). app/create.html
 * puts the same file into the GitHub setup it downloads, from the game
 * imported in the browser; this is the same thing from a game folder.
 *
 *   node tools/base-index.js <game www folder> [out file]
 *
 * The out file defaults to .config/base-index.json in the current folder.
 */

const fs = require("fs");
const path = require("path");
const { loadLibs } = require("./lib/load-libs.js");

function walk(dir) {
  const out = [];
  (function rec(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) rec(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  })(dir, "");
  return out.sort();
}

async function buildIndex(www) {
  const L = loadLibs(["tcoaal-codec", "json-diff", "mod-diff-worker"]);
  const files = walk(www);
  return L.ModDiff.baseIndex({
    list: async () => files.slice(),
    read: async (rel) => new Uint8Array(fs.readFileSync(path.join(www, rel))),
  });
}

async function main() {
  const [www, outArg] = process.argv.slice(2);
  if (!www || !fs.existsSync(path.join(www, "data"))) {
    console.error("Usage: node tools/base-index.js <game www folder> [out file]");
    process.exit(2);
  }
  const out = outArg || path.join(".config", "base-index.json");
  const index = await buildIndex(www);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index) + "\n");
  console.log(`${out}: v${index.game}, ${Object.keys(index.files).length} files`);
}

module.exports = { buildIndex };

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

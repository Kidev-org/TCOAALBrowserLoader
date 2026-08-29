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
 * Minimal .icns builder/parser used by app/create.html (Task 8) to stamp the
 * mod's icon into a prebuilt macOS .app bundle's Contents/Resources/. This
 * is the macOS counterpart to pe-resources.js's Windows .rsrc rewriter, but
 * far simpler: the ICNS container is just a magic, a whole-file big-endian
 * u32 length, and a flat list of typed chunks (no offset tables, no RVAs).
 *
 * Container layout, all integers big-endian:
 *   [4-byte magic "icns"][u32 total file length, header included]
 *   chunk*: [4-byte type tag][u32 chunk length, its own 8-byte header
 *            included][data]
 *
 * We only ever emit/consume the "icnN" native PNG icon types (osx 10.7+),
 * one per requested size. No masks, no legacy raw bitmap formats.
 */
(function (root) {
  var TYPES = [
    { type: "ic11", size: 32 },
    { type: "ic12", size: 64 },
    { type: "ic07", size: 128 },
    { type: "ic08", size: 256 },
    { type: "ic09", size: 512 },
    // 1024 is ic10 (512x512@2x), NOT ic13. ic13 is the 128x128@2x variant,
    // which is a 256-pixel image, the same pixel size ic08 already covers.
    { type: "ic10", size: 1024 },
  ];

  var HEADER_SIZE = 8; // magic(4) + total length(4)
  var CHUNK_HEADER_SIZE = 8; // type(4) + chunk length(4)

  function build(pngsBySize) {
    var chunks = [];
    var total = HEADER_SIZE;
    for (var i = 0; i < TYPES.length; i++) {
      var png = pngsBySize.get(TYPES[i].size);
      if (!png) continue;
      chunks.push({ type: TYPES[i].type, data: png });
      total += CHUNK_HEADER_SIZE + png.length;
    }
    if (!chunks.length) {
      throw new Error("No icon sizes available to build an .icns.");
    }

    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

    out[0] = 0x69; // 'i'
    out[1] = 0x63; // 'c'
    out[2] = 0x6e; // 'n'
    out[3] = 0x73; // 's'
    dv.setUint32(4, total, false); // whole-file length, header included

    var o = HEADER_SIZE;
    for (var c = 0; c < chunks.length; c++) {
      var type = chunks[c].type;
      var data = chunks[c].data;
      for (var k = 0; k < 4; k++) out[o + k] = type.charCodeAt(k);
      dv.setUint32(o + 4, CHUNK_HEADER_SIZE + data.length, false);
      out.set(data, o + CHUNK_HEADER_SIZE);
      o += CHUNK_HEADER_SIZE + data.length;
    }

    return out;
  }

  function parse(bytes) {
    // Validate the magic before walking chunks. Without this, pointing parse()
    // at any other file just scans its bytes from offset 8 as if they were
    // chunk headers and returns whatever looks structurally plausible.
    if (
      bytes.length < HEADER_SIZE ||
      bytes[0] !== 0x69 || bytes[1] !== 0x63 || bytes[2] !== 0x6e || bytes[3] !== 0x73
    ) {
      throw new Error("Not an .icns file (no icns magic).");
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out = [];
    var o = HEADER_SIZE;
    while (o + CHUNK_HEADER_SIZE <= bytes.length) {
      var type = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
      var len = dv.getUint32(o + 4, false);
      if (len < CHUNK_HEADER_SIZE || o + len > bytes.length) break;
      out.push({ type: type, data: bytes.subarray(o + CHUNK_HEADER_SIZE, o + len) });
      o += len;
    }
    return out;
  }

  root.Icns = { TYPES: TYPES, build: build, parse: parse };
})(typeof self !== "undefined" ? self : this);

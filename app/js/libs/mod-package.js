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
 * Minimal ZIP reader/writer and the tcoaal-mod/3 packager, used by
 * app/create.html to build a distributable .tcoaalmod file. Mirrors the
 * zipWrite/zipRead pair in .modding/tools/share-project.js exactly (local
 * header, central directory, EOCD, no zip64, method 8 deflate-raw with a
 * store fallback), except this version runs in the browser (or a Node vm
 * context with CompressionStream/DecompressionStream/Response polyfilled)
 * instead of against Node's zlib and Buffer.
 *
 * writeZip's output must be readable by an off-the-shelf ZIP crate on the
 * native Rust loader side (a separate future cycle), not just by readZip
 * below, so filenames are UTF-8 with general-purpose bit 11 set, and the
 * CRC-32 / method / size fields are kept byte-identical between the local
 * header and the central directory copy of each entry.
 */
(function (root) {
  var FORMAT = "tcoaal-mod/3";

  // General-purpose bit flag 11 ("language encoding flag" / EFS): tells any
  // ZIP consumer the filename (and comment, unused here) is UTF-8, not the
  // legacy CP437 default. All entry names here are UTF-8, so this is set on
  // both the local header and the central directory copy of every entry.
  var GPBF_UTF8 = 0x0800;

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipe(bytes, stream) {
    var rs = new Response(bytes).body.pipeThrough(stream);
    var buf = await new Response(rs).arrayBuffer();
    return new Uint8Array(buf);
  }

  function deflateRaw(bytes) {
    return pipe(bytes, new CompressionStream("deflate-raw"));
  }

  function inflateRaw(bytes) {
    return pipe(bytes, new DecompressionStream("deflate-raw"));
  }

  function concat(parts) {
    var n = 0,
      i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n);
    var o = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], o);
      o += parts[i].length;
    }
    return out;
  }

  function u16(v) {
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  }

  function u32(v) {
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  }

  async function writeZip(entries) {
    var parts = [],
      central = [],
      offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var nameBuf = new TextEncoder().encode(e.name);
      var crc = crc32(e.data);
      var comp = await deflateRaw(e.data);
      var store = comp.length >= e.data.length;
      var method = store ? 0 : 8;
      var body = store ? e.data : comp;

      var lh = concat([
        u32(0x04034b50),
        u16(20),
        u16(GPBF_UTF8),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(body.length),
        u32(e.data.length),
        u16(nameBuf.length),
        u16(0),
      ]);
      parts.push(lh, nameBuf, body);

      central.push(
        concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(GPBF_UTF8),
          u16(method),
          u16(0),
          u16(0),
          u32(crc),
          u32(body.length),
          u32(e.data.length),
          u16(nameBuf.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(offset),
        ]),
        nameBuf,
      );

      offset += lh.length + nameBuf.length + body.length;
    }
    var cdSize = 0;
    for (var c = 0; c < central.length; c++) cdSize += central[c].length;
    var eocd = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(cdSize),
      u32(offset),
      u16(0),
    ]);
    return concat(parts.concat(central, [eocd]));
  }

  async function readZip(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory).");
    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    var out = new Map();
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      // The local header's OWN name/extra lengths locate its data; these
      // are routinely different from the central directory entry's, and
      // using the wrong pair yields data offset by a few bytes.
      var lNameLen = dv.getUint16(lho + 26, true);
      var lExtraLen = dv.getUint16(lho + 28, true);
      var start = lho + 30 + lNameLen + lExtraLen;
      var body = bytes.subarray(start, start + compSize);
      // .slice() on the stored branch: subarray() would hand back a view
      // aliasing the caller's buffer, while the deflated branch always
      // returns an independent copy. Same ownership either way.
      out.set(name, method === 0 ? body.slice() : await inflateRaw(body));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function readme(m) {
    var lines = [m.name + " v" + m.version + (m.author ? " by " + m.author : "")];
    if (m.description) lines.push(m.description);
    lines.push("");
    lines.push("Format: " + m.format);
    lines.push("Saves: " + m.saves);
    if (m.online) {
      lines.push("");
      lines.push("This is an ONLINE placeholder: it carries this mod's name,");
      lines.push("icon and installer theme, but none of its content. The mod");
      lines.push("itself is downloaded from " + onlineLabel(m.online) + " when");
      lines.push("it is installed, so this file alone installs nothing.");
      return new TextEncoder().encode(lines.join("\n") + "\n");
    }
    for (var i = 0; i < m.variants.length; i++) {
      var v = m.variants[i];
      lines.push("base: " + v.base.label + " (" + v.files.length + " files changed)");
    }
    lines.push("");
    lines.push("This file contains no content from the base game: unchanged files");
    lines.push("are excluded and changed data files travel as patches. Install it");
    lines.push("with the TCOAAL Mod Loader.");
    return new TextEncoder().encode(lines.join("\n") + "\n");
  }

  function onlineLabel(o) {
    if (o.url) return o.url;
    if (o.github) return "the latest release of github.com/" + o.github;
    return o.manifest;
  }

  async function build(spec) {
    var manifest = {
      format: FORMAT,
      id: spec.id,
      name: spec.name,
      author: spec.author || "",
      version: spec.version,
      description: spec.description || "",
      // No build timestamp on purpose. It had no consumer, and a wall-clock
      // field makes two builds of identical input differ, so a modder cannot
      // tell a rebuild that changed something from one that changed nothing.
      // The local header time/date fields above are zeroed for the same
      // reason: a .tcoaalmod is a pure function of its inputs.
      tool: "create.html",
      saves: spec.saves || "isolated",
      variants: spec.variants,
    };
    if (spec.icon) manifest.icon = "icon.png";
    if (spec.theme && spec.theme.length) manifest.theme = { entry: "theme/index.html" };
    if (spec.update && (spec.update.github || spec.update.manifest)) {
      manifest.update = {};
      if (spec.update.manifest) manifest.update.manifest = spec.update.manifest;
      if (spec.update.github) manifest.update.github = spec.update.github;
    }
    // An ONLINE package carries this mod's identity and theme but none of its
    // content: the loader downloads the real thing from this source before it
    // installs anything. Built with variants: [] and an empty payload map,
    // which is what tells it apart from a diff that simply came out empty.
    var on = spec.online || {};
    if (on.url || on.github || on.manifest) {
      manifest.online = {};
      if (on.url) manifest.online.url = on.url;
      if (on.github) manifest.online.github = on.github;
      if (on.manifest) manifest.online.manifest = on.manifest;
    }

    var entries = [{ name: "mod.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }];
    if (spec.icon) entries.push({ name: "icon.png", data: spec.icon });
    (spec.theme || []).forEach(function (t) {
      entries.push(t);
    });
    Array.from(spec.payloads.keys())
      .sort()
      .forEach(function (k) {
        entries.push({ name: k, data: spec.payloads.get(k) });
      });
    entries.push({ name: "README.txt", data: readme(manifest) });
    return writeZip(entries);
  }

  async function parse(bytes) {
    var entries = await readZip(bytes);
    var raw = entries.get("mod.json");
    if (!raw) throw new Error("Invalid mod file: missing mod.json.");
    var manifest = JSON.parse(new TextDecoder().decode(raw));
    // Exact match, not a "tcoaal-" prefix test: a future tcoaal-mod/4 would
    // pass a prefix check and then be misread as if it were this format.
    if (manifest.format !== FORMAT) {
      throw new Error("Unrecognized mod format: " + manifest.format);
    }
    return { manifest: manifest, entries: entries };
  }

  root.ModPackage = {
    FORMAT: FORMAT,
    crc32: crc32,
    writeZip: writeZip,
    readZip: readZip,
    build: build,
    parse: parse,
  };
})(typeof self !== "undefined" ? self : this);

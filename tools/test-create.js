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
/*
 * Smoke-tests for the app/create.html mod-packaging tools.
 *
 * Run with: node tools/test-create.js
 * Exit code 0 = all passed, 1 = at least one failure.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Minimal test harness

let passed = 0,
  failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  \x1b[32m✓\x1b[0m", name);
    passed++;
  } catch (e) {
    console.error("  \x1b[31m✗\x1b[0m", name);
    console.error("    ", e.message);
    failed++;
  }
}

function eq(a, b, label) {
  if (a !== b)
    throw new Error(
      `${label || "eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`,
    );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// Async variant of test(): awaits fn, catches rejections, and defers the
// pass/fail bookkeeping onto a promise the summary awaits before printing so
// async failures are still counted.
const _pending = [];

function atest(name, fn) {
  const p = (async () => {
    try {
      await fn();
      console.log("  \x1b[32m✓\x1b[0m", name);
      passed++;
    } catch (e) {
      console.error("  \x1b[31m✗\x1b[0m", name);
      console.error("    ", e.message);
      failed++;
    }
  })();
  _pending.push(p);
}

// tcoaal-codec

const nodeCrypto = require("crypto");

// Runs one or more library files in order in the SAME vm context, so later
// files can see globals earlier files assigned onto `self` (e.g.
// mod-diff-worker.js reading root.TcoaalCodec / root.JsonDiff). Mirrors how
// a real Worker's importScripts() would load them.
function loadLib(rels) {
  const paths = Array.isArray(rels) ? rels : [rels];
  const ctx = vm.createContext({
    self: {},
    crypto: { subtle: nodeCrypto.webcrypto.subtle },
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    Response,
    console,
  });
  for (const rel of paths) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    vm.runInContext(src, ctx);
  }
  return ctx.self;
}

const C = loadLib(["app/js/libs/tcoaal-codec.js"]).TcoaalCodec;

console.log("\ntcoaal-codec:");

atest("hashPath matches the known System.json hash", async () => {
  eq(await C.hashPath("data/System.json"), "data/be1a37535e921f91");
});

test("enkit then dekit round-trips whole-file encryption", () => {
  const plain = new TextEncoder().encode('{"a":1,"b":[2,3]}');
  const p = "data/be1a37535e921f91";
  const enc = C.enkit(plain, p, 0);
  assert(C.isEncrypted(enc), "enkit output must carry the TCOAAL signature");
  eq(C.readKeyByte(enc), 0);
  const back = C.dekit(enc, p);
  eq(Buffer.from(back).toString("utf8"), '{"a":1,"b":[2,3]}');
});

test("enkit then dekit round-trips partial (keyByte) encryption", () => {
  const plain = new Uint8Array(64).map((_, i) => i & 0xff);
  const p = "img/pictures/0123456789abcdef";
  const enc = C.enkit(plain, p, 16);
  eq(C.readKeyByte(enc), 16);
  const back = C.dekit(enc, p);
  eq(Buffer.from(back).toString("hex"), Buffer.from(plain).toString("hex"));
});

test("isEncrypted is false for a plain buffer", () => {
  assert(!C.isEncrypted(new TextEncoder().encode("function f(){}")));
});

test("dekit returns input unchanged when not encrypted", () => {
  const plain = new TextEncoder().encode("function f(){}");
  eq(Buffer.from(C.dekit(plain, "js/x.js")).toString("utf8"), "function f(){}");
});

// json-diff

const J = loadLib(["app/js/libs/json-diff.js"]).JsonDiff;

console.log("\njson-diff:");

test("identical documents produce no ops", () => {
  eq(J.diff({ a: 1 }, { a: 1 }).length, 0);
});

test("changed scalar produces one replace", () => {
  const ops = J.diff({ a: 1, b: 2 }, { a: 9, b: 2 });
  eq(ops.length, 1);
  eq(ops[0].op, "replace");
  eq(ops[0].path, "/a");
  eq(ops[0].value, 9);
});

test("new key produces add, dropped key produces remove", () => {
  const ops = J.diff({ a: 1 }, { b: 2 });
  eq(ops.length, 2);
  eq(ops.filter((o) => o.op === "add")[0].path, "/b");
  eq(ops.filter((o) => o.op === "remove")[0].path, "/a");
});

test("same-length array diffs element-wise", () => {
  const ops = J.diff({ a: [1, 2, 3] }, { a: [1, 5, 3] });
  eq(ops.length, 1);
  eq(ops[0].path, "/a/1");
  eq(ops[0].value, 5);
});

test("length change replaces the whole array", () => {
  const ops = J.diff({ a: [1, 2, 3] }, { a: [1, 2] });
  eq(ops.length, 1);
  eq(ops[0].op, "replace");
  eq(ops[0].path, "/a");
  eq(JSON.stringify(ops[0].value), "[1,2]");
});

test("keys needing pointer escaping round-trip", () => {
  // Both keys must actually CHANGE, or diff() short-circuits on the equal
  // value and the escape/unescape path for that key is never exercised.
  const a = { "a/b": 1, "c~d": 2 };
  const b = { "a/b": 9, "c~d": 5 };
  const ops = J.diff(a, b);
  eq(ops.length, 2);
  eq(
    ops
      .map((o) => o.path)
      .sort()
      .join(","),
    "/a~1b,/c~0d",
  );
  // Round-tripping through apply() is what proves unesc() mirrors esc():
  // a wrong unescape order would rebuild the literal key "c~0d" instead.
  eq(JSON.stringify(J.apply(a, ops)), JSON.stringify(b));
});

test("apply reconstructs b from a for a nested document", () => {
  const a = { m: { events: [{ id: 1, x: 4 }, null], name: "old" }, n: 3 };
  const b = { m: { events: [{ id: 1, x: 7 }, null], name: "new" }, extra: true };
  eq(JSON.stringify(J.apply(a, J.diff(a, b))), JSON.stringify(b));
});

test("apply does not mutate its input, at depth", () => {
  // Nested on purpose: a shallow clone would pass a flat {x:1} fixture.
  const a = { m: { x: 1 }, list: [1, 2] };
  J.apply(a, J.diff(a, { m: { x: 2 }, list: [1, 2, 3] }));
  eq(a.m.x, 1);
  eq(a.list.length, 2);
});

test("null is distinguished from a missing key", () => {
  const ops = J.diff({ a: null }, { a: 0 });
  eq(ops.length, 1);
  eq(ops[0].op, "replace");
});

// mod-package

const P = loadLib(["app/js/libs/mod-package.js"]).ModPackage;

console.log("\nmod-package:");

// Independent CRC-32 oracle: a from-scratch implementation, deliberately not
// sharing code with the lib's own CRC_TABLE, so a bug shared between writer
// and this "check" can't cancel out.
function refCrc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

atest("writeZip then readZip round-trips a compressible entry", async () => {
  const data = new TextEncoder().encode("x".repeat(4096));
  const zip = await P.writeZip([{ name: "a/b.txt", data }]);
  const back = await P.readZip(zip);
  eq(back.size, 1);
  eq(Buffer.from(back.get("a/b.txt")).toString("utf8"), "x".repeat(4096));

  // Risk #5: filenames must be flagged UTF-8 (general-purpose bit 11), in
  // BOTH the local header (offset 6) and the central directory copy
  // (offset 8 relative to the CD entry).
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  eq(dv.getUint16(6, true) & 0x0800, 0x0800, "local header must set the UTF-8 general-purpose bit");
  const cdOffset = dv.getUint32(zip.length - 6, true);
  eq(dv.getUint16(cdOffset + 8, true) & 0x0800, 0x0800, "central directory must set the UTF-8 general-purpose bit");
});

atest("writeZip stores an incompressible entry uncompressed, consistently in both headers", async () => {
  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) data[i] = (i * 97 + 31) & 0xff;
  const zip = await P.writeZip([{ name: "r.bin", data }]);
  // method field of the first local header lives at offset 8
  eq(zip[8] | (zip[9] << 8), 0);

  // Risk #2: the store fallback (method 0, comp size == uncompressed size)
  // must ALSO be correct in the central directory entry, not just the local
  // header: writing method 8 in one and 0 in the other is the classic bug.
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const cdOffset = dv.getUint32(zip.length - 6, true);
  eq(dv.getUint32(cdOffset, true), 0x02014b50, "central directory signature");
  eq(dv.getUint16(cdOffset + 10, true), 0, "central directory method must also be store (0)");
  eq(dv.getUint32(cdOffset + 16, true), refCrc32(data), "central directory CRC must be correct too");
  eq(dv.getUint32(cdOffset + 20, true), data.length, "central directory compressed size must equal the stored size");

  const back = await P.readZip(zip);
  eq(Buffer.from(back.get("r.bin")).toString("hex"), Buffer.from(data).toString("hex"));
});

atest("a hand-computed CRC-32 and Node's own zlib independently confirm the archive is well-formed", async () => {
  // The naive version of this test only re-decodes the archive with our own
  // readZip, which proves nothing about interop with a real ZIP consumer
  // (the eventual target is a Rust zip crate). This version treats Node's
  // zlib and a from-scratch CRC-32 as independent oracles and reads the
  // header fields by hand instead of trusting the round-trip.
  const zlib = require("zlib");
  const data = new TextEncoder().encode("hello mod");
  const zip = await P.writeZip([{ name: "m.txt", data }]);
  const expectedCrc = refCrc32(data);

  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Risk #1: CRC-32 is computed over the UNCOMPRESSED data, and appears
  // identically in the local header (offset 14) and the central directory.
  eq(dv.getUint32(14, true), expectedCrc, "local header CRC must match an independently computed CRC-32");
  const cdOffset = dv.getUint32(zip.length - 6, true);
  eq(dv.getUint32(cdOffset + 16, true), expectedCrc, "central directory CRC must match the local header CRC");

  // Hand-extract the raw deflate stream using only fields we just validated
  // ourselves, and feed it to Node's zlib, bypassing our own readZip.
  const method = dv.getUint16(8, true);
  const compSize = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  const body = Buffer.from(zip.subarray(start, start + compSize));
  const inflated = method === 8 ? zlib.inflateRawSync(body) : body;
  eq(inflated.toString("utf8"), "hello mod", "Node's own zlib must agree the payload decodes to the original text");

  // Our own reader must agree too.
  const back = await P.readZip(zip);
  eq(Buffer.from(back.get("m.txt")).toString("utf8"), "hello mod");
});

atest(
  "readZip uses the LOCAL header's extra-field length when locating entry data, not the central directory's",
  async () => {
    // Risk #3: real-world zip tools routinely carry a different extra field
    // between an entry's local header and its central directory copy (e.g.
    // an Info-ZIP UT/UX timestamp extra present only in the local header).
    // writeZip never produces this itself (both copies always write extra
    // length 0), so no round-trip test of our own writer against our own
    // reader can ever catch a reader that used the WRONG extra-field length
    // and read entry data a few bytes off. Build a minimal hand-crafted ZIP
    // with mismatched extra-field lengths to prove readZip gets this right.
    const name = Buffer.from("x.txt", "utf8");
    const payload = Buffer.from("HELLO", "utf8");
    const localExtra = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]); // 4 bytes, local header only
    const crc = refCrc32(payload);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(payload.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(localExtra.length, 28); // 4, differs from the CD's 0 below

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10); // method: store
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(payload.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // central directory copy has NO extra field
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(0, 42); // offset of local header

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length + name.length, 12);
    eocd.writeUInt32LE(lh.length + name.length + localExtra.length + payload.length, 16);
    eocd.writeUInt16LE(0, 20);

    const zipBuf = Buffer.concat([lh, name, localExtra, payload, cd, name, eocd]);
    const back = await P.readZip(new Uint8Array(zipBuf));
    eq(Buffer.from(back.get("x.txt")).toString("utf8"), "HELLO");
  },
);

atest("build then parse preserves the manifest and the payloads", async () => {
  const payloads = new Map([["f/aabbccdd11223344", new TextEncoder().encode("PNGDATA")]]);
  const bytes = await P.build({
    id: "my-mod",
    name: "My Mod",
    author: "kidev",
    version: "1.2.0",
    description: "d",
    icon: new TextEncoder().encode("ICON"),
    saves: "isolated",
    update: { github: "o/r" },
    theme: [{ name: "theme/index.html", data: new TextEncoder().encode("<p>hi</p>") }],
    variants: [
      {
        base: { label: "v3.0.8", fingerprint: { files: 2, digest: "sha256:ab" } },
        files: [{ rel: "js/x.js", enc: false, type: "verbatim", payload: "f/aabbccdd11223344" }],
        stats: { patched: 0, added: 1, replaced: 0, deleted: 0, unchanged: 1 },
      },
    ],
    payloads,
  });
  const { manifest, entries } = await P.parse(bytes);
  eq(manifest.format, "tcoaal-mod/4");
  eq(manifest.id, "my-mod");
  eq(manifest.saves, "isolated");
  eq(manifest.update.github, "o/r");
  eq(manifest.theme.entry, "theme/index.html");
  eq(manifest.variants.length, 1);
  eq(Buffer.from(entries.get("f/aabbccdd11223344")).toString("utf8"), "PNGDATA");
  eq(Buffer.from(entries.get("theme/index.html")).toString("utf8"), "<p>hi</p>");
  assert(entries.has("README.txt"), "README.txt must be present");

  // Risk #6: build's entry order is specified exactly, mod.json first (so a
  // consumer can read the manifest without buffering the whole archive),
  // then icon.png, then theme entries, then sorted f/<sha16> payloads, then
  // README.txt last. entries is populated in central-directory order, which
  // mirrors write order, so this is a direct check of the written order.
  eq(
    JSON.stringify(Array.from(entries.keys())),
    JSON.stringify(["mod.json", "icon.png", "theme/index.html", "f/aabbccdd11223344", "README.txt"]),
    "entry order must match the spec exactly",
  );
});

atest("an online placeholder carries the mod's face and none of its content", async () => {
  const bytes = await P.build({
    id: "my-mod",
    name: "My Mod",
    author: "kidev",
    version: "1.2.0",
    description: "d",
    icon: new TextEncoder().encode("ICON"),
    saves: "isolated",
    update: null,
    theme: [{ name: "theme/index.html", data: new TextEncoder().encode("<p>hi</p>") }],
    variants: [],
    payloads: new Map(),
    online: { github: "o/r" },
  });
  const { manifest, entries } = await P.parse(bytes);
  eq(manifest.online.github, "o/r");
  eq(manifest.variants.length, 0, "a placeholder describes no base");
  // The face: what the installer needs to render the modder's own page before
  // anything has been downloaded.
  eq(manifest.id, "my-mod");
  eq(manifest.name, "My Mod");
  eq(manifest.version, "1.2.0");
  eq(manifest.icon, "icon.png");
  eq(manifest.theme.entry, "theme/index.html");
  // The content: none of it.
  assert(
    !Array.from(entries.keys()).some((k) => k.indexOf("f/") === 0),
    "a placeholder must carry no payload entries",
  );
  assert(
    Buffer.from(entries.get("README.txt")).toString("utf8").indexOf("ONLINE") !== -1,
    "the README must say the file installs nothing on its own",
  );
});

atest("online is omitted unless a source was actually given", async () => {
  const spec = {
    id: "my-mod",
    name: "My Mod",
    author: "",
    version: "1.0.0",
    description: "",
    icon: null,
    saves: "isolated",
    update: null,
    theme: [],
    variants: [{ base: { label: "v1", fingerprint: {} }, files: [], stats: {} }],
    payloads: new Map(),
  };
  const plain = (await P.parse(await P.build(spec))).manifest;
  assert(!("online" in plain), "no online key without a source");
  const empty = (await P.parse(await P.build({ ...spec, online: {} }))).manifest;
  assert(!("online" in empty), "an empty source object is not a source");
});

// tcoaal-mod/3 is a strict subset of /4 (no copy entries, no from), so a
// package built before the format grew still installs.
atest("parse still reads a tcoaal-mod/3 package", async () => {
  const zip = await P.writeZip([
    {
      name: "mod.json",
      data: new TextEncoder().encode(JSON.stringify({ format: "tcoaal-mod/3", variants: [] })),
    },
  ]);
  eq((await P.parse(zip)).manifest.format, "tcoaal-mod/3");
});

atest("parse rejects a foreign format string instead of guessing", async () => {
  const zip = await P.writeZip([
    {
      name: "mod.json",
      data: new TextEncoder().encode(JSON.stringify({ format: "tcoaal-mod/5" })),
    },
  ]);
  let err = null;
  try {
    await P.parse(zip);
  } catch (e) {
    err = e;
  }
  assert(err !== null, "parse must reject an unknown format");
  assert(
    /tcoaal-mod\/5/.test(String(err.message)),
    "the error must name the offending format, got: " + (err && err.message),
  );
});

atest("readZip returns payloads that do not alias the input buffer", async () => {
  // A stored (method 0) entry is the aliasing-prone path: its bytes sit in
  // the archive verbatim, so a subarray() view would track later edits.
  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) data[i] = (i * 97 + 31) & 0xff;
  const zip = await P.writeZip([{ name: "r.bin", data }]);
  const back = await P.readZip(zip);
  const before = Buffer.from(back.get("r.bin")).toString("hex");
  zip.fill(0);
  eq(Buffer.from(back.get("r.bin")).toString("hex"), before);
});

atest("build omits update when no source was given", async () => {
  const bytes = await P.build({
    id: "m", name: "M", author: "", version: "1.0.0", description: "",
    icon: null, saves: "isolated", update: null, theme: [],
    variants: [{ base: { label: "b", fingerprint: {} }, files: [], stats: {} }],
    payloads: new Map(),
  });
  const { manifest } = await P.parse(bytes);
  assert(!("update" in manifest), "update must be absent, not null");
});

// mod-diff (comparison core)

const D = loadLib([
  "app/js/libs/tcoaal-codec.js",
  "app/js/libs/json-diff.js",
  "app/js/libs/mod-package.js",
  "app/js/libs/mod-diff-worker.js",
]).ModDiff;

// Shared by Task 13 too: a Source backed by a plain in-memory Map of
// rel -> Uint8Array, mirroring the {list(), read()} contract compare()/
// fingerprint() consume.
function memSource(map) {
  return {
    list: async () => Array.from(map.keys()).sort(),
    read: async (rel) => map.get(rel),
  };
}

const HASHED = "data/be1a37535e921f91";

console.log("\nmod-diff compare:");

atest("identical trees produce no files, comparing DECRYPTED bytes (risk 1 + 2)", async () => {
  // base and mod hold the SAME plaintext but DIFFERENT on-disk encodings:
  // full encryption (keyByte 0) vs. a partial encryption of only the first
  // 3 bytes. Their raw bytes differ (the keyByte header byte differs, and
  // the partial one leaves its tail unencrypted) even though both decrypt
  // back to the identical plaintext. A comparator that diffed ciphertext
  // instead of decrypted bytes would wrongly treat this as a change, i.e.
  // leak base-game content into the package (risk 1's legal premise).
  const plain = new TextEncoder().encode('{"a":1}');
  const baseEnc = C.enkit(plain, HASHED, 0);
  const modEnc = C.enkit(plain, HASHED, 3);
  assert(
    Buffer.from(baseEnc).toString("hex") !== Buffer.from(modEnc).toString("hex"),
    "test setup must produce different raw bytes for the same plaintext",
  );
  const payloads = new Map();
  const r = await D.compare(memSource(new Map([[HASHED, baseEnc]])), memSource(new Map([[HASHED, modEnc]])), payloads, () => {});
  eq(r.files.length, 0);
  eq(r.stats.unchanged, 1);
  // Not just "no entry returned": the payload map itself must stay empty,
  // or an unchanged base file's bytes would sit orphaned in the package.
  eq(payloads.size, 0, "an unchanged file must register no payload");
});

atest("a changed data file becomes a patch, not a copy, with enc/key from the BASE header", async () => {
  // base and mod are encrypted with DIFFERENT keyByte values (5 vs 0) so the
  // patch entry's enc/key fields prove which header they were read from.
  // Rule 5 says the patch entry carries the BASE file's enc/key (the loader
  // re-encrypts a patched file using the base file's own convention), and a
  // test where both sides share the same keyByte can't catch base/mod
  // swapped.
  const base = C.enkit(new TextEncoder().encode('{"a":1,"big":"SECRET-BASE-TEXT"}'), HASHED, 5);
  const mod = C.enkit(new TextEncoder().encode('{"a":2,"big":"SECRET-BASE-TEXT"}'), HASHED, 0);
  const payloads = new Map();
  const r = await D.compare(memSource(new Map([[HASHED, base]])), memSource(new Map([[HASHED, mod]])), payloads, () => {});
  eq(r.files.length, 1);
  eq(r.files[0].type, "patch");
  assert(typeof r.files[0].enc === "boolean", "enc must be a boolean, never omitted, on a non-delete entry");
  eq(r.files[0].enc, true);
  eq(r.files[0].key, 5, "key must come from the BASE file's header, not the modded file's");
  eq(r.files[0].ops.length, 1);
  eq(r.files[0].ops[0].path, "/a");
  eq(payloads.size, 0, "a patch never registers a payload");
  eq(JSON.stringify(r.files).indexOf("SECRET-BASE-TEXT"), -1, "unchanged content must never appear in the output");
});

atest("a new plain file becomes a verbatim payload", async () => {
  const payloads = new Map();
  const mod = new Map([["js/plugins/Mine.js", new TextEncoder().encode("var a=1;")]]);
  const r = await D.compare(memSource(new Map()), memSource(mod), payloads, () => {});
  eq(r.files.length, 1);
  eq(r.files[0].type, "verbatim");
  assert(typeof r.files[0].enc === "boolean", "enc must be a boolean");
  eq(r.files[0].enc, false);
  assert(!("key" in r.files[0]), "key must be omitted when enc is false");
  eq(payloads.size, 1);
  eq(Buffer.from(payloads.get(r.files[0].payload)).toString("utf8"), "var a=1;");
});

atest("a removed file becomes a delete carrying no other fields", async () => {
  const base = new Map([["img/x/0123456789abcdef", C.enkit(new TextEncoder().encode("P"), "img/x/0123456789abcdef", 0)]]);
  const r = await D.compare(memSource(base), memSource(new Map()), new Map(), () => {});
  eq(r.files.length, 1);
  eq(r.files[0].type, "delete");
  assert(!("enc" in r.files[0]) && !("key" in r.files[0]), "delete carries rel and type only");
});

atest("identical payload bytes in two places deduplicate", async () => {
  const payloads = new Map();
  const same = new TextEncoder().encode("SHARED");
  const mod = new Map([["js/a.js", same], ["js/b.js", same]]);
  const r = await D.compare(memSource(new Map()), memSource(mod), payloads, () => {});
  eq(r.files.length, 2);
  eq(payloads.size, 1);
  eq(r.files[0].payload, r.files[1].payload);
});

atest("a non-JSON change becomes verbatim, not a patch, with enc/key from the MOD header", async () => {
  // base and mod again use DIFFERENT keyByte values (0 vs 3) so the verbatim
  // entry's enc/key fields prove they were read from the MOD's header, per
  // rule 6, the mirror-image check of the patch test above.
  const p = "img/pictures/0123456789abcdef";
  const base = C.enkit(new Uint8Array([1, 2, 3]), p, 0);
  const mod = C.enkit(new Uint8Array([1, 2, 4]), p, 3);
  const payloads = new Map();
  const r = await D.compare(memSource(new Map([[p, base]])), memSource(new Map([[p, mod]])), payloads, () => {});
  eq(r.files[0].type, "verbatim");
  eq(r.files[0].enc, true);
  eq(r.files[0].key, 3, "key must come from the MODDED file's header, not the base's");
  eq(payloads.size, 1);
});

atest("a JSON file re-serialized without semantic change is dropped", async () => {
  // The modder's editor re-saved the file: different key order and spacing,
  // same document. Rule 4 cannot catch this, since the decrypted bytes really
  // do differ, so the zero-op patch must be dropped by rule 5 instead.
  const base = C.enkit(new TextEncoder().encode('{"a":1,"b":[2,3]}'), HASHED, 0);
  const mod = C.enkit(new TextEncoder().encode('{\n  "b": [2, 3],\n  "a": 1\n}'), HASHED, 0);
  assert(
    Buffer.from(base).toString("hex") !== Buffer.from(mod).toString("hex"),
    "fixture is void unless the two encodings really differ on disk",
  );
  const payloads = new Map();
  const r = await D.compare(
    memSource(new Map([[HASHED, base]])),
    memSource(new Map([[HASHED, mod]])),
    payloads,
    () => {},
  );
  eq(r.files.length, 0, "a zero-op patch must not become a manifest entry");
  eq(payloads.size, 0, "and must not register a payload");
  eq(r.stats.unchanged, 1);
});

atest("a NEW encrypted file takes enc/key from its own header (rule 3)", async () => {
  // Rule 3 is the common case for a real mod: the modder adds an asset the
  // base game never had. keyByte 7 is arbitrary but must survive into the
  // entry, since the loader re-encrypts with it.
  const p = "img/pictures/aabbccddeeff0011";
  const plain = new TextEncoder().encode("NEWASSETBYTES");
  const mod = C.enkit(plain, p, 7);
  const payloads = new Map();
  const r = await D.compare(memSource(new Map()), memSource(new Map([[p, mod]])), payloads, () => {});
  eq(r.files.length, 1);
  eq(r.files[0].type, "verbatim");
  eq(r.files[0].enc, true);
  eq(r.files[0].key, 7, "a new file's enc/key come from the modded file itself");
  eq(payloads.size, 1);
  // The payload must be the DECRYPTED bytes, never the on-disk ciphertext.
  eq(
    Buffer.from(payloads.get(r.files[0].payload)).toString("utf8"),
    "NEWASSETBYTES",
  );
});

atest("onProgress is called at most once per 64 files", async () => {
  const total = 130;
  const mod = new Map();
  for (let i = 0; i < total; i++) mod.set("js/plugins/f" + i + ".js", new TextEncoder().encode("x"));
  const calls = [];
  const r = await D.compare(memSource(new Map()), memSource(mod), new Map(), (done, tot) => calls.push([done, tot]));
  eq(r.files.length, total);
  assert(
    calls.length <= Math.ceil(total / 64) + 1,
    `onProgress must fire at most once per 64 files, got ${calls.length} calls for ${total} files`,
  );
  const last = calls[calls.length - 1];
  eq(last[0], total);
  eq(last[1], total);
});

atest("fingerprint is stable and changes with content", async () => {
  const a = memSource(new Map([["x", new Uint8Array([1])]]));
  const b = memSource(new Map([["x", new Uint8Array([2])]]));
  const fa = await D.fingerprint(a);
  eq(fa.files, 1);
  eq((await D.fingerprint(a)).digest, fa.digest);
  assert((await D.fingerprint(b)).digest !== fa.digest, "digest must track content");
});

atest("fingerprint digest is order-independent: sorting happens before hashing", async () => {
  // Both sources carry identical content but list() returns paths in
  // OPPOSITE orders. If fingerprint hashed in list() order instead of
  // sorting first, these would produce different digests.
  const content = new Map([["a", new Uint8Array([1])], ["b", new Uint8Array([2])]]);
  function unsortedSource(order) {
    return { list: async () => order.slice(), read: async (rel) => content.get(rel) };
  }
  const forward = await D.fingerprint(unsortedSource(["a", "b"]));
  const reverse = await D.fingerprint(unsortedSource(["b", "a"]));
  eq(reverse.digest, forward.digest, "digest must not depend on the order list() returns paths in");
});

// mod-diff sources (idbSource; dirSource needs FileSystemDirectoryHandle,
// which Node does not have, so it is covered by the manual browser check
// in app/create.html's own task, not here)

console.log("\nmod-diff sources:");

// A fake IDBDatabase good enough for idbSource: getAllKeys + get on a store.
// get() hands back a COPY, because real IndexedDB structured-clones every
// result. A fixture that returned the stored reference would quietly excuse
// a caching layer that breaks the fresh-buffer-per-read contract classify()
// depends on.
function fakeDb(map) {
  function req(value) {
    var r = { onsuccess: null, onerror: null, result: value };
    setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0);
    return r;
  }
  return {
    transaction: () => ({
      objectStore: () => ({
        getAllKeys: () => req(Array.from(map.keys())),
        get: (k) => {
          const v = map.get(k);
          return req(v instanceof Uint8Array ? v.slice() : v);
        },
      }),
    }),
  };
}

atest("idbSource reads the plain namespace and skips reserved keys", async () => {
  const db = fakeDb(new Map([
    ["data/aaaa", new Uint8Array([1])],
    ["js/x.js", new Uint8Array([2])],
    ["mod:foo:data/aaaa", new Uint8Array([3])],
    ["gamever:v1:data/aaaa", new Uint8Array([4])],
    ["__active_mod__", "foo"],
  ]));
  const s = D.idbSource(db, "files", null);
  eq((await s.list()).join(","), "data/aaaa,js/x.js");
  eq((await s.read("js/x.js"))[0], 2);
});

atest("idbSource reads a parked version and strips its prefix", async () => {
  const db = fakeDb(new Map([
    ["data/aaaa", new Uint8Array([1])],
    ["gamever:v1:data/aaaa", new Uint8Array([4])],
    ["gamever:v1:js/y.js", new Uint8Array([5])],
  ]));
  const s = D.idbSource(db, "files", "v1");
  eq((await s.list()).join(","), "data/aaaa,js/y.js");
  eq((await s.read("data/aaaa"))[0], 4);
});

atest("idbSource hands back a fresh buffer on every read", async () => {
  // Real IndexedDB structured-clones each get(), so this holds today by
  // platform guarantee. The test exists to catch a future caching layer:
  // classify() stores an unencrypted file's bytes into payloads by
  // reference, so two reads sharing one array aliases two payload entries.
  const db = fakeDb(new Map([["js/plugins/a.js", new Uint8Array([1, 2, 3])]]));
  const s = D.idbSource(db, "files", null);
  const first = await s.read("js/plugins/a.js");
  const second = await s.read("js/plugins/a.js");
  assert(first !== second, "each read must return its own array");
  first[0] = 9;
  eq(second[0], 1, "mutating one read must not disturb another");
});

atest("memSource hands back a fresh buffer on every read", async () => {
  // classify() stores an unencrypted file's bytes into payloads BY REFERENCE,
  // so a source that returned the same array twice would alias two payload
  // entries onto one buffer.
  const bytes = new Uint8Array([1, 2, 3]);
  const s = D.memSource([["js/plugins/a.js", bytes]]);
  const first = await s.read("js/plugins/a.js");
  const second = await s.read("js/plugins/a.js");
  assert(first !== second, "each read must return its own array");
  assert(first !== bytes, "and never the caller's original array");
  first[0] = 9;
  eq(second[0], 1, "mutating one read must not disturb another");
  eq(bytes[0], 1, "nor the source's own copy");
});

atest("a pair supplying files instead of a modHandle still diffs", async () => {
  // The Firefox/Safari path: create.html unpacks a .zip and posts entries.
  const base = new Map([["js/plugins/a.js", new TextEncoder().encode("old")]]);
  const mod = D.memSource([["js/plugins/a.js", new TextEncoder().encode("new")]]);
  const payloads = new Map();
  const r = await D.compare(memSource(base), mod, payloads, () => {});
  eq(r.files.length, 1);
  eq(r.files[0].type, "verbatim");
  eq(payloads.size, 1);
});

// pe-resources

const PE = loadLib("app/js/libs/pe-resources.js").PeResources;

console.log("\npe-resources:");

// A synthetic PE with a single trailing .rsrc section is enough to exercise
// every header fix-up; the real stub is exercised in the integration task.
function fakePe() {
  const fileAlign = 512, sectAlign = 4096;
  const peOff = 128;
  const secOff0 = peOff + 24 + 240;
  const size = peOff + 24 + 240 + 40 + fileAlign;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  b[0] = 0x4d; b[1] = 0x5a;                     // "MZ"
  dv.setUint32(0x3c, peOff, true);              // e_lfanew
  dv.setUint32(peOff, 0x00004550, true);        // "PE\0\0"
  dv.setUint16(peOff + 6, 1, true);             // NumberOfSections
  dv.setUint16(peOff + 20, 240, true);          // SizeOfOptionalHeader
  dv.setUint16(peOff + 24, 0x20b, true);        // PE32+
  dv.setUint32(peOff + 24 + 32, sectAlign, true);
  dv.setUint32(peOff + 24 + 36, fileAlign, true);
  dv.setUint32(peOff + 24 + 56, 0x2000, true);  // SizeOfImage
  dv.setUint32(peOff + 24 + 60, secOff0 + 40, true); // SizeOfHeaders
  const secOff = peOff + 24 + 240;
  new TextEncoder().encodeInto(".rsrc", b.subarray(secOff, secOff + 8));
  dv.setUint32(secOff + 8, 16, true);           // VirtualSize
  dv.setUint32(secOff + 12, 0x1000, true);      // VirtualAddress
  dv.setUint32(secOff + 16, fileAlign, true);   // SizeOfRawData
  dv.setUint32(secOff + 20, secOff + 40, true); // PointerToRawData
  return b;
}

// The shape the real Windows stub has: MSVC always emits .reloc last, so
// .rsrc sits in the middle of the section table and cannot be grown in place.
function fakePeMsvc() {
  const fileAlign = 512, sectAlign = 4096;
  const peOff = 128;
  const secOff = peOff + 24 + 240;
  const b = new Uint8Array(3 * fileAlign);
  const dv = new DataView(b.buffer);
  b[0] = 0x4d; b[1] = 0x5a;                     // "MZ"
  dv.setUint32(0x3c, peOff, true);              // e_lfanew
  dv.setUint32(peOff, 0x00004550, true);        // "PE\0\0"
  dv.setUint16(peOff + 6, 2, true);             // NumberOfSections
  dv.setUint16(peOff + 20, 240, true);          // SizeOfOptionalHeader
  dv.setUint16(peOff + 24, 0x20b, true);        // PE32+
  dv.setUint32(peOff + 24 + 32, sectAlign, true);
  dv.setUint32(peOff + 24 + 36, fileAlign, true);
  dv.setUint32(peOff + 24 + 56, 0x3000, true);  // SizeOfImage
  dv.setUint32(peOff + 24 + 60, fileAlign, true); // SizeOfHeaders
  const names = [".rsrc", ".reloc"];
  for (let i = 0; i < names.length; i++) {
    const h = secOff + i * 40;
    new TextEncoder().encodeInto(names[i], b.subarray(h, h + 8));
    dv.setUint32(h + 8, 16, true);                       // VirtualSize
    dv.setUint32(h + 12, (i + 1) * sectAlign, true);     // VirtualAddress
    dv.setUint32(h + 16, fileAlign, true);               // SizeOfRawData
    dv.setUint32(h + 20, (i + 1) * fileAlign, true);     // PointerToRawData
  }
  // The stub's resource directory starts out pointing at the real .rsrc.
  dv.setUint32(peOff + 24 + 112 + 2 * 8, sectAlign, true);
  dv.setUint32(peOff + 24 + 112 + 2 * 8 + 4, 16, true);
  return b;
}

function fakePng(w) {
  // Not a real PNG; the rewriter treats icon payloads as opaque bytes.
  return new Uint8Array(20 + w).fill(0xab);
}

test("parse reads the section table and alignments", () => {
  const info = PE.parse(fakePe());
  eq(info.numSections, 1);
  eq(info.sections[0].name, ".rsrc");
  eq(info.sections[0].virtualAddress, 0x1000);
  eq(info.sectionAlignment, 4096);
  eq(info.fileAlignment, 512);
});

test("stamp round-trips the icon group", () => {
  const icons = [
    { width: 16, height: 16, png: fakePng(16) },
    { width: 256, height: 256, png: fakePng(256) },
  ];
  const out = PE.stamp(fakePe(), icons, "My Mod");
  const group = PE.readIconGroup(out);
  eq(group.length, 2);
  eq(group[0].width, 16);
  eq(group[1].width, 256);
  eq(group[1].bytes, 20 + 256);
});

test("stamp keeps the headers coherent", () => {
  const out = PE.stamp(fakePe(), [{ width: 32, height: 32, png: fakePng(32) }], "M");
  const info = PE.parse(out);
  const s = info.sections[0];
  eq(s.rawSize % info.fileAlignment, 0);
  eq(out.length, s.rawOffset + s.rawSize);
  assert(info.resourceDirRva === s.virtualAddress, "resource dir must point at .rsrc");
  assert(info.sizeOfImage >= s.virtualAddress + s.virtualSize, "SizeOfImage must cover .rsrc");
  const dv = new DataView(out.buffer);
  eq(dv.getUint32(info.peOffset + 88, true), 0);
  // VirtualSize (unpadded) and SizeOfRawData (padded to fileAlignment) must
  // both move together but stay distinct: rawSize is the smallest multiple
  // of fileAlignment that is >= virtualSize.
  assert(s.virtualSize <= s.rawSize, "virtualSize must not exceed the padded rawSize");
  assert(s.rawSize - info.fileAlignment < s.virtualSize, "rawSize must be the tight padding of virtualSize");
});

// A three-level resource tree written by hand from the PE/COFF struct sizes,
// with no help from pe-resources.js, so the carry-over tests below cannot pass
// merely because the writer and the reader share a misunderstanding. Each leaf
// gets its own type -> name -> language chain, which is all these tests need.
function handResourceTree(baseRva, leaves) {
  const DIR = 16, ENT = 8, DATA = 16;
  const sorted = leaves.slice().sort((a, b) => {
    const an = typeof a.type === "string", bn = typeof b.type === "string";
    if (an !== bn) return an ? -1 : 1;              // named entries come first
    return an ? (a.type < b.type ? -1 : 1) : a.type - b.type;
  });
  const named = sorted.filter((l) => typeof l.type === "string").length;

  let off = DIR + sorted.length * ENT;
  const typeDir = sorted.map(() => { const at = off; off += DIR + ENT; return at; });
  const nameDir = sorted.map(() => { const at = off; off += DIR + ENT; return at; });
  const dataAt = sorted.map(() => { const at = off; off += DATA; return at; });
  off = (off + 1) & ~1;
  const strAt = sorted.map((l) => {
    if (typeof l.type !== "string") return -1;
    const at = off;
    off = (off + 2 + l.type.length * 2 + 1) & ~1;
    return at;
  });
  let cursor = (off + 3) & ~3;
  const payAt = sorted.map((l) => { const at = cursor; cursor = (cursor + l.data.length + 3) & ~3; return at; });

  const out = new Uint8Array(cursor);
  const dv = new DataView(out.buffer);
  const dir = (at, count, namedCount) => {
    dv.setUint16(at + 12, namedCount, true);
    dv.setUint16(at + 14, count - namedCount, true);
  };
  dir(0, sorted.length, named);
  sorted.forEach((l, i) => {
    const eo = 16 + i * ENT;
    if (typeof l.type === "string") {
      dv.setUint32(eo, strAt[i] | 0x80000000, true);
      dv.setUint16(strAt[i], l.type.length, true);
      for (let c = 0; c < l.type.length; c++) {
        dv.setUint16(strAt[i] + 2 + c * 2, l.type.charCodeAt(c), true);
      }
    } else {
      dv.setUint32(eo, l.type, true);
    }
    dv.setUint32(eo + 4, typeDir[i] | 0x80000000, true);

    dir(typeDir[i], 1, 0);
    dv.setUint32(typeDir[i] + DIR, l.name, true);
    dv.setUint32(typeDir[i] + DIR + 4, nameDir[i] | 0x80000000, true);

    dir(nameDir[i], 1, 0);
    dv.setUint32(nameDir[i] + DIR, l.lang, true);
    dv.setUint32(nameDir[i] + DIR + 4, dataAt[i], true);

    dv.setUint32(dataAt[i], baseRva + payAt[i], true);
    dv.setUint32(dataAt[i] + 4, l.data.length, true);
    out.set(l.data, payAt[i]);
  });
  return out;
}

/** Read a resource tree back the same hand-rolled way, for the assertions. */
function handReadTree(bytes, rsrcRaw, baseRva) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  const name = (at) => {
    let s = "";
    for (let i = 0; i < dv.getUint16(rsrcRaw + at, true); i++) {
      s += String.fromCharCode(dv.getUint16(rsrcRaw + at + 2 + i * 2, true));
    }
    return s;
  };
  const walk = (at, path) => {
    const total = dv.getUint16(rsrcRaw + at + 12, true) + dv.getUint16(rsrcRaw + at + 14, true);
    for (let i = 0; i < total; i++) {
      const eo = rsrcRaw + at + 16 + i * 8;
      const nm = dv.getUint32(eo, true);
      const ptr = dv.getUint32(eo + 4, true);
      const id = nm & 0x80000000 ? name(nm & 0x7fffffff) : nm;
      if (ptr & 0x80000000) {
        walk(ptr & 0x7fffffff, path.concat([id]));
      } else {
        const size = dv.getUint32(rsrcRaw + ptr + 4, true);
        const at2 = rsrcRaw + (dv.getUint32(rsrcRaw + ptr, true) - baseRva);
        out.push({ path: path.concat([id]), data: bytes.subarray(at2, at2 + size) });
      }
    }
  };
  walk(0, []);
  return out;
}

/** fakePeMsvc() with a real resource tree written into its .rsrc section. */
function fakePeMsvcWithResources(leaves) {
  const b = fakePeMsvc();
  const dv = new DataView(b.buffer);
  const tree = handResourceTree(0x1000, leaves);
  assert(tree.length <= 512, "the fake .rsrc section holds one fileAlignment block");
  b.set(tree, 512); // .rsrc PointerToRawData
  dv.setUint32(128 + 24 + 112 + 2 * 8 + 4, tree.length, true); // resource dir size
  return b;
}

const MANIFEST = new TextEncoder().encode(
  '<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1"/>'
);

test("stamp carries over the resource types it does not rebuild", () => {
  // RT_MANIFEST is the one that matters: on Windows the application manifest
  // is what grants an app per-monitor DPI awareness, long path support and
  // common controls v6. Rebuilding .rsrc from scratch used to drop it, which
  // silently degraded every stamped installer.
  const src = fakePeMsvcWithResources([
    { type: 24, name: 1, lang: 1033, data: MANIFEST },
    { type: "MYTYPE", name: 7, lang: 1036, data: new Uint8Array([1, 2, 3, 4, 5]) },
    // A name that is also an Object.prototype key: the string table must not
    // mistake it for one it has already interned.
    { type: "toString", name: 1, lang: 1033, data: new Uint8Array([6, 6]) },
  ]);
  const out = PE.stamp(src, [{ width: 16, height: 16, png: fakePng(16) }], "My Mod");
  const info = PE.parse(out);
  const rsrc = info.sections[info.numSections - 1];
  const got = handReadTree(out, rsrc.rawOffset, rsrc.virtualAddress);
  const at = (p) => got.filter((l) => String(l.path) === String(p))[0];

  assert(at([24, 1, 1033]), "RT_MANIFEST must survive the rebuild");
  eq(
    Buffer.from(at([24, 1, 1033]).data).toString("hex"),
    Buffer.from(MANIFEST).toString("hex"),
    "and survive byte for byte"
  );
  assert(at(["MYTYPE", 7, 1036]), "a string-named type must survive too");
  eq(Buffer.from(at(["MYTYPE", 7, 1036]).data).toString("hex"), "0102030405");
  assert(at(["toString", 1, 1033]), "including one named like an Object.prototype key");
  eq(Buffer.from(at(["toString", 1, 1033]).data).toString("hex"), "0606");
  assert(at([3, 1, 1033]), "the new icon is still written");
  assert(at([14, 1, 1033]), "and its group");
  assert(at([16, 1, 1033]), "and the version block");
});

test("stamp replaces the icon and version resources it does rebuild", () => {
  // The flip side of carrying resources over: the types stamp() produces must
  // come from the caller, never from the stub, or a re-stamp would accumulate
  // two icon groups and the loader would pick whichever sorted first.
  const src = fakePeMsvcWithResources([
    { type: 3, name: 1, lang: 1033, data: new Uint8Array([0xde, 0xad]) },
    { type: 14, name: 1, lang: 1033, data: new Uint8Array([0xbe, 0xef]) },
    { type: 16, name: 1, lang: 1033, data: new Uint8Array([0xba, 0xad]) },
  ]);
  const out = PE.stamp(src, [{ width: 32, height: 32, png: fakePng(32) }], "My Mod");
  const info = PE.parse(out);
  const rsrc = info.sections[info.numSections - 1];
  const got = handReadTree(out, rsrc.rawOffset, rsrc.virtualAddress);
  eq(got.length, 3, "exactly one icon, one group and one version block");
  const icon = got.filter((l) => l.path[0] === 3)[0];
  eq(icon.data.length, 20 + 32, "the icon must be the one passed in, not the stub's");
  eq(PE.readIconGroup(out).length, 1);
});

test("with no icons, stamp keeps the stub's own icon instead of erasing it", () => {
  const stubIcon = new Uint8Array([9, 9, 9, 9]);
  const src = fakePeMsvcWithResources([
    { type: 3, name: 1, lang: 1033, data: stubIcon },
    { type: 14, name: 1, lang: 1033, data: new Uint8Array([0, 1, 1, 0]) },
    { type: 24, name: 1, lang: 1033, data: MANIFEST },
  ]);
  const out = PE.stamp(src, [], "Nameless Mod");
  const info = PE.parse(out);
  const rsrc = info.sections[info.numSections - 1];
  const got = handReadTree(out, rsrc.rawOffset, rsrc.virtualAddress);
  const icon = got.filter((l) => String(l.path) === String([3, 1, 1033]))[0];
  assert(icon, "the stub's icon must be carried over when none is supplied");
  eq(Buffer.from(icon.data).toString("hex"), "09090909");
  assert(got.filter((l) => l.path[0] === 16)[0], "the version block is still rewritten");
  assert(got.filter((l) => l.path[0] === 24)[0], "and the manifest still survives");
});

test("every directory the rebuild writes is sorted the way the loader searches", () => {
  // The loader binary-searches each level, so entries must be named-first and
  // then ascending by id. Carried-over types arrive in tree order, not sorted
  // order, so this is a real risk rather than a tautology.
  const src = fakePeMsvcWithResources([
    { type: 24, name: 1, lang: 1033, data: MANIFEST },
    { type: 10, name: 5, lang: 1033, data: new Uint8Array([7]) },
    { type: "ZZZ", name: 1, lang: 1033, data: new Uint8Array([8]) },
    { type: "AAA", name: 1, lang: 1033, data: new Uint8Array([9]) },
  ]);
  const out = PE.stamp(src, [{ width: 16, height: 16, png: fakePng(16) }], "M");
  const info = PE.parse(out);
  const rsrc = info.sections[info.numSections - 1];
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const named = dv.getUint16(rsrc.rawOffset + 12, true);
  const ided = dv.getUint16(rsrc.rawOffset + 14, true);
  eq(named, 2, "the two string-named types");
  eq(ided, 5, "RT_ICON, RT_GROUP_ICON, RT_RCDATA, RT_VERSION, RT_MANIFEST");
  const ids = [];
  for (let i = named; i < named + ided; i++) {
    ids.push(dv.getUint32(rsrc.rawOffset + 16 + i * 8, true));
  }
  eq(String(ids), String(ids.slice().sort((a, b) => a - b)), "id entries ascending");
  eq(String(ids), String([3, 10, 14, 16, 24]));
});

test("stamp appends a new section when .rsrc is not the last one", () => {
  // MSVC emits .reloc behind .rsrc, so the real stub can never be grown in
  // place: the rebuilt resources go into a section appended past the image,
  // and data directory 2 is repointed at it.
  const src = fakePeMsvc();
  const icons = [{ width: 16, height: 16, png: fakePng(16) }];
  const out = PE.stamp(src, icons, "My Mod");
  const info = PE.parse(out);

  eq(info.numSections, 3, "one section must have been added");
  const added = info.sections[2];
  eq(added.name, ".rsrc");
  eq(info.resourceDirRva, added.virtualAddress, "data directory 2 must name the new section");
  eq(info.resourceDirSize, added.virtualSize);
  eq(added.virtualAddress % info.sectionAlignment, 0, "new RVA must be SectionAlignment-aligned");
  eq(added.rawOffset % info.fileAlignment, 0, "new raw offset must be FileAlignment-aligned");
  assert(
    added.virtualAddress >= info.sections[1].virtualAddress + info.sections[1].rawSize,
    "the new section must start past .reloc"
  );
  eq(added.rawSize % info.fileAlignment, 0);
  eq(out.length, added.rawOffset + added.rawSize, "file must end with the new section");
  assert(
    info.sizeOfImage >= added.virtualAddress + added.virtualSize,
    "SizeOfImage must cover the new section"
  );
  eq(info.sizeOfImage % info.sectionAlignment, 0, "SizeOfImage must stay aligned");
  eq(PE.readIconGroup(out).length, 1, "the icon must read back out of the new section");

  // Everything the linker produced is left byte-identical, apart from the
  // header fields we rewrote: .reloc in particular must survive intact, since
  // the loader still relocates through it.
  const reloc = info.sections[1];
  eq(
    Buffer.from(out.subarray(reloc.rawOffset, reloc.rawOffset + reloc.rawSize)).toString("hex"),
    Buffer.from(src.subarray(reloc.rawOffset, reloc.rawOffset + reloc.rawSize)).toString("hex"),
    ".reloc bytes must be untouched"
  );
});

test("stamp refuses to append when the header has no room for a section entry", () => {
  const b = fakePeMsvc();
  const dv = new DataView(b.buffer);
  dv.setUint32(128 + 24 + 60, 128 + 24 + 240 + 2 * 40, true); // SizeOfHeaders: exactly full
  let threw = "";
  try { PE.stamp(b, [], "M"); } catch (e) { threw = e.message; }
  assert(/no room/.test(threw), "error must explain the header is full, got: " + threw);
});

// Independent-decode tests. These do NOT call PE.parse() or
// PE.readIconGroup() anywhere in the walk below the PE header. They compute
// every offset from the raw bytes using struct sizes cited from the PE/COFF
// spec (IMAGE_RESOURCE_DIRECTORY = 16 bytes, IMAGE_RESOURCE_DIRECTORY_ENTRY =
// 8 bytes, IMAGE_RESOURCE_DATA_ENTRY = 16 bytes). Their entire purpose is to
// catch a writer bug that a matching reader bug (readIconGroup, written by
// the same author against the same misunderstanding) would silently pass.

test("hand-decoded resource tree matches the spec, independent of parse()/readIconGroup()", () => {
  const DIR = 16, ENTRY = 8; // IMAGE_RESOURCE_DIRECTORY, ...DIRECTORY_ENTRY
  const icons = [
    { width: 16, height: 16, png: fakePng(16) },
    { width: 256, height: 256, png: fakePng(256) },
  ];
  const out = PE.stamp(fakePe(), icons, "Indie Mod");
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // MS-DOS / COFF header, decoded by hand
  eq(out[0], 0x4d, "MZ byte 0");
  eq(out[1], 0x5a, "MZ byte 1");
  const peOff = dv.getUint32(0x3c, true);
  eq(dv.getUint32(peOff, true), 0x00004550, "PE\\0\\0 signature");
  const numSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const optStart = peOff + 24;
  const magic = dv.getUint16(optStart, true);
  assert(magic === 0x10b || magic === 0x20b, "optional header magic must be PE32 or PE32+");

  // Section table: find .rsrc by hand, without reusing parse()'s helper
  const secTableStart = optStart + optSize;
  let rsrc = null;
  for (let i = 0; i < numSections; i++) {
    const h = secTableStart + i * 40;
    let name = "";
    for (let c = 0; c < 8 && out[h + c]; c++) name += String.fromCharCode(out[h + c]);
    if (name === ".rsrc") {
      rsrc = {
        virtualSize: dv.getUint32(h + 8, true),
        virtualAddress: dv.getUint32(h + 12, true),
        rawSize: dv.getUint32(h + 16, true),
        rawOffset: dv.getUint32(h + 20, true),
      };
    }
  }
  assert(rsrc, ".rsrc section must be present in the section table");

  // Data directory entry 2 (resource table): RVA/size must target .rsrc
  const ddOffset = optStart + (magic === 0x20b ? 112 : 96);
  const resourceEntryOff = ddOffset + 2 * 8;
  eq(dv.getUint32(resourceEntryOff, true), rsrc.virtualAddress, "data directory[2].RVA");
  eq(dv.getUint32(resourceEntryOff + 4, true), rsrc.virtualSize, "data directory[2].Size");

  // Checksum, relative to the optional header start (offset 64), zeroed
  eq(dv.getUint32(optStart + 64, true), 0, "checksum must be zeroed");

  // Resource tree root: RVA 0 of .rsrc == file offset rsrc.rawOffset
  const rootOff = rsrc.rawOffset;
  function readDir(at) {
    const named = dv.getUint16(at + 12, true);
    const ided = dv.getUint16(at + 14, true);
    const entries = [];
    for (let i = 0; i < named + ided; i++) {
      const eo = at + DIR + i * ENTRY;
      const idOrName = dv.getUint32(eo, true);
      const offRaw = dv.getUint32(eo + 4, true);
      entries.push({
        id: idOrName,
        isDir: !!(offRaw & 0x80000000),
        offset: offRaw & 0x7fffffff,
      });
    }
    return { named, ided, entries };
  }

  const root = readDir(rootOff);
  eq(root.named, 0, "root: no string-named entries (RT_ICON/GROUP_ICON/VERSION are all ID entries)");
  eq(root.ided, 3, "root: RT_ICON, RT_GROUP_ICON, RT_VERSION");
  eq(root.entries.map((e) => e.id).join(","), "3,14,16", "root entries sorted ascending by type id");
  root.entries.forEach((e) => assert(e.isDir, "every root entry must point at a subdirectory"));

  // RT_ICON (type 3) -> name entries 1..n, sorted ascending
  const iconType = root.entries.find((e) => e.id === 3);
  const iconNames = readDir(rootOff + iconType.offset);
  eq(iconNames.named, 0);
  eq(iconNames.ided, icons.length);
  eq(iconNames.entries.map((e) => e.id).join(","), "1,2", "icon name ids sorted ascending");

  // name 1 -> language dir -> single 0x0409 entry -> IMAGE_RESOURCE_DATA_ENTRY
  const name1 = iconNames.entries.find((e) => e.id === 1);
  assert(name1.isDir, "name-level entry must point at a language subdirectory");
  const langDir = readDir(rootOff + name1.offset);
  eq(langDir.named, 0);
  eq(langDir.ided, 1, "exactly one language: 0x0409");
  eq(langDir.entries[0].id, 0x0409, "language id must be 0x0409");
  assert(!langDir.entries[0].isDir, "the language entry must point at data, not another directory");

  const dataOff = rootOff + langDir.entries[0].offset;
  const rva = dv.getUint32(dataOff, true);
  const size = dv.getUint32(dataOff + 4, true);
  const codePage = dv.getUint32(dataOff + 8, true);
  const reserved = dv.getUint32(dataOff + 12, true);
  eq(size, icons[0].png.length, "data entry size must match the icon payload length");
  eq(codePage, 0);
  eq(reserved, 0);
  // The single most common hand-rolled-writer bug: emitting an RVA that is
  // actually just the offset within the section (section-relative) instead
  // of baseRva + offset (absolute). A section-relative RVA here would be a
  // small number (well under 0x1000); demand it be absolute and in-section.
  assert(rva >= rsrc.virtualAddress, "RVA must be absolute (>= baseRva), not section-relative: got " + rva);
  assert(rva < rsrc.virtualAddress + rsrc.virtualSize, "RVA must land inside the rebuilt .rsrc section");

  // RT_VERSION (type 16) -> name 1 -> language -> VS_VERSIONINFO payload
  const versionType = root.entries.find((e) => e.id === 16);
  const versionNames = readDir(rootOff + versionType.offset);
  eq(versionNames.ided, 1);
  const vName1 = versionNames.entries[0];
  eq(vName1.id, 1);
  const vLangDir = readDir(rootOff + vName1.offset);
  eq(vLangDir.entries[0].id, 0x0409);
  const vDataOff = rootOff + vLangDir.entries[0].offset;
  const vRva = dv.getUint32(vDataOff, true);
  assert(vRva >= rsrc.virtualAddress, "VS_VERSIONINFO RVA must also be absolute");
  const vFileOff = rsrc.rawOffset + (vRva - rsrc.virtualAddress);
  // VS_VERSIONINFO header: wLength(2) + wValueLength(2) + wType(2) = 6,
  // then szKey "VS_VERSION_INFO\0" (15 chars + NUL = 16 UTF-16LE code units
  // = 32 bytes) ends at 38, padded to a 4-byte boundary = 40. The
  // VS_FIXEDFILEINFO struct begins there.
  eq(dv.getUint32(vFileOff + 40, true), 0xfeef04bd, "VS_FIXEDFILEINFO signature at its spec-mandated offset");
});

test("stamp with no icons emits a version-only resource tree", () => {
  // A modder who supplies no icon still gets the product name stamped; the
  // RT_ICON and RT_GROUP_ICON subtrees are simply absent.
  const out = PE.stamp(fakePe(), [], "Nameless Mod");
  const dv = new DataView(out.buffer);
  const peOff = dv.getUint32(0x3c, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const secOff = peOff + 24 + optSize;
  const rsrcRaw = dv.getUint32(secOff + 20, true);
  // Root IMAGE_RESOURCE_DIRECTORY: 12 bytes of header, then the two counts.
  eq(dv.getUint16(rsrcRaw + 12, true), 0, "no named entries at the root");
  eq(dv.getUint16(rsrcRaw + 14, true), 1, "exactly one type: RT_VERSION");
  eq(dv.getUint32(rsrcRaw + 16, true), 16, "and that type id is RT_VERSION (16)");
  eq(PE.readIconGroup(out).length, 0);
});

test("an icon with no image data is refused", () => {
  let err = null;
  try {
    PE.stamp(fakePe(), [{ width: 16, height: 16, png: new Uint8Array(0) }], "X");
  } catch (e) {
    err = e;
  }
  assert(err !== null, "an empty icon payload must be refused");
  assert(/16px/.test(String(err.message)), "the error must name the offending icon: " + err.message);
});

test("a PE claiming more sections than it holds is refused", () => {
  const b = fakePe();
  new DataView(b.buffer).setUint16(new DataView(b.buffer).getUint32(0x3c, true) + 6, 99, true);
  let err = null;
  try {
    PE.parse(b);
  } catch (e) {
    err = e;
  }
  assert(err !== null, "a truncated section table must be refused");
  assert(/[Tt]runcated/.test(String(err.message)), "with a clear message, got: " + err.message);
});

test("hand-decoded GRPICONDIRENTRY: 256 is encoded as literal zero width/height bytes", () => {
  const DIR = 16, ENTRY = 8;
  const icons = [
    { width: 16, height: 16, png: fakePng(16) },
    { width: 256, height: 256, png: fakePng(256) },
  ];
  const out = PE.stamp(fakePe(), icons, "M");
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const optStart = peOff + 24;
  const optSize = dv.getUint16(peOff + 20, true);
  const secTableStart = optStart + optSize;
  const numSections = dv.getUint16(peOff + 6, true);
  let rsrc = null;
  for (let i = 0; i < numSections; i++) {
    const h = secTableStart + i * 40;
    let name = "";
    for (let c = 0; c < 8 && out[h + c]; c++) name += String.fromCharCode(out[h + c]);
    if (name === ".rsrc") {
      rsrc = { virtualAddress: dv.getUint32(h + 12, true), rawOffset: dv.getUint32(h + 20, true) };
    }
  }
  function readDir(at) {
    const ided = dv.getUint16(at + 14, true);
    const named = dv.getUint16(at + 12, true);
    const entries = [];
    for (let i = 0; i < named + ided; i++) {
      const eo = at + DIR + i * ENTRY;
      const offRaw = dv.getUint32(eo + 4, true);
      entries.push({ id: dv.getUint32(eo, true), isDir: !!(offRaw & 0x80000000), offset: offRaw & 0x7fffffff });
    }
    return entries;
  }
  const rootOff = rsrc.rawOffset;
  const grpType = readDir(rootOff).find((e) => e.id === 14); // RT_GROUP_ICON
  const grpName = readDir(rootOff + grpType.offset)[0];
  const grpLang = readDir(rootOff + grpName.offset)[0];
  const dataOff = rootOff + grpLang.offset;
  const rva = dv.getUint32(dataOff, true);
  const fileOff = rsrc.rawOffset + (rva - rsrc.virtualAddress);
  // ICONDIR: reserved(2) + type(2) + count(2) = 6 bytes, then 14-byte
  // GRPICONDIRENTRY records: width(1) height(1) colorCount(1) reserved(1)
  // planes(2) bitCount(2) bytesInRes(4) id(2).
  eq(dv.getUint16(fileOff + 4, true), 2, "ICONDIR count");
  const rec0 = fileOff + 6;
  const rec1 = fileOff + 6 + 14;
  eq(out[rec0], 16, "first icon width byte");
  eq(out[rec0 + 1], 16, "first icon height byte");
  eq(out[rec1], 0, "256-wide icon must encode width as literal 0");
  eq(out[rec1 + 1], 0, "256-tall icon must encode height as literal 0");
  eq(dv.getUint32(rec1 + 8, true), 20 + 256, "bytesInRes for the 256 icon");
  eq(dv.getUint16(rec1 + 12, true), 2, "GRPICONDIRENTRY id must be the RT_ICON name id (2)");
});

// icns

const I = loadLib("app/js/libs/icns.js").Icns;

console.log("\nicns:");

test("build emits an icns container parseable back", () => {
  const m = new Map([
    [128, new Uint8Array([1, 2, 3])],
    [256, new Uint8Array([4, 5])],
  ]);
  const out = I.build(m);
  eq(Buffer.from(out.subarray(0, 4)).toString("ascii"), "icns");
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  eq(dv.getUint32(4, false), out.length);
  const chunks = I.parse(out);
  eq(chunks.length, 2);
  eq(chunks[0].type, "ic07");
  eq(Buffer.from(chunks[0].data).toString("hex"), "010203");
  eq(chunks[1].type, "ic08");
});

test("build skips sizes with no png", () => {
  const one = I.parse(I.build(new Map([[512, new Uint8Array([9])]])));
  eq(one.length, 1);
  eq(one[0].type, "ic09");
});

test("build throws when the map is empty", () => {
  let threw = false;
  try {
    I.build(new Map());
  } catch (e) {
    threw = true;
  }
  assert(threw, "an empty icon set must be rejected");
});

// Hand-decode the emitted bytes with our own literal offset arithmetic and
// explicit byte-order assertions (reading out[i] one byte at a time, never a
// DataView) so a build/parse round trip using the SAME (wrong) endianness
// convention cannot slip through. This directly targets named risks 1-3 and 5.
test("build's container header is big-endian and the total length includes the 8-byte header itself", () => {
  const png128 = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]); // 4 bytes
  const out = I.build(new Map([[128, png128]]));

  // magic: literal ASCII bytes for "icns", no DataView involved.
  eq(out[0], 0x69, "magic byte 0 'i'");
  eq(out[1], 0x63, "magic byte 1 'c'");
  eq(out[2], 0x6e, "magic byte 2 'n'");
  eq(out[3], 0x73, "magic byte 3 's'");

  // Total file length = 8 (icns header) + 8 (chunk header) + 4 (payload) = 20.
  // Written big-endian: the high byte is at the LOWER address.
  const expectedTotal = 8 + 8 + png128.length;
  eq(expectedTotal, 20, "sanity: expected total is 20 bytes");
  eq(out.length, expectedTotal, "whole-file length must match the computed total exactly");
  eq(out[4], 0x00, "total length byte 0 (MSB) big-endian");
  eq(out[5], 0x00, "total length byte 1");
  eq(out[6], 0x00, "total length byte 2");
  eq(out[7], expectedTotal & 0xff, "total length byte 3 (LSB) big-endian");

  // First (only) chunk starts at offset 8: 4-byte type tag, exactly ASCII,
  // no NUL terminator and no UTF-16 expansion.
  eq(out[8], "i".charCodeAt(0), "chunk type byte 0");
  eq(out[9], "c".charCodeAt(0), "chunk type byte 1");
  eq(out[10], "0".charCodeAt(0), "chunk type byte 2");
  eq(out[11], "7".charCodeAt(0), "chunk type byte 3 ('ic07' for the 128 slot)");

  // Chunk length INCLUDES its own 8-byte header: 8 + 4 = 12. Big-endian.
  eq(out[12], 0x00, "chunk length byte 0 (MSB)");
  eq(out[13], 0x00, "chunk length byte 1");
  eq(out[14], 0x00, "chunk length byte 2");
  eq(out[15], 12, "chunk length byte 3 (LSB) = 8 header + 4 data bytes");

  // Payload follows immediately, untouched.
  eq(out[16], 0xaa, "payload byte 0");
  eq(out[17], 0xbb, "payload byte 1");
  eq(out[18], 0xcc, "payload byte 2");
  eq(out[19], 0xdd, "payload byte 3");

  eq(out.length, 20, "no trailing bytes past the single chunk");
});

test("TYPES is in ascending size order with the exact expected type tags", () => {
  eq(I.TYPES.length, 6);
  const expected = [
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    // 1024 is ic10 (512x512@2x). ic13 is 128x128@2x, i.e. a 256-pixel image.
    ["ic10", 1024],
  ];
  for (let i = 0; i < expected.length; i++) {
    eq(I.TYPES[i].type, expected[i][0], `TYPES[${i}].type`);
    eq(I.TYPES[i].size, expected[i][1], `TYPES[${i}].size`);
  }
  for (let i = 1; i < I.TYPES.length; i++) {
    assert(I.TYPES[i].size > I.TYPES[i - 1].size, "TYPES must be strictly ascending by size");
  }
});

test("build emits chunks in TYPES (ascending size) order regardless of Map insertion order", () => {
  const m = new Map([
    [1024, new Uint8Array([1])],
    [32, new Uint8Array([2])],
    [256, new Uint8Array([3])],
  ]);
  const chunks = I.parse(I.build(m));
  eq(chunks.length, 3);
  eq(chunks[0].type, "ic11");
  eq(chunks[1].type, "ic08");
  eq(chunks[2].type, "ic10");
});

test("build with a single size only produces exactly one chunk", () => {
  const chunks = I.parse(I.build(new Map([[1024, new Uint8Array([7, 7])]])));
  eq(chunks.length, 1);
  eq(chunks[0].type, "ic10");
  eq(Buffer.from(chunks[0].data).toString("hex"), "0707");
});

test("parse refuses a file that is not an .icns", () => {
  // Task 8 points parse() at files inside a prebuilt .app bundle. Without a
  // magic check it would scan any file's bytes from offset 8 as chunk headers
  // and return whatever looked plausible.
  const notIcns = new TextEncoder().encode("PK\x03\x04nonsense padding bytes here");
  let err = null;
  try {
    I.parse(notIcns);
  } catch (e) {
    err = e;
  }
  assert(err !== null, "a non-icns buffer must be refused");
  assert(/icns magic/.test(String(err.message)), "with a clear message, got: " + err.message);
  let short = null;
  try {
    I.parse(new Uint8Array([0x69, 0x63, 0x6e]));
  } catch (e) {
    short = e;
  }
  assert(short !== null, "a buffer shorter than the header must be refused too");
});

test("build ignores map sizes that are not in TYPES", () => {
  const chunks = I.parse(
    I.build(
      new Map([
        [999, new Uint8Array([1])],
        [64, new Uint8Array([2])],
      ]),
    ),
  );
  eq(chunks.length, 1, "the unrecognized size (999) must not be emitted as a chunk");
  eq(chunks[0].type, "ic12");
});

// stub-stamp

// Loaded with its dependencies in the SAME context (like the mod-diff block
// above), not stub-stamp.js alone: stampMac/stampWindows resolve ModPackage/
// PeResources off the shared global at call time, exactly as they will in
// the browser where create.html loads every lib as a plain <script> onto one
// window. A single-lib load would leave those undefined and stampMac would
// throw on its first ModPackage.readZip() call.
const S = loadLib([
  "app/js/libs/mod-package.js",
  "app/js/libs/pe-resources.js",
  "app/js/libs/stub-stamp.js",
]).StubStamp;

console.log("\nstub-stamp:");

test("attachTrailer then readTrailer round-trips", () => {
  const stub = new Uint8Array([1, 2, 3, 4]);
  const payload = new TextEncoder().encode("PAYLOAD-BYTES");
  const out = S.attachTrailer(stub, payload);
  eq(out.length, 4 + payload.length + 16);
  eq(Buffer.from(out.subarray(0, 4)).toString("hex"), "01020304");
  eq(Buffer.from(S.readTrailer(out)).toString("utf8"), "PAYLOAD-BYTES");
});

test("readTrailer returns null without the magic", () => {
  eq(S.readTrailer(new Uint8Array(64)), null);
});

atest("verifyStub throws on a hash mismatch and names the artifact", async () => {
  let msg = "";
  try {
    await S.verifyStub(new Uint8Array([1]), "0".repeat(64), "win-x64.exe");
  } catch (e) { msg = e.message; }
  assert(msg.indexOf("win-x64.exe") !== -1, "error must name the artifact, got: " + msg);
});

test("stampWindows stamps the icon first, then attaches the trailer", () => {
  // Order matters and is not observable from the outside: PeResources.stamp()
  // rebuilds the file up to the end of .rsrc, so a trailer attached first
  // would be discarded and the exe would ship with the right icon and no mod.
  const PE2 = loadLib("app/js/libs/pe-resources.js").PeResources;
  const payload = new TextEncoder().encode("MOD-PAYLOAD");
  const out = S.stampWindows(fakePe(), {
    payload: payload,
    icons: [{ width: 16, height: 16, png: fakePng(16) }],
    name: "My Mod",
  });
  eq(Buffer.from(S.readTrailer(out)).toString("utf8"), "MOD-PAYLOAD");
  eq(PE2.readIconGroup(out).length, 1, "the icon must survive alongside the trailer");
});

test("stampWindows refuses a stub whose .rsrc is not SectionAlignment-aligned", () => {
  // PeResources.stamp()'s SizeOfImage math assumes this invariant. A real
  // linker always satisfies it; a stub that does not would produce an exe
  // Windows refuses to load, so fail loudly here instead.
  const b = fakePe();
  const dv = new DataView(b.buffer);
  const peOff = dv.getUint32(0x3c, true);
  const secOff = peOff + 24 + dv.getUint16(peOff + 20, true);
  dv.setUint32(secOff + 12, 0x1001, true); // VirtualAddress, deliberately odd
  let msg = "";
  try {
    S.stampWindows(b, { payload: new Uint8Array([1]), icons: [], name: "X" });
  } catch (e) { msg = e.message; }
  assert(msg !== "", "a misaligned .rsrc must be refused");
  assert(/align/i.test(msg), "the error must explain the alignment problem, got: " + msg);
});

atest("verifyStub resolves for a stub whose hash matches", async () => {
  // The path every real download takes. The mismatch branch alone would not
  // catch a comparison that always threw.
  const bytes = new TextEncoder().encode("stub bytes");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await S.verifyStub(bytes, hex, "win-x64.exe");
});

atest("stampMac rewrites only the expected entries", async () => {
  const P2 = loadLib("app/js/libs/mod-package.js").ModPackage;
  const plist = '<plist><dict><key>CFBundleName</key><string>TCOAAL Mod Loader</string>' +
    '<key>CFBundleDisplayName</key><string>TCOAAL Mod Loader</string>' +
    '<key>CFBundleIdentifier</key><string>app.tcoaal.loader</string></dict></plist>';
  const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 9, 9, 9]);
  const stubZip = await P2.writeZip([
    { name: "L.app/Contents/MacOS/loader", data: macho },
    { name: "L.app/Contents/Info.plist", data: new TextEncoder().encode(plist) },
    { name: "L.app/Contents/Resources/icon.icns", data: new TextEncoder().encode("OLD") },
  ]);
  const out = await S.stampMac(stubZip, {
    payload: new TextEncoder().encode("MODZIP"),
    icnsBytes: new TextEncoder().encode("NEWICNS"),
    name: "My Mod",
    bundleId: "app.tcoaal.mod.my-mod",
  });
  const back = await P2.readZip(out);
  eq(Buffer.from(back.get("L.app/Contents/MacOS/loader")).toString("hex"),
     Buffer.from(macho).toString("hex"));
  eq(Buffer.from(back.get("L.app/Contents/Resources/icon.icns")).toString("utf8"), "NEWICNS");
  eq(Buffer.from(back.get("L.app/Contents/Resources/payload.tcoaalmod")).toString("utf8"), "MODZIP");
  const p = Buffer.from(back.get("L.app/Contents/Info.plist")).toString("utf8");
  assert(p.indexOf("<string>My Mod</string>") !== -1, "CFBundleName must be replaced");
  assert(p.indexOf("app.tcoaal.mod.my-mod") !== -1, "CFBundleIdentifier must be replaced");
});

// create.html pure helpers
//
// create.html is a single HTML file, so there is nothing to loadLib(). These
// pull the named function sources straight out of the file and evaluate them,
// which is enough for the helpers that touch neither the DOM nor IndexedDB.
// The page is otherwise only verifiable by hand, and the active-game labelling
// bug this locks down was invisible to every other check.

console.log("\ncreate.html helpers:");

const CREATE_HTML = fs.readFileSync(path.join(__dirname, "..", "app/create.html"), "utf8");

function fnSource(name) {
  const start = CREATE_HTML.indexOf("function " + name + "(");
  assert(start !== -1, "create.html has no function named " + name);
  // Brace-match from the body's opening brace to its close.
  let i = CREATE_HTML.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let j = i; j < CREATE_HTML.length; j++) {
    if (CREATE_HTML[j] === "{") depth++;
    else if (CREATE_HTML[j] === "}") {
      depth--;
      if (depth === 0) { end = j + 1; break; }
    }
  }
  assert(end !== -1, "unbalanced braces reading " + name + " out of create.html");
  return CREATE_HTML.slice(start, end);
}

// deps: other top-level create.html functions to lift into the same context.
// Almost every helper here is self-contained; the exception is a rule that
// two of them have to agree on (validateGithub delegates to isGithubSlug, so
// the form's validator and .git discovery cannot drift apart), and lifting
// the pair together is how that is tested without duplicating the rule.
function createFn(name, deps) {
  const src = (deps || []).map(fnSource).concat([fnSource(name)]).join("\n");
  const ctx = vm.createContext({ TextDecoder, TextEncoder, console, URL });
  vm.runInContext(src + "\nthis.__fn = " + name + ";", ctx);
  return ctx.__fn;
}

test("mainJsVersion reads GAME_VERSION out of a main.js buffer", () => {
  const mainJsVersion = createFn("mainJsVersion");
  const js = 'var x=1;\nGAME_VERSION = "3.0.13";\n';
  eq(mainJsVersion(new TextEncoder().encode(js)), "3.0.13");
  eq(mainJsVersion(new TextEncoder().encode("GAME_VERSION='2.0.9'")), "2.0.9");
  eq(mainJsVersion(null), null);
  eq(mainJsVersion(new TextEncoder().encode("no version here")), null);
});

test("the active game's label is NOT looked up in the parked registry", () => {
  // loader.html's switchActiveGameVersion deletes the active id from
  // __game_versions__ (loader.html:7262), so labelFor(reg, activeId) can
  // never resolve and every ordinary single-import user would fall through
  // to the "imported game" placeholder, which no real version string can
  // equal, so the freshness check would then warn on every selection of the
  // newest build. The active label must come from activeGameLabel().
  assert(
    CREATE_HTML.indexOf("labelFor(parsed, activeId)") === -1,
    "create.html must not derive the ACTIVE game's label from the parked registry",
  );
  assert(
    /const act = await activeGameLabel\(db\)/.test(CREATE_HTML),
    "create.html must derive the active label via activeGameLabel()",
  );
});

test("the freshness dialog resets returnValue before every open", () => {
  // A native <dialog> closed by Escape does not set a new returnValue: it
  // keeps the previous one. This dialog is a reused singleton, so without a
  // reset, an Escape after any earlier Confirm resolves as "ok" and silently
  // keeps a base the modder just tried to back out of.
  const open = CREATE_HTML.indexOf("$modal.showModal()");
  assert(open !== -1, "create.html no longer calls showModal()");
  const before = CREATE_HTML.slice(0, open);
  assert(
    /\$modal\.returnValue\s*=\s*""\s*;[\s\S]{0,400}$/.test(before),
    "returnValue must be reset immediately before showModal()",
  );
});

test("validateId accepts the stated 3-40 character bound and rejects outside it (risk 5)", () => {
  const validateId = createFn("validateId");
  eq(validateId("abc"), null, "3 chars, the minimum, must be accepted");
  eq(validateId("a".repeat(40)), null, "40 chars, the maximum, must be accepted");
  assert(typeof validateId("ab") === "string", "2 chars must be rejected");
  assert(typeof validateId("a".repeat(41)) === "string", "41 chars must be rejected");
  eq(validateId("my-cool-mod-2"), null);
  assert(typeof validateId("-leading-dash") === "string", "leading dash must be rejected");
  assert(typeof validateId("trailing-dash-") === "string", "trailing dash must be rejected");
  assert(typeof validateId("Has-Upper") === "string", "uppercase must be rejected");
});

test("validateVersion requires a semantic version", () => {
  const validateVersion = createFn("validateVersion");
  eq(validateVersion("1.0.0"), null);
  eq(validateVersion("1.2.3-beta.1"), null);
  assert(typeof validateVersion("1.0") === "string");
  assert(typeof validateVersion("v1.0.0") === "string");
  assert(typeof validateVersion("") === "string");
});

test("validateGithub is optional but validates the owner/repo shape when filled", () => {
  const validateGithub = createFn("validateGithub", ["isGithubSlug", "githubSlugFromUrl", "githubRepoSlug"]);
  eq(validateGithub(""), null, "empty is valid, update is optional");
  eq(validateGithub("octocat/hello-world"), null);
  eq(validateGithub("o-k/r_1.x"), null, "dots and underscores are legal in a repo name");
  assert(typeof validateGithub("not-a-repo") === "string");
  assert(typeof validateGithub("octocat/") === "string");
  // The field ends up inside a URL the native loader fetches, so a segment
  // that climbs out of that URL's path must not validate.
  assert(typeof validateGithub("../evil") === "string", "must reject a .. owner");
  assert(typeof validateGithub("octocat/..") === "string", "must reject a .. repo");
  assert(typeof validateGithub("-bad/repo") === "string", "owners cannot start with a hyphen");
  assert(typeof validateGithub("a/b/c") === "string", "must reject a third segment");
});

test("githubRepoSlug reads owner/repo out of whatever a modder pastes", () => {
  const slug = createFn("githubRepoSlug", ["isGithubSlug", "githubSlugFromUrl"]);
  eq(slug("octocat/hello-world"), "octocat/hello-world");
  eq(slug("  octocat/hello-world  "), "octocat/hello-world");
  eq(slug("https://github.com/octocat/hello-world"), "octocat/hello-world");
  eq(slug("https://github.com/octocat/hello-world/releases/latest"), "octocat/hello-world");
  eq(slug("git@github.com:octocat/hello-world.git"), "octocat/hello-world");
  eq(slug(""), null);
  eq(slug("https://example.com/octocat/hello-world"), null, "not GitHub");
  eq(slug("https://github.com/octocat/hello-world/releases/download/v1/m.tcoaalmod"), null, "a file, not a repo");
});

test("the repo field fills the online installer's link until it is edited by hand", () => {
  // Wiring, not a pure function: assert the pieces are there.
  assert(CREATE_HTML.indexOf("function syncOnlineUrlFromGithub()") !== -1);
  assert(/getElementById\("meta-update-github"\)[\s\S]{0,40}\n\s*\$gh\.addEventListener\("input", syncOnlineUrlFromGithub\)/.test(CREATE_HTML) ||
    CREATE_HTML.indexOf('$gh.addEventListener("input", syncOnlineUrlFromGithub)') !== -1);
  assert(CREATE_HTML.indexOf("current !== _autoOnlineUrl") !== -1, "a hand-typed link must win");
  // The self-hosted update file is the advanced route, behind a disclosure.
  assert(/<details class="field" id="meta-update-manifest-box">[\s\S]*?id="meta-update-manifest"/.test(CREATE_HTML));
});

test("validateManifestUrl is optional but requires https when filled", () => {
  const validateManifestUrl = createFn("validateManifestUrl");
  eq(validateManifestUrl(""), null, "empty is valid, update is optional");
  eq(validateManifestUrl("https://example.com/manifest.json"), null);
  assert(typeof validateManifestUrl("http://example.com/manifest.json") === "string", "http must be rejected");
  assert(typeof validateManifestUrl("not a url") === "string");
});

test("onlineSource reads a repo link as {github} and a file link as {url}", () => {
  const onlineSource = createFn("onlineSource", ["isGithubSlug", "githubSlugFromUrl", "githubRepoSlug"]);
  // Naming a REPO means "the newest release", so the modder can ship a new
  // version without handing out a new installer.
  eq(onlineSource("octocat/hello-world").github, "octocat/hello-world", "owner/repo");
  eq(onlineSource("https://github.com/octocat/hello-world").github, "octocat/hello-world");
  eq(onlineSource("https://github.com/octocat/hello-world/").github, "octocat/hello-world");
  eq(onlineSource("https://github.com/octocat/hello-world/releases").github, "octocat/hello-world");
  eq(
    onlineSource("https://github.com/octocat/hello-world/releases/latest").github,
    "octocat/hello-world",
    "the latest-release page names the repo, not a file",
  );
  // Naming a FILE means that exact file, GitHub or not. This is the case the
  // two above must never swallow: a release asset URL lives under github.com
  // and still has to stay a direct download.
  const asset =
    "https://github.com/octocat/hello-world/releases/download/v1.0.0/mod.tcoaalmod";
  eq(onlineSource(asset).url, asset, "a release asset is a file, not a repo");
  assert(!onlineSource(asset).github, "a release asset must not resolve to {github}");
  eq(onlineSource("https://example.com/m.tcoaalmod").url, "https://example.com/m.tcoaalmod");
});

test("onlineSource refuses an empty, plain-http or unparseable link", () => {
  const onlineSource = createFn("onlineSource", ["isGithubSlug", "githubSlugFromUrl", "githubRepoSlug"]);
  assert(typeof onlineSource("").error === "string", "empty must be an error, not a source");
  assert(typeof onlineSource("   ").error === "string", "blank must be an error");
  assert(
    typeof onlineSource("http://example.com/m.tcoaalmod").error === "string",
    "a mod is executable content: http must be refused",
  );
  assert(typeof onlineSource("not a url").error === "string");
});

test("findZipGameRoot: a wrapper folder above the game still roots correctly", () => {
  const f = createFn("findZipGameRoot");
  eq(f(["data/x", "js/rpg_core.js"]), "");
  eq(f(["www/data/x", "www/js/a.js"]), "www/");
  // The point of the change: a zip of the folder that HOLDS the game.
  eq(f(["modname/game/www/data/x", "modname/game/www/js/a.js"]), "modname/game/www/");
  // A zip's directory entries ("Mod-main/www/") must not confuse the walk.
  eq(
    f(["Mod-main/", "Mod-main/www/", "Mod-main/www/audio/", "Mod-main/www/data/x", "Mod-main/www/img/y"]),
    "Mod-main/www/",
  );
  // A shallower but game-less data/ must not outrank the real root.
  eq(f(["docs/data/notes.md", "game/www/data/x", "game/www/js/a.js"]), "game/www/");
  eq(f(["readme.txt"]), null);
  // A www/ with no data/ inside it still roots inside www/.
  eq(f(["wrap/www/readme.txt"]), "wrap/www/");
});

test("isSafeRelPath rejects any path escaping the theme/ prefix (risk 4)", () => {
  const isSafeRelPath = createFn("isSafeRelPath");
  assert(isSafeRelPath("index.html"));
  assert(isSafeRelPath("css/theme.css"));
  assert(isSafeRelPath("assets/bg-1_final.png"), "ordinary names must still pass");
  assert(!isSafeRelPath("../secrets.txt"), "must reject a .. segment");
  assert(!isSafeRelPath("a/../b"), "must reject a .. segment anywhere in the path");
  assert(!isSafeRelPath("/etc/passwd"), "must reject a leading-slash absolute path");
  assert(!isSafeRelPath("a//b"), "must reject an empty segment from a doubled slash");
  assert(!isSafeRelPath("a\\b"), "must reject a backslash");
  assert(!isSafeRelPath(""), "must reject the empty string");
});

test("isSafeRelPath rejects a Windows drive-relative segment (zip slip)", () => {
  // "theme/C:/evil.dll" is the whole attack: a naive join (Rust's
  // PathBuf::push among them) DISCARDS everything accumulated so far when
  // the pushed component is drive-relative, so the write lands outside the
  // mod's folder. Linux and macOS both allow ":" in a filename, so a theme
  // folder authored there carries the segment through happily.
  const isSafeRelPath = createFn("isSafeRelPath");
  assert(!isSafeRelPath("C:/evil.dll"), "must reject a leading drive letter");
  assert(!isSafeRelPath("a/C:/evil.dll"), "must reject a drive letter mid-path");
  assert(!isSafeRelPath("file:stream"), "must reject an NTFS alternate-data-stream colon");
});

test("isSafeRelPath rejects Windows-illegal and reserved names", () => {
  const isSafeRelPath = createFn("isSafeRelPath");
  assert(!isSafeRelPath("what?.png"), "must reject a Windows-illegal character");
  assert(!isSafeRelPath('quote".css'), "must reject a quote");
  assert(!isSafeRelPath("CON"), "must reject a reserved DOS device name");
  assert(!isSafeRelPath("lpt1.txt"), "must reject a reserved name with an extension");
  assert(!isSafeRelPath("dir/nul"), "must reject a reserved name in any segment");
  // Windows silently strips a trailing space or dot, so two distinct entries
  // would collide into one file on extraction.
  assert(!isSafeRelPath("trailing /x"), "must reject a trailing space in a segment");
  assert(!isSafeRelPath("trailing./x"), "must reject a trailing dot in a segment");
});

test("modPackageFilename builds <id>-<version>.tcoaalmod from validated fields only (risk 6)", () => {
  const modPackageFilename = createFn("modPackageFilename");
  eq(modPackageFilename("my-cool-mod", "1.0.0"), "my-cool-mod-1.0.0.tcoaalmod");
  eq(modPackageFilename("a", "1.2.3-beta.1"), "a-1.2.3-beta.1.tcoaalmod");
});

test("sanitizeInstallerName strips filesystem-special characters meta.name can still carry", () => {
  // validateName (Task 10) bounds only meta.name's LENGTH, not its
  // character set. Unlike modPackageFilename()'s id/version, this is free
  // text that can still reach a download filename unsanitised.
  const sanitizeInstallerName = createFn("sanitizeInstallerName");
  eq(sanitizeInstallerName("My Cool Mod"), "My Cool Mod");
  eq(sanitizeInstallerName("a/b"), "a_b");
  eq(sanitizeInstallerName("a\\b"), "a_b");
  eq(sanitizeInstallerName('Mod: "Special" <Edition>'), "Mod_ _Special_ _Edition_");
  eq(sanitizeInstallerName(""), "Mod", "an empty name must still produce a usable filename");
  eq(sanitizeInstallerName("   "), "Mod", "a whitespace-only name must not produce a blank filename");
});

test("buildSummaryLine matches the task brief's exact format", () => {
  const buildSummaryLine = createFn("buildSummaryLine");
  const stats = { patched: 2, added: 3, replaced: 1, deleted: 4, unchanged: 500 };
  eq(
    buildSummaryLine("Steam v3.0.13", stats),
    "Steam v3.0.13: 2 patched, 3 added, 1 replaced, 4 deleted (500 unchanged excluded)",
  );
  // A project-space overlay: the files that are the game's own under the
  // mod's names are called out, since that is the number a modder would
  // otherwise read as "my game shipped inside my mod".
  const line = buildSummaryLine("Steam v3.0.13", { ...stats, mode: "overlay", untouched: 1500, copied: 438 });
  assert(/438 files are the game's own under the names your mod uses/.test(line), line);
  assert(/carries none of them/.test(line), line);
  assert(!/re-hashed/.test(line), "the old translation sentence must be gone");
  // The bundled plugins are named, so the modder can see the registry got
  // what they ticked.
  const shipped = buildSummaryLine("Steam v3.0.13", { ...stats, bundled: ["MouseControl", "UnlockAll"] });
  assert(/Ships with MouseControl, UnlockAll registered in js\/plugins\.js\./.test(shipped), shipped);
  assert(!/Ships with/.test(buildSummaryLine("x", { ...stats, bundled: [] })), "empty list says nothing");
});

// The installer wears the mod's author by default: the preset theme's JS
// puts it on the version line, the preview hands it over like the loader
// does, and typing it re-renders the preview like the name does.
test("the theme and its preview show the mod's author by default", () => {
  const js = CREATE_HTML.slice(CREATE_HTML.indexOf("const THEME_JS = `"), CREATE_HTML.indexOf("const PRESET_CSS = {"));
  assert(/by\.id = "author"/.test(js) && /" by " \+ me\.author/.test(js), "THEME_JS renders #author from me.author");
  assert(/author: \$\{JSON\.stringify\(author\)\}/.test(CREATE_HTML), "the preview's ListMods carries the author");
  assert(/\["meta-name", "meta-version", "meta-author"\]/.test(CREATE_HTML), "the author field re-renders the preview");
  const ui = fs.readFileSync(path.join(__dirname, "..", "tools/desktop/user/ui/index.html"), "utf8");
  assert(/by\.id = "author"/.test(ui) && /me\.author/.test(ui), "the built-in theme shows it too");
});

// The checklist create.html offers is the README's install table: every
// standalone plugin under plugins/ is offered, from the file the README
// names, and the two third-party plugins come from their browser mods.
test("the bundled plugin catalog offers every standalone plugin and nothing that does not exist", () => {
  // The list lives in js/libs/bundled-plugins.js, shared with the CI
  // builder (tools/build-mod.js); create.html reads it from there.
  assert(
    /const BUNDLED_PLUGINS = window\.BundledPlugins;/.test(CREATE_HTML) &&
      /<script src="js\/libs\/bundled-plugins\.js"><\/script>/.test(CREATE_HTML),
    "create.html loads the shared catalog",
  );
  const box = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "app/js/libs/bundled-plugins.js"), "utf8"),
    { self: box },
  );
  const catalog = box.BundledPlugins;
  assert(Array.isArray(catalog) && catalog.length, "catalog found");
  const standalone = fs
    .readdirSync(path.join(__dirname, "..", "plugins"))
    .filter((f) => /\.js$/.test(f))
    .sort();
  const offered = catalog
    .filter((p) => p.src.indexOf("plugins/") === 0)
    .map((p) => p.src.slice("plugins/".length))
    .sort();
  eq(offered.join(","), standalone.join(","), "every standalone plugin is offered, none invented");
  catalog.forEach((p) => {
    const rel = p.src.replace(/\?.*$/, "");
    assert(fs.existsSync(path.join(__dirname, "..", rel)), "source exists: " + rel);
    eq(p.file, "js/plugins/" + path.basename(rel), "lands under js/plugins/ as itself");
    // The registry name is the file's name, which is what PluginManager
    // loads by.
    eq(p.name, path.basename(rel, ".js"));
    assert(p.title && p.author && p.blurb && p.description, "fully described: " + p.name);
  });
  // The two browser mods are fetched past the installed copy in IDB.
  catalog
    .filter((p) => p.src.indexOf("mods/") === 0)
    .forEach((p) => assert(/\?fresh=$/.test(p.src), "network-fresh: " + p.src));
});

// The stub sizes used to be printed on the Linux button, which meant every
// modder who opened the Build pane fetched stubs.json for a number that only
// ever said "this download is large". The three buttons are equals now, and
// nothing here fetches anything before it is clicked.
test("the build pane offers the installers without pricing them first", () => {
  assert(
    !/formatStubSize/.test(CREATE_HTML),
    "no size formatter should be left behind",
  );
  const section = CREATE_HTML.slice(CREATE_HTML.indexOf('id="stamp-section"'));
  assert(
    !/stubs\.json|loadStubs\(\)\s*\n?\s*\.then/.test(
      CREATE_HTML.slice(
        CREATE_HTML.indexOf("function showStampSection"),
        CREATE_HTML.indexOf("function showStampSection") + 900,
      ),
    ),
    "showStampSection must not fetch stubs.json just to label a button",
  );
  for (const os of ["windows", "mac", "linux"]) {
    assert(
      section.indexOf('id="stamp-' + os + '-btn"') !== -1,
      "the " + os + " installer button must be in the stamp section",
    );
  }
  // Nor does it single out the modder's own platform: three installers, no
  // commentary on which machine the page happens to be open on.
  for (const gone of ["ownPlatform", "is-yours", "for your system", "data-os"]) {
    assert(
      CREATE_HTML.indexOf(gone) === -1,
      'no per-platform marker should be left behind ("' + gone + '")',
    );
  }
});

// A release republishes /stub/win-x64.exe (and the other two) with new bytes
// under the SAME url. Cached by url, the next stamp is served the PREVIOUS
// release's binary and fails its checksum against the new stubs.json, which
// is exactly the "checksum mismatch" a modder hit on Windows and Linux while
// macOS, the one stub they had never stamped before, worked. The cache key
// carries the digest, so new bytes simply miss.
test("a cached stub is keyed by its digest, not by its url", () => {
  const stubCacheKey = createFn("stubCacheKey");
  eq(
    stubCacheKey({ file: "win-x64.exe", sha256: "abc123" }),
    "/stub/win-x64.exe?sha256=abc123",
  );
  // Two releases of the same file are two different cache entries.
  assert(
    stubCacheKey({ file: "macos.zip", sha256: "aaa" }) !==
      stubCacheKey({ file: "macos.zip", sha256: "bbb" }),
    "the same file with new bytes must not reuse the old entry",
  );
  // And the stale entry does not linger: loadStubs prunes whatever the
  // current stubs.json no longer names.
  const loadStubs = CREATE_HTML.slice(
    CREATE_HTML.indexOf("async function loadStubs("),
    CREATE_HTML.indexOf("async function fetchStub("),
  );
  assert(
    /pruneStubCache\(_stubs\)/.test(loadStubs),
    "loadStubs must prune cache entries the manifest no longer names",
  );
});

// The behaviour that follows from that key, exercised against a fake Cache
// Storage: a cached copy that does not match its manifest entry must be
// re-downloaded inside the same click, and only bytes fresh off the network
// may ever raise "checksum mismatch" at the modder.
atest("fetchStub re-downloads a bad cached stub instead of reporting corruption", async () => {
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const good = Buffer.from("MZ this is the new release's stub");
  const stale = Buffer.from("MZ the PREVIOUS release's stub");
  const entry = { file: "win-x64.exe", sha256: sha(good), format: P.FORMAT };

  function makeCtx(served) {
    const store = new Map();
    let fetches = 0;
    const body = (buf) => ({
      ok: true,
      _buf: buf,
      clone() { return body(buf); },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
    });
    const cache = {
      async match(key) { return store.has(key) ? body(store.get(key)) : undefined; },
      async put(key, res) { store.set(key, Buffer.from(await res.arrayBuffer())); },
      async delete(key) { return store.delete(key); },
      async keys() { return [...store.keys()].map((u) => ({ url: u })); },
    };
    const ctx = vm.createContext({
      Uint8Array,
      STUB_CACHE: "tcoaal-stubs",
      ModPackage: { FORMAT: P.FORMAT },
      caches: { async open() { return cache; } },
      async fetch() { fetches++; return served ? body(served) : { ok: false }; },
      StubStamp: {
        async verifyStub(bytes, expected, name) {
          const got = sha(Buffer.from(bytes));
          if (got !== String(expected).toLowerCase())
            throw new Error('Checksum mismatch for "' + name + '"');
        },
      },
    });
    vm.runInContext(
      fnSource("stubCacheKey") + "\nasync " + fnSource("fetchStub") +
        "\nthis.__fetchStub = fetchStub; this.__key = stubCacheKey;",
      ctx,
    );
    return { ctx, store, seed: (b) => store.set(ctx.__key(entry), b), fetched: () => fetches };
  }

  // Cold cache: one download, verified, and kept for next time.
  const cold = makeCtx(good);
  eq(Buffer.from(await cold.ctx.__fetchStub(entry)).toString(), good.toString());
  eq(cold.fetched(), 1, "a cold cache downloads once");
  eq(cold.store.size, 1, "the verified bytes are cached");

  // A cached entry holding the wrong bytes (a truncated download, or a
  // hand-edited cache) self-heals: deleted, re-downloaded, returned.
  const stalec = makeCtx(good);
  stalec.seed(stale);
  eq(Buffer.from(await stalec.ctx.__fetchStub(entry)).toString(), good.toString());
  eq(stalec.fetched(), 1, "the bad cached copy must be replaced from the network");

  // Only genuinely bad network bytes reach the modder as an error, and they
  // are never cached, so the next click is not doomed to repeat it.
  const bad = makeCtx(stale);
  let threw = null;
  try { await bad.ctx.__fetchStub(entry); } catch (e) { threw = e; }
  assert(threw && /Checksum mismatch/.test(threw.message), "bad network bytes must raise");
  eq(bad.store.size, 0, "bytes that failed the checksum must never be cached");

  // A stub embeds its own loader, which reads one package format. A set
  // published for an older format (or before stubs.json recorded one) would
  // be stamped with a payload its own loader refuses; refuse first, and say
  // why, before a single byte is fetched.
  for (const format of ["tcoaal-mod/3", undefined]) {
    const old = makeCtx(good);
    let refused = null;
    try { await old.ctx.__fetchStub({ ...entry, format }); } catch (e) { refused = e; }
    assert(refused && /republished/.test(refused.message), "an old-format stub must be refused: " + (refused && refused.message));
    eq(old.fetched(), 0, "nothing is downloaded for a stub that cannot carry the package");
  }
});

test("findZipGameRoot matches ModDiff.dirSource's single-level root rule (risk 4)", () => {
  const findZipGameRoot = createFn("findZipGameRoot");
  // The modder zipped the game's www/ folder directly: "data" sits at the
  // zip's own top level, same as dirSource rooting at the handle itself.
  eq(findZipGameRoot(["data/System.json", "img/x.png"]), "");
  // The modder zipped the game's install root, one level above www/: a
  // "www" entry at the top level with no "data" there, same as dirSource
  // rooting one level inside "www/".
  eq(findZipGameRoot(["www/data/System.json", "www/img/x.png"]), "www/");
  // "data" takes priority over "www" when (unusually) both appear at the
  // top level, same order dirSource itself checks in.
  eq(findZipGameRoot(["data/x", "www/y"]), "");
  // A wrapper folder around the game is normal in a zip (it is what every
  // "Download ZIP" button produces), so unlike dirSource's single-level
  // rule this searches the whole archive; see findZipGameRoot's own note.
  eq(findZipGameRoot(["readme.txt", "MyMod/data/System.json"]), "MyMod/");
  // Nothing game-shaped anywhere is still nothing.
  eq(findZipGameRoot(["readme.txt", "docs/notes.md"]), null);
  eq(findZipGameRoot([]), null);
});

test("findZipGameRoot roots INSIDE the wrapper, never one level off it (risk 4)", () => {
  // Named risk 4's failure mode: if the zip path rooted one level off, every
  // stripped path would carry a leftover "www/" (or be missing the data/img
  // top level), and every base file would look added AND deleted at once -
  // the copyright leak this tool exists to prevent. The wrapper support
  // above is only safe because the root it returns always has data/ (or, at
  // worst, www/) directly inside it: the stripped paths start at "data/...",
  // exactly as they do for a zip made from inside www/.
  const findZipGameRoot = createFn("findZipGameRoot");
  const names = ["MyMod/www/data/System.json", "MyMod/www/img/x.png", "MyMod/readme.txt"];
  const root = findZipGameRoot(names);
  eq(root, "MyMod/www/");
  eq(names[0].slice(root.length), "data/System.json");
  eq(names[1].slice(root.length), "img/x.png");
});

// Deployment wiring (Task 12)
//
// app/sw.js gates offline shell files through TWO independent, hand-
// maintained lists: APP_SHELL (what precacheShell() fetches into the cache
// on install) and a second `logicalPath === "..."` whitelist inside the
// fetch handler that routes requests through networkFirstWithShellFallback.
// APP_SHELL uses leading-slash URLs ("/js/libs/foo.js"); the fetch
// whitelist uses bare logicalPath values with no leading slash
// ("js/libs/foo.js"). A file listed in only one of the two works online but
// silently fails offline (Task 1's review finding for tcoaal-codec.js).
// Both lists must carry every new app/create.html file.

console.log("\ndeployment wiring:");

const NEW_SHELL_FILES = [
  "/create.html",
  "/favicon.png",
  "/js/libs/codemirror.js",
  "/js/libs/codemirror.css",
  "/js/libs/tcoaal-codec.js",
  "/js/libs/json-diff.js",
  "/js/libs/mod-package.js",
  "/js/libs/mod-diff-worker.js",
  "/js/libs/pe-resources.js",
  "/js/libs/icns.js",
  "/js/libs/stub-stamp.js",
];

// Both list checks slice sw.js down to the one construct they are about.
// Searching the whole 2000-line file would let an entry that landed in the
// WRONG list still pass, which is the exact mistake these tests exist to
// catch, since the two lists take different path forms.
function appShellSrc(sw) {
  const a = sw.indexOf("const APP_SHELL");
  const b = sw.indexOf("async function precacheShell");
  assert(a !== -1 && b > a, "could not locate the APP_SHELL array in sw.js");
  return sw.slice(a, b);
}

function fetchWhitelistSrc(sw) {
  // The whitelist is the `logicalPath === "..." || ...` chain guarding
  // networkFirstWithShellFallback. Anchor on its first entry and run to the
  // end of the condition.
  const a = sw.indexOf('logicalPath === "loader.html"');
  assert(a !== -1, "could not locate the fetch whitelist in sw.js");
  const b = sw.indexOf(")", a);
  assert(b > a, "could not find the end of the fetch whitelist condition");
  return sw.slice(a, b);
}

test("APP_SHELL lists create.html and every new lib", () => {
  const sw = fs.readFileSync(path.join(__dirname, "..", "app/sw.js"), "utf8");
  const src = appShellSrc(sw);
  NEW_SHELL_FILES.forEach((p) =>
    assert(src.indexOf('"' + p + '"') !== -1, "APP_SHELL missing " + p),
  );
});

test("the fetch whitelist (logicalPath ===) also lists every new file, not just APP_SHELL", () => {
  // This is the second, easy-to-forget list: without an entry here a file
  // precached by APP_SHELL still falls through to the generic serveFromIDB
  // path on every request instead of networkFirstWithShellFallback, and
  // never gets the offline cache fallback. See the comment block above.
  const sw = fs.readFileSync(path.join(__dirname, "..", "app/sw.js"), "utf8");
  const src = fetchWhitelistSrc(sw);
  NEW_SHELL_FILES.forEach((p) => {
    const bare = p.replace(/^\//, "");
    assert(
      src.indexOf('logicalPath === "' + bare + '"') !== -1,
      "fetch whitelist missing logicalPath === \"" + bare + '"',
    );
    // The two lists take different path forms. A leading-slash value in the
    // whitelist would never match a logicalPath and would fail silently,
    // offline only.
    assert(
      src.indexOf('logicalPath === "' + p + '"') === -1,
      "fetch whitelist has " + p + ' with a leading slash; it must be bare',
    );
  });
});

test("stub manifest and stub binaries never enter APP_SHELL (fetched on demand only)", () => {
  // create.html fetches /stub/stubs.json and caches binaries itself in the
  // "tcoaal-stubs" Cache Storage bucket (Task 11). Precaching them here
  // would force every visitor, including one who never builds a native
  // installer, to download all three platform stubs (Linux AppImage alone
  // is roughly 140 MB) just to boot the page.
  const sw = fs.readFileSync(path.join(__dirname, "..", "app/sw.js"), "utf8");
  const shellSrc = sw.slice(
    sw.indexOf("const APP_SHELL"),
    sw.indexOf("async function precacheShell"),
  );
  // Note: js/libs/stub-stamp.js is a legitimate create.html lib (it stamps
  // installer stubs, it isn't one) and deliberately contains "stub" in its
  // name, so check for the stub/ directory prefix and the manifest
  // filename specifically rather than a bare "stub" substring.
  assert(shellSrc.indexOf("/stub/") === -1, "APP_SHELL must not reference the /stub/ directory");
  assert(shellSrc.indexOf("stubs.json") === -1, "APP_SHELL must not reference stubs.json");
});

test("SW_VERSION bumped exactly once (15 -> 16) for the new shell files", () => {
  const sw = fs.readFileSync(path.join(__dirname, "..", "app/sw.js"), "utf8");
  const m = sw.match(/const SW_VERSION = (\d+);/);
  assert(m, "SW_VERSION constant not found");
  eq(Number(m[1]), 16, "SW_VERSION");
});

test("robots.txt disallows create.html", () => {
  const r = fs.readFileSync(path.join(__dirname, "..", "app/robots.txt"), "utf8");
  assert(/Disallow:\s*\/create\.html/.test(r), "robots.txt must disallow /create.html");
});

test("sitemap.xml does not list create.html", () => {
  const s = fs.readFileSync(path.join(__dirname, "..", "app/sitemap.xml"), "utf8");
  eq(s.indexOf("create.html"), -1);
});

test("server.js serves /stub/* from a repo-root stub/ directory, 404 with a clear message when absent", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert(/stub\//.test(src), "server.js must reference a stub/ route");
  assert(
    src.indexOf("No local stub/ directory; stubs are published by CI.") !== -1,
    "server.js must 404 with the documented message when stub/ is absent",
  );
});

test(".gitignore excludes the local stub/ directory", () => {
  const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert(/(^|\n)stub\//.test(gi), ".gitignore must list stub/");
});

// Integration tests against a real game (Task 13)
//
// These tests exercise the whole packaging pipeline (ModDiff.compare ->
// ModPackage.build -> ModPackage.parse -> applyModPackage) against an actual
// shipped copy of the game at .hide/current_game/www. That directory is
// gitignored and only present on a machine that has been set up for mod
// development, so every test in this section is skipped (loudly, with a
// named reason) when it is absent. The skip guard must never hide a real
// failure: everything below either runs for real or does not run at all.

const GAME = path.join(__dirname, "..", ".hide", "current_game", "www");

/*
 * applyModPackage(baseFiles, packageBytes) -> Map<rel, Uint8Array>
 *
 * The reference implementation of the loader's APPLY step: the executable
 * definition of the tcoaal-mod/4 format that a native (Rust) loader must
 * reproduce byte for byte. Read this alongside classify() in
 * app/js/libs/mod-diff-worker.js, which is the encoder for the same rules.
 *
 * baseFiles: Map<rel, Uint8Array> of the installed base game, keyed by the
 *   game's own on-disk relative path (hashed + [BUST]/! decorated for data
 *   and img files exactly as the game stores them; see hashPath() in
 *   tcoaal-codec.js). This is the same key space compare()'s base
 *   Source.list() yields.
 *
 * f.rel is where the entry is written: the name the MODDER's tree used,
 * which for a mod authored as a project is data/Actors.json, not the base's
 * data/be1a37535e921f91. f.from, when present, names the base file the entry
 * is derived from, in the base's own key space. A /3 package never carries
 * from and never carries a copy entry, so it applies exactly as before.
 * packageBytes: the raw bytes of a .tcoaalmod file (ModPackage.build output).
 *
 * Returns a NEW Map holding the resulting game tree: baseFiles with every
 * variant file entry applied on top. baseFiles itself is never mutated.
 *
 * Variant selection: a real loader must pick manifest.variants[N] by
 * matching the installed base's fingerprint (manifest.variants[i].base).
 * That matching is out of scope here: every test below builds exactly one
 * variant, so this reference always applies variants[0].
 */
async function applyModPackage(baseFiles, packageBytes) {
  const { manifest, entries } = await P.parse(packageBytes);
  const variant = manifest.variants[0];
  const out = new Map(baseFiles);

  for (const f of variant.files) {
    // Rule 1: a file the modder removed. Carries no other fields (rel, type
    // only, enforced by classify() and checked by a unit test above), so
    // there is nothing to decode, just drop it.
    if (f.type === "delete") {
      out.delete(f.rel);
      continue;
    }

    // Rule 2: a whole-file replacement (a new file, or a changed file whose
    // content could not travel as a JSON patch: a binary asset, or a data/
    // file that is not itself valid JSON, e.g. this game's LANGDATA blob or
    // a plain data/Credits.txt).
    //
    // f.payload names an entry in the package zip under "f/<sha16>" holding
    // the plaintext (decrypted, uncompressed by dekit at diff time) bytes.
    // f.enc/f.key describe how the MOD's own copy of this file was encoded
    // on disk: classify() reads them from the MODDED file's header
    // (encFields(modRaw)), never the base's, so re-encrypting with them
    // here reproduces exactly what the modder's own game folder contained,
    // independent of how (or whether) the base game encrypted this path.
    if (f.type === "verbatim") {
      const plain = entries.get(f.payload);
      // .slice(): two different rel's can point at the SAME payload entry
      // when their bytes were identical at diff time (payload dedup; see
      // "identical payload bytes in two places deduplicate" above). Handing
      // back the shared `entries` buffer by reference to both output map
      // slots would alias two logically-independent files onto one backing
      // array; slice() gives every output file its own memory, matching the
      // no-aliasing guarantee every other Source in this codebase upholds
      // (see idbSource/dirSource/memSource's read() comments).
      out.set(f.rel, f.enc ? C.enkit(plain, f.rel, f.key) : plain.slice());
      continue;
    }

    // Rules 3 and 4 both start from a file the player already has: f.from
    // where the entry names one, otherwise the same path. It is read from the
    // tree as applied so far, not from the pristine base, because an earlier
    // mod in the load order may have rewritten it. Decrypted with ITS name,
    // since that is the name its mask was derived from.
    const src = f.from || f.rel;
    const srcCipher = out.get(src);
    if (!srcCipher) throw new Error(f.rel + ": " + src + " is missing from the game");
    const srcPlain = C.dekit(srcCipher, src);

    // Rule 3: "copy". The modder's file is byte for byte the player's own
    // file under another name (a project's audio/bgm/keep.ogg where the game
    // stores audio/bgm/<hash>), so the package carries no bytes for it and
    // the player's copy is laid down under the mod's name, encoded the way
    // the mod's own copy was (f.enc/f.key from the MOD's header).
    if (f.type === "copy") {
      out.set(f.rel, f.enc ? C.enkit(srcPlain, f.rel, f.key) : srcPlain.slice());
      continue;
    }

    // Rule 4 (the only remaining type: "patch"): the base file existed and
    // was valid JSON on both sides, and only a value inside it changed.
    // f.ops is an RFC 6902 patch (JsonDiff.diff's output). Without from,
    // f.enc/f.key come from the BASE file's OWN header (classify()'s
    // encFields(baseRaw)) and NOT the mod's, because the loader re-encrypts
    // a patched file using the base game's existing encryption convention
    // for that path, not something the modder's toolchain invented. Getting
    // base and mod swapped here is the classic bug this format is exposed
    // to: the output would still be valid-looking ciphertext, just
    // undecryptable by the game (or silently wrong), since fileMask depends
    // only on rel, not on which side's keyByte you feed dekit/enkit. With
    // from, the patched document lands at the MOD's name and f.enc/f.key
    // describe the mod's file there, as for copy.
    const baseDoc = JSON.parse(new TextDecoder().decode(srcPlain));
    const moddedDoc = J.apply(baseDoc, f.ops);
    const moddedBytes = new TextEncoder().encode(JSON.stringify(moddedDoc));
    out.set(f.rel, f.enc ? C.enkit(moddedBytes, f.rel, f.key) : moddedBytes);
  }

  return out;
}

if (!fs.existsSync(GAME)) {
  console.log("\nintegration: SKIPPED (.hide/current_game/www not present)");
} else {
  console.log("\nintegration (real game at .hide/current_game/www):");

  // Walks the whole tree (every directory is visited regardless of `limit`,
  // so file COUNT is accurate even when only the first `limit` files are
  // actually read into memory) and reads up to `limit` files as
  // Uint8Array, keyed by their game-relative path. Pass Infinity to read
  // every file. .hide/current_game/www holds 2151 files / ~585MB, which
  // this suite reads and diffs in a few seconds (measured below); there is
  // no need to cap it the way the brief's smaller, per-behaviour tests do.
  function readGame(limit) {
    const files = new Map();
    (function walk(dir, base) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = base ? base + "/" + name : name;
        if (fs.statSync(full).isDirectory()) walk(full, rel);
        else if (files.size < limit) files.set(rel, new Uint8Array(fs.readFileSync(full)));
      }
    })(GAME, "");
    return files;
  }

  // Returns the rel of the first entry in `base` for which `pred(rel, raw)`
  // is true, or null. Used to locate real examples of each edge case
  // (an object-root data file, an array-root one, a non-JSON data file, a
  // [BUST]/! decorated name, ...) without hardcoding hashes that belong to
  // one specific build of the game.
  function pick(base, pred) {
    for (const [rel, raw] of base) {
      if (pred(rel, raw)) return rel;
    }
    return null;
  }

  // Step 1 of the brief: the three baseline tests, close to as given

  atest("a one-value data edit round-trips through the package", async () => {
    const base = readGame(400);
    const sysKey = pick(base, (rel, raw) => {
      if (!rel.startsWith("data/")) return false;
      const plain = C.dekit(raw, rel);
      if (!plain.length || plain[0] !== 0x7b) return false; // '{' object root
      try {
        const j = JSON.parse(new TextDecoder().decode(plain));
        return j !== null && typeof j === "object" && !Array.isArray(j);
      } catch (e) {
        return false;
      }
    });
    assert(sysKey, "no object-root data/ file found in the first 400 files");
    const doc = JSON.parse(new TextDecoder().decode(C.dekit(base.get(sysKey), sysKey)));
    const modded = new Map(base);
    const edited = JSON.parse(JSON.stringify(doc));
    edited.__modMarker = "MODDED";
    modded.set(sysKey, C.enkit(new TextEncoder().encode(JSON.stringify(edited)), sysKey, 0));

    const payloads = new Map();
    const r = await D.compare(memSource(base), memSource(modded), payloads, () => {});
    eq(r.files.length, 1);
    eq(r.files[0].type, "patch");
    const bytes = await P.build({
      id: "t", name: "T", author: "", version: "1.0.0", description: "",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "b", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });
    const applied = await applyModPackage(base, bytes);
    const back = JSON.parse(new TextDecoder().decode(C.dekit(applied.get(sysKey), sysKey)));
    eq(JSON.stringify(back), JSON.stringify(edited));
  });

  atest("an array-root data file (RPG Maker's usual Actors/Classes/... shape) round-trips too", async () => {
    // Step 3 of the brief calls this out explicitly: "data files that are
    // arrays rather than objects." JsonDiff replaces the whole array as one
    // "replace" op on a length change (see json-diff.js's module comment),
    // so this exercises a different code path in JsonDiff.apply than the
    // object test above (parent[key] on the synthetic "root" wrapper vs. a
    // real nested key).
    const base = readGame(400);
    const arrKey = pick(base, (rel, raw) => {
      if (!rel.startsWith("data/")) return false;
      const plain = C.dekit(raw, rel);
      if (!plain.length || plain[0] !== 0x5b) return false; // '[' array root
      try {
        const j = JSON.parse(new TextDecoder().decode(plain));
        return Array.isArray(j) && j.length > 0;
      } catch (e) {
        return false;
      }
    });
    assert(arrKey, "no array-root data/ file found in the first 400 files");
    const doc = JSON.parse(new TextDecoder().decode(C.dekit(base.get(arrKey), arrKey)));
    const modded = new Map(base);
    const edited = doc.slice();
    edited.push({ __modMarker: "MODDED-ARRAY-ENTRY" });
    modded.set(arrKey, C.enkit(new TextEncoder().encode(JSON.stringify(edited)), arrKey, 0));

    const payloads = new Map();
    const r = await D.compare(memSource(base), memSource(modded), payloads, () => {});
    eq(r.files.length, 1);
    eq(r.files[0].type, "patch");
    eq(r.files[0].ops.length, 1, "a length change must collapse to one root-level replace op");
    eq(r.files[0].ops[0].path, "");
    const bytes = await P.build({
      id: "t", name: "T", author: "", version: "1.0.0", description: "",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "b", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });
    const applied = await applyModPackage(base, bytes);
    const back = JSON.parse(new TextDecoder().decode(C.dekit(applied.get(arrKey), arrKey)));
    eq(JSON.stringify(back), JSON.stringify(edited));
  });

  atest("no unchanged base file's bytes appear in the package (sampled, 400-file base)", async () => {
    const base = readGame(400);
    const modded = new Map(base);
    modded.set("js/plugins/OnlyMine.js", new TextEncoder().encode("var mine = 1;"));
    const payloads = new Map();
    const r = await D.compare(memSource(base), memSource(modded), payloads, () => {});
    const bytes = await P.build({
      id: "t", name: "T", author: "", version: "1.0.0", description: "",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "b", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });
    const hay = Buffer.from(bytes);
    let checked = 0;
    for (const [rel, raw] of base) {
      if (raw.length < 64) continue;
      const probe = Buffer.from(C.dekit(raw, rel).subarray(16, 48));
      assert(hay.indexOf(probe) === -1, "package leaks bytes from unchanged " + rel);
      if (++checked >= 200) break;
    }
    assert(checked > 0, "no files were probed");
  });

  atest("applying to an untouched base reproduces the modded tree exactly (400-file base)", async () => {
    const base = readGame(400);
    const modded = new Map(base);
    const victim = pick(base, (rel) => rel.startsWith("img/"));
    if (victim) modded.set(victim, C.enkit(new Uint8Array([9, 8, 7]), victim, 0));
    const deleted = pick(base, (rel) => rel.startsWith("audio/"));
    modded.delete(deleted);
    const payloads = new Map();
    const r = await D.compare(memSource(base), memSource(modded), payloads, () => {});
    const bytes = await P.build({
      id: "t", name: "T", author: "", version: "1.0.0", description: "",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "b", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });
    const applied = await applyModPackage(base, bytes);
    eq(applied.size, modded.size);
    for (const [k, v] of modded) {
      eq(Buffer.from(applied.get(k)).toString("hex"), Buffer.from(v).toString("hex"));
    }
  });

  // The overlay end to end, on real game files: a mod that ships only what it
  // changes must leave every other file of the player's game exactly as it
  // was. This is the shape the loader's profile relies on - it lays the
  // player's own game down first and applies these entries on top - so the
  // package proves it by carrying no delete entry and applying to a FULL
  // base, not to the 31-file tree it was built from.
  atest("real game: an overlay package changes only its own files", async () => {
    const base = readGame(400);
    // The shipped notices are dropped from both sides of every diff, so they
    // are not overlay material and would make the counts below lie.
    const rels = [...base.keys()].filter((r) => !/^[^/]+\.(txt|url)$/i.test(r));
    const overlay = new Map();
    for (let i = 0; i < 30; i++) overlay.set(rels[i], base.get(rels[i]));
    const victim = rels[3];
    overlay.set(victim, C.enkit(new Uint8Array([9, 8, 7]), victim, 0));
    overlay.set("img/pictures/0123456789abcdef", new TextEncoder().encode("mine"));

    eq(D.detectMode(rels, [...overlay.keys()]).mode, "overlay");
    const payloads = new Map();
    const r = await D.compare(
      memSource(base),
      memSource(overlay),
      payloads,
      () => {},
      { mode: "overlay" },
    );
    eq(r.stats.deleted, 0);
    eq(r.stats.untouched, rels.length - 30);
    assert(!r.files.some((f) => f.type === "delete"), "no delete entry");

    const bytes = await P.build({
      id: "t", name: "T", author: "", version: "1.0.0", description: "",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "b", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });
    const applied = await applyModPackage(base, bytes);
    eq(applied.size, base.size + 1, "one new file, nothing removed");
    // Digests, not the bytes: a mismatch on a multi-megabyte asset must
    // print a line, not the file.
    const sum = (b) => crypto.createHash("sha256").update(Buffer.from(b)).digest("hex");
    for (const [rel, raw] of base) {
      const want = overlay.has(rel) ? overlay.get(rel) : raw;
      eq(sum(applied.get(rel)), sum(want), "overlay must not disturb " + rel);
    }
    eq(
      Buffer.from(applied.get("img/pictures/0123456789abcdef")).toString("utf8"),
      "mine",
    );
  });

  // Full-scale fixture: every file in the real game (2151 / ~585MB)
  //
  // Built once, on demand, and shared by every "full scale" test below
  // through this memoized promise: each atest() below starts running
  // synchronously (up to its first await) the instant it is called, in
  // declaration order, so the FIRST test to call fullFixture() creates the
  // promise before any later test's body runs; every later caller awaits
  // the same in-flight (or settled) promise instead of re-reading and
  // re-diffing 585MB per test.
  let _fullFixture = null;
  function fullFixture() {
    if (!_fullFixture) _fullFixture = buildFullFixture();
    return _fullFixture;
  }

  async function buildFullFixture() {
    const base = readGame(Infinity);
    let totalBaseBytes = 0;
    for (const raw of base.values()) totalBaseBytes += raw.length;

    const modded = new Map(base);

    // 1. A JSON object-root data file: one field added (patch).
    const objKey = pick(base, (rel, raw) => {
      if (!rel.startsWith("data/")) return false;
      const plain = C.dekit(raw, rel);
      if (!plain.length || plain[0] !== 0x7b) return false;
      try {
        const j = JSON.parse(new TextDecoder().decode(plain));
        return j !== null && typeof j === "object" && !Array.isArray(j);
      } catch (e) {
        return false;
      }
    });
    assert(objKey, "fixture requires an object-root data/ file");
    const objEdited = JSON.parse(new TextDecoder().decode(C.dekit(base.get(objKey), objKey)));
    objEdited.__integrationTestMarker = "OBJECT-EDIT";
    modded.set(objKey, C.enkit(new TextEncoder().encode(JSON.stringify(objEdited)), objKey, 0));

    // 2. A JSON array-root data file: one element appended (patch, whole-
    //    array replace since the length changed).
    const arrKey = pick(base, (rel, raw) => {
      if (!rel.startsWith("data/") || rel === objKey) return false;
      const plain = C.dekit(raw, rel);
      if (!plain.length || plain[0] !== 0x5b) return false;
      try {
        const j = JSON.parse(new TextDecoder().decode(plain));
        return Array.isArray(j) && j.length > 0;
      } catch (e) {
        return false;
      }
    });
    assert(arrKey, "fixture requires an array-root data/ file");
    const arrEdited = JSON.parse(new TextDecoder().decode(C.dekit(base.get(arrKey), arrKey)));
    arrEdited.push({ __integrationTestMarker: "ARRAY-EDIT" });
    modded.set(arrKey, C.enkit(new TextEncoder().encode(JSON.stringify(arrEdited)), arrKey, 0));

    // 3. A non-JSON file under data/ (this game ships at least two: a
    //    "LANGDATA..." blob and a plain, UNHASHED "data/Credits.txt" -
    //    prefer the smaller one so the fixture package stays small). Edited
    //    in place, verbatim, carrying whatever encoding (or lack of one)
    //    its base copy already used.
    const nonJsonCandidates = [];
    for (const [rel, raw] of base) {
      if (!rel.startsWith("data/")) continue;
      const plain = C.dekit(raw, rel);
      if (plain.length && plain[0] !== 0x7b && plain[0] !== 0x5b) {
        nonJsonCandidates.push([rel, plain.length]);
      }
    }
    assert(nonJsonCandidates.length > 0, "fixture requires a non-JSON data/ file");
    nonJsonCandidates.sort((a, b) => a[1] - b[1]);
    const blobKey = nonJsonCandidates[0][0];
    const blobEncrypted = C.isEncrypted(base.get(blobKey));
    const blobEdited = new TextEncoder().encode("integration test replacement for " + blobKey);
    modded.set(blobKey, blobEncrypted ? C.enkit(blobEdited, blobKey, 0) : blobEdited);

    // 4. A [BUST]/! decorated name (both prefixes affect fileMask; see
    //    tcoaal-codec.js's fileMask(), which reads them straight off the
    //    hashed basename). Whole-file replace with a non-zero keyByte, to
    //    exercise the "encrypt only the first keyByte bytes" branch of
    //    enkit/dekit on a real decorated path, not just a synthetic HASHED
    //    constant.
    const decoratedKey = pick(base, (rel) => {
      const bn = rel.split("/").pop();
      return bn.toUpperCase().indexOf("[BUST]") !== -1 || bn.charAt(0) === "!";
    });
    assert(decoratedKey, "fixture requires a [BUST] or !-prefixed file");
    modded.set(decoratedKey, C.enkit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), decoratedKey, 5));

    // 5. A plain (non-decorated) img/ file with a real, non-zero keyByte:
    //    whole-file replace.
    const imgKey = pick(base, (rel, raw) => {
      if (!rel.startsWith("img/")) return false;
      const bn = rel.split("/").pop();
      if (bn.toUpperCase().indexOf("[BUST]") !== -1 || bn.charAt(0) === "!") return false;
      return C.readKeyByte(raw) > 0;
    });
    assert(imgKey, "fixture requires a plain img/ file with a non-zero keyByte");
    modded.set(imgKey, C.enkit(new Uint8Array([9, 9, 9]), imgKey, 3));

    // 6. An audio/ file removed outright.
    const deleteKey = pick(base, (rel) => rel.startsWith("audio/"));
    assert(deleteKey, "fixture requires an audio/ file to delete");
    modded.delete(deleteKey);

    // 7. A brand new file the base game never shipped.
    const newKey = "js/plugins/OnlyMineIntegrationTest.js";
    assert(!base.has(newKey), "fixture's new file must not already exist in the base game");
    modded.set(newKey, new TextEncoder().encode("var onlyMine = true; // integration test"));

    const changedKeys = [objKey, arrKey, blobKey, decoratedKey, imgKey, deleteKey, newKey];
    assert(new Set(changedKeys).size === changedKeys.length, "fixture picked the same file twice");

    const payloads = new Map();
    const r = await D.compare(memSource(base), memSource(modded), payloads, () => {});
    const bytes = await P.build({
      id: "integration-test", name: "Integration Test Mod", author: "", version: "1.0.0",
      description: "Task 13 real-game integration fixture.",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "real game", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });

    return {
      base, modded, r, bytes, payloads, totalBaseBytes,
      changedKeys, objKey, arrKey, blobKey, decoratedKey, imgKey, deleteKey, newKey,
    };
  }

  atest("real game: compare() classifies every real edge case correctly (objects, arrays, non-JSON data/, [BUST]/!, delete, add)", async () => {
    const f = await fullFixture();
    eq(f.r.files.length, 7, "exactly the 7 files this fixture touched should produce an entry");
    eq(f.r.stats.patched, 2, "the two JSON edits (object + array root)");
    eq(f.r.stats.added, 1, "the brand new plugin file");
    eq(f.r.stats.replaced, 3, "the non-JSON blob + decorated img + plain img whole-file replaces");
    eq(f.r.stats.deleted, 1, "the removed audio file");
    // compare() iterates base UNION mod, not base alone: f.newKey exists
    // only in the modded tree, so it enlarges that union by one without
    // removing anything from "unchanged". Only the 6 changedKeys that were
    // already present in base each take one file out of "unchanged"; the
    // 7th (newKey) was never counted as unchanged to begin with.
    const changedInBase = f.changedKeys.filter((k) => f.base.has(k)).length;
    eq(changedInBase, 6, "sanity: exactly 6 of the 7 changed keys should pre-exist in the base game");
    // The shipped notices (the copyright, credits and EULA documents sitting
    // directly in www) never enter the diff at all, so they are not counted as
    // unchanged either: compare() drops them before it walks. The game hashes
    // one of them on boot, and a mod that carries a line-ending-normalised
    // copy of it cannot start.
    const notices = [...f.base.keys()].filter((k) => /^[^/]+\.(txt|url)$/i.test(k));
    eq(notices.length, 4, "sanity: the real game ships four root-level notices");
    eq(
      f.r.stats.unchanged,
      f.base.size - changedInBase - notices.length,
      "everything else must be reported unchanged",
    );
    assert(
      !f.r.files.some((e) => /^[^/]+\.(txt|url)$/i.test(e.rel)),
      "a shipped notice must never become a package entry",
    );

    const byRel = new Map(f.r.files.map((e) => [e.rel, e]));
    eq(byRel.get(f.deleteKey).type, "delete");
    assert(!("enc" in byRel.get(f.deleteKey)) && !("key" in byRel.get(f.deleteKey)),
      "a delete entry must carry no enc/key/payload fields");
    eq(byRel.get(f.newKey).type, "verbatim");
    eq(byRel.get(f.newKey).enc, false, "the new plugin file is plain text, never TCOAAL-signed");
  });

  atest("real game: applying the package to the base reproduces the modded tree exactly, byte for byte (risks 1, 2, 3, 5)", async () => {
    const f = await fullFixture();
    const applied = await applyModPackage(f.base, f.bytes);

    // Risk 3: a deleted file is truly gone, not just unlisted.
    assert(!applied.has(f.deleteKey), "deleted file must be absent from the applied result");
    eq(applied.size, f.modded.size, "applied tree must have exactly the modded file count");

    // Risks 1, 2 and 5 together: every single file in the real modded tree,
    // all 2151 of them, touched and untouched alike, must come back byte
    // for byte identical. This is not a sampled check: it is every file the
    // real game ships, decrypted or not, patched, replaced, added, or left
    // alone. A wrong keyByte on re-encryption, a base/mod key swap on a
    // patch, or apply() accidentally touching a file it was never told to
    // would all show up here as a hex mismatch on some real path.
    let compared = 0;
    for (const [rel, expected] of f.modded) {
      const got = applied.get(rel);
      assert(got, "applied tree is missing " + rel);
      eq(Buffer.from(got).toString("hex"), Buffer.from(expected).toString("hex"),
        rel + " must be byte-identical after the round trip");
      compared++;
    }
    eq(compared, f.modded.size);
    assert(compared > 2000, "expected to compare essentially the whole real game, got only " + compared);
  });

  atest("real game: no unchanged file's bytes, ciphertext or decrypted, appear anywhere in the package (risk 4, the load-bearing test)", async () => {
    const f = await fullFixture();
    const hay = Buffer.from(f.bytes);
    const changed = new Set(f.changedKeys);

    function probeWindows(bytes) {
      const windows = [];
      if (bytes.length >= 64) windows.push(bytes.subarray(16, 48));
      if (bytes.length >= 128) {
        const mid = bytes.length >> 1;
        windows.push(bytes.subarray(mid - 16, mid + 16));
      }
      if (bytes.length >= 192) windows.push(bytes.subarray(bytes.length - 48, bytes.length - 16));
      return windows;
    }

    let checked = 0;
    for (const [rel, raw] of f.base) {
      if (changed.has(rel)) continue;
      // Ciphertext as stored on disk (catches an accidental raw copy)...
      for (const w of probeWindows(raw)) {
        assert(hay.indexOf(Buffer.from(w)) === -1, "package leaks raw base-game bytes from " + rel);
      }
      // ...and the decrypted plaintext (the actual creative content: this
      // is the check that matters for the copyright property).
      const plain = C.dekit(raw, rel);
      for (const w of probeWindows(plain)) {
        assert(hay.indexOf(Buffer.from(w)) === -1, "package leaks decrypted base-game content from " + rel);
      }
      checked++;
    }
    // Only the changedKeys that actually exist in the base tree are ever
    // encountered (and skipped) while iterating f.base: f.newKey has no
    // base entry to skip in the first place (see the identical note in the
    // "classifies every real edge case" test above).
    const changedInBase = f.changedKeys.filter((k) => f.base.has(k)).length;
    eq(checked, f.base.size - changedInBase, "every unchanged file must be probed");
    assert(checked > 2000, "expected to probe essentially the whole real game, got only " + checked);
  });

  atest("real game: the built package is a tiny fraction of the game's on-disk size (risk 4)", async () => {
    const f = await fullFixture();
    const ratio = f.bytes.length / f.totalBaseBytes;
    console.log(
      "    package: " + f.bytes.length + " bytes; game: " + f.totalBaseBytes +
      " bytes; ratio: " + (ratio * 100).toFixed(4) + "%",
    );
    assert(ratio < 0.01, "package must be under 1% of the game's size, was " + (ratio * 100).toFixed(4) + "%");
    assert(f.bytes.length < 1024 * 1024, "package should be well under 1MB for a 7-file edit, was " + f.bytes.length);
  });

  atest("real game: building the same inputs twice is byte-identical (risk 6)", async () => {
    const f = await fullFixture();
    // Rebuilt from the SAME files/stats/payloads f already computed, so this
    // isolates ModPackage.build()'s own determinism from ModDiff.compare()'s.
    const spec = {
      id: "integration-test", name: "Integration Test Mod", author: "", version: "1.0.0",
      description: "Task 13 real-game integration fixture.",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "real game", fingerprint: {} }, files: f.r.files, stats: f.r.stats }],
      payloads: f.payloads,
    };
    const b1 = await P.build(spec);
    const b2 = await P.build(spec);
    const e1 = await P.readZip(b1);
    const e2 = await P.readZip(b2);
    eq(Array.from(e1.keys()).join(","), Array.from(e2.keys()).join(","), "entry order must be identical");

    const diffs = [];
    for (const name of e1.keys()) {
      const hex1 = Buffer.from(e1.get(name)).toString("hex");
      const hex2 = Buffer.from(e2.get(name)).toString("hex");
      if (hex1 !== hex2) diffs.push(name);
    }
    // A .tcoaalmod is a pure function of its inputs: every entry, the entry
    // order, the compression choice and the manifest are all derived from
    // what went in. Nothing may carry a wall clock. This originally failed
    // on a `created` timestamp in mod.json, which had no consumer and cost
    // exactly this property; it was removed rather than exempted here.
    eq(diffs.join(","), "", "two builds of identical input must be byte-identical");
    eq(
      Buffer.from(b1).toString("hex"),
      Buffer.from(b2).toString("hex"),
      "including the packaged bytes as a whole",
    );
    const m1 = JSON.parse(new TextDecoder().decode(e1.get("mod.json")));
    assert(!("created" in m1), "the manifest must not carry a build timestamp");
  });

  // A real mod's own repository, diffed against the real game
  //
  // Everything above builds its modded side out of the game's own files, so
  // it never leaves game space. A mod is not authored that way: it is an RPG
  // Maker project whose files carry the names the editor gave them and whose
  // bytes are plain. This is that pair, unmodified, on both sides.
  //
  // Read straight off disk rather than into a Map: the two trees are 563MB
  // and 316MB, and compare() only ever holds one file from each at a time.
  const PROJECT = path.join(__dirname, "..", ".hide", "tcoaar-project-main", "www");

  function fsSource(root) {
    const rels = [];
    (function walk(dir, base) {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = base ? base + "/" + name : name;
        if (fs.statSync(full).isDirectory()) walk(full, rel);
        else rels.push(rel);
      }
    })(root, "");
    return {
      list: async () => rels.slice().sort(),
      // A fresh buffer per read, as every other Source promises: classify()
      // stores an unencrypted file's bytes into payloads by reference.
      read: async (rel) => new Uint8Array(fs.readFileSync(path.join(root, rel))),
    };
  }

  // Key order, and only key order, is where a patched document may differ
  // from the modder's own file: the editor writes {"characterIndex":0,...,
  // "tileId":0} where the shipped build wrote {"tileId":0,...}, and a patch
  // that touches neither key leaves the base's order in place. The game
  // reads these through JSON.parse, and JsonDiff compares by key, so this is
  // invisible to both. Compare the documents, not their serialization.
  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
      return out;
    }
    return v;
  }

  // Every real mod in the registry is authored as a project (data/Actors.json,
  // plain bytes) and ships its own engine, which opens exactly those names.
  // The proof for such a folder is therefore the loader's promise: the
  // player's game with the mod's files pasted on top. Every file the modder
  // shipped comes back out under the modder's own name with the modder's own
  // bytes, every game file the mod does not ship is left alone, and no byte of
  // the base game travels in the package.
  async function proveOverlay(label, modRoot) {
    const base = fsSource(GAME);
    const baseNames = await base.list();
    const raw = fsSource(modRoot);
    const rawNames = await raw.list();

    eq(D.pathSpace(baseNames), "hashed", "the shipped game is hashed");
    eq(D.pathSpace(rawNames), "canonical", "the mod's folder is a project");

    const storage = await D.storageNames(rawNames);
    eq(D.spaceProblem(baseNames, rawNames), null, "a project against the remaster is not refused");
    // Auto-detection has to land on overlay by itself here. Read as a full
    // copy this pair would delete about four fifths of the player's game.
    eq(D.detectMode(baseNames, [...storage.values()]).mode, "overlay");

    const payloads = new Map();
    const r = await D.compare(base, raw, payloads, () => {}, { mode: "overlay", storage });
    eq(r.stats.deleted, 0, "an overlay deletes nothing");
    assert(r.stats.patched > 20, "real map/database edits travel as patches, got " + r.stats.patched);
    assert(r.stats.copied > 0, "some of what the mod ships is the player's own file under another name");
    assert(r.stats.untouched > 1000, "the rest of the game is left alone");
    eq(D.pairProblem(r.stats), null);

    const bytes = await P.build({
      id: "t", name: "T", author: "", version: "1.0.0", description: "",
      icon: null, saves: "isolated", update: null, theme: [],
      variants: [{ base: { label: "b", fingerprint: {} }, files: r.files, stats: r.stats }],
      payloads,
    });

    // Apply it the way the loader will, onto the player's game.
    const baseFiles = new Map();
    for (const rel of baseNames) baseFiles.set(rel, await base.read(rel));
    const out = await applyModPackage(baseFiles, bytes);

    let same = 0, doc = 0;
    for (const rel of rawNames) {
      // The shipped notices are dropped before the walk on purpose: the game
      // hashes one of them on boot and refuses to start if it moved.
      if (/^[^/]+\.(txt|url)$/i.test(rel)) continue;
      const want = await raw.read(rel);
      const got = out.get(rel);
      assert(got, rel + " is not in the modded game");
      if (Buffer.from(got).equals(Buffer.from(want))) {
        same++;
        continue;
      }
      // A patched or copied document may differ from the modder's file in
      // key order and whitespace only; the game reads it through JSON.parse.
      assert(
        (want[0] === 0x7b || want[0] === 0x5b) &&
          JSON.stringify(canonical(JSON.parse(new TextDecoder().decode(got)))) ===
            JSON.stringify(canonical(JSON.parse(new TextDecoder().decode(want)))),
        rel + " came out different from what the modder shipped",
      );
      doc++;
    }
    const shipped = new Set(storage.values());
    for (const rel of baseNames) {
      if (shipped.has(rel)) continue;
      assert(out.get(rel) === baseFiles.get(rel), rel + " is not the player's own file any more");
    }

    // The browser installs the same package into IndexedDB (mod-install.js,
    // "mod:{id}:{rel}" over the game's plain keys). Every file it lays down
    // must decode to what the native apply above produced.
    const MI = loadLib([
      "app/js/libs/tcoaal-codec.js",
      "app/js/libs/json-diff.js",
      "app/js/libs/mod-package.js",
      "app/js/libs/mod-install.js",
    ]).ModInstall;
    const idb = new Map(baseFiles);
    const store = {
      get: async (k) => (idb.has(k) ? idb.get(k) : null),
      putMany: async (pairs) => { for (const [k, v] of pairs) idb.set(k, v); },
      keys: async (prefix) => [...idb.keys()].filter((k) => k.indexOf(prefix) === 0),
      deleteMany: async (keys) => { for (const k of keys) idb.delete(k); },
    };
    const inst = await MI.install({ store, bytes, id: "t" });
    let browserSame = 0;
    for (const f of r.files) {
      if (f.type === "delete") continue;
      const got = idb.get("mod:t:" + f.rel);
      assert(got, f.rel + " was not installed in the browser");
      const want = C.dekit(out.get(f.rel), f.rel);
      assert(Buffer.from(new Uint8Array(got)).equals(Buffer.from(want)), f.rel + " differs between the browser install and the native apply");
      browserSame++;
    }
    eq(inst.files.length, browserSame, "the browser install wrote exactly the package's files");
    // Nothing may be in the package that the modder's folder does not account
    // for: a stray entry is base-game content travelling as the modder's own
    // work. And no payload may be a base file, under any name.
    const rawSet = new Set(rawNames);
    for (const f of r.files) {
      assert(rawSet.has(f.rel), "the package carries " + f.rel + ", which the mod does not ship");
      if (f.from) assert(baseFiles.has(f.from), f.rel + " derives from " + f.from + ", which the game does not have");
    }
    const basePlain = new Set();
    for (const [rel, rawBytes] of baseFiles) basePlain.add(await D.sha16(C.dekit(rawBytes, rel)));
    for (const [key, p] of payloads) {
      assert(!basePlain.has(await D.sha16(p)), key + " is a base game file");
    }
    console.log(
      "    " + label + ": " + rawNames.length + " files -> " + r.stats.patched + " patched, " +
      r.stats.copied + " copied from the game, " + (r.stats.added + r.stats.replaced) +
      " verbatim, " + r.stats.unchanged + " unchanged; " + same + " byte-identical, " +
      doc + " document-identical after apply; browser install identical for " +
      browserSame,
    );
  }

  if (!fs.existsSync(PROJECT)) {
    console.log("  (project-space pair SKIPPED: .hide/tcoaar-project-main/www not present)");
  } else {
    atest("real mod project: a modder's repository installs as itself over the shipped game", async () => {
      await proveOverlay("tcoaar-project", PROJECT);
    });
  }

  // The folder that surfaced this: an overhaul with a canonical Actor1.png
  // beside a stale 7d7d5b7fb68621e6.png for the same character, its own
  // GameCode.js with obfuscation and encryption off, and 200-odd files that
  // are the game's own under the names its engine opens.
  const TLCOAAA = path.join(__dirname, "..", "mods", "TLCOAAA", "www");
  if (!fs.existsSync(TLCOAAA)) {
    console.log("  (TLCOAAA pair SKIPPED: mods/TLCOAAA/www not present)");
  } else {
    atest("real overhaul: TLCOAAA installs as itself over the shipped game", async () => {
      await proveOverlay("TLCOAAA", TLCOAAA);
    });
  }
}

test("the zip fallback gates every rel through isSafeRelPath (seam)", () => {
  // Cross-task seam: the theme picker guards its own paths, but the modded
  // TREE's paths reach the manifest too, and the native loader writes those
  // to a player's disk. The directory-picker route cannot produce a hostile
  // name (a FileSystemDirectoryHandle entry name never contains a separator)
  // but a .zip's entry names are whatever built the zip, so that route is
  // the one untrusted way a path enters a package.
  const src = CREATE_HTML.slice(
    CREATE_HTML.indexOf("const root = findZipGameRoot(names)"),
    CREATE_HTML.indexOf("if (files.length === 0)"),
  );
  assert(src.length > 0, "could not locate the zip fallback's rel loop");
  assert(
    /if \(!isSafeRelPath\(rel\)\)/.test(src),
    "every rel taken from a .zip must be gated through isSafeRelPath",
  );
});

test("every path in the real game tree survives isSafeRelPath (seam)", () => {
  // The gate above is only correct if it passes real game data. A filter
  // that rejects legitimate files would look secure and quietly produce
  // packages missing content.
  const GAME = path.join(__dirname, "..", ".hide", "current_game", "www");
  if (!fs.existsSync(GAME)) {
    console.log("    (skipped: no .hide/current_game fixture)");
    return;
  }
  const isSafeRelPath = createFn("isSafeRelPath");
  const bad = [];
  let n = 0;
  (function walk(dir, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? base + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else {
        n++;
        if (!isSafeRelPath(rel)) bad.push(rel);
      }
    }
  })(GAME, "");
  assert(n > 1000, "fixture looks too small to be a real game tree: " + n);
  eq(bad.length, 0, "isSafeRelPath must not reject real game files: " + bad.slice(0, 5).join(", "));
});

test("the worker refuses an empty or non-game base before diffing (seam)", () => {
  // Cross-task seam, and the sharpest one in this plan. compare() has no
  // opinion about whether the base source is real: hand it an empty base and
  // a full modded tree and every file classifies as rule 3 (new) -> verbatim
  // -> the WHOLE BASE GAME lands in payloads as the modder's own work. It
  // would look like a successful build. fingerprint() runs after compare, so
  // it cannot gate this, and a huge files list is indistinguishable from a
  // legitimately large mod. The only place to catch it is before compare.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app/js/libs/mod-diff-worker.js"),
    "utf8",
  );
  const loop = src.slice(src.indexOf("var base = self.ModDiff.idbSource"), src.indexOf("var idx = i;"));
  assert(loop.length > 0, "could not locate the worker's per-pair setup");
  assert(
    /await base\.list\(\)/.test(loop),
    "the worker must list the base BEFORE compare() to validate it",
  );
  assert(
    /indexOf\("data\/"\) === 0/.test(loop),
    'the worker must require at least one "data/" entry in the base',
  );
});

// A mod is authored as an RPG Maker project, so the "modded folder" a modder
// hands over normally names its files data/Actors.json where the remaster
// ships data/be1a37535e921f91. The two trees then share almost no path, and
// diffing them as they stand reads the whole game as deleted and every file
// of theirs as new.
//
// That layout is derived from the logical one, so it is computed rather than
// refused: the modded tree is presented in game space and the diff runs as it
// always did. Only the reverse - a hashed mod against a base that never
// hashed anything - is unbuildable, because the hash is one-way.
atest("a project-space folder against a shipped base is not refused", async () => {
  const base = [];
  for (let i = 0; i < 200; i++) {
    base.push("audio/bgm/" + i.toString(16).padStart(16, "0"));
  }
  base.push(HASHED);
  // What the modder actually picked: the same music under its real names.
  const project = [];
  for (let i = 0; i < 200; i++) project.push("audio/bgm/track" + i + ".ogg");
  project.push("README.md");

  eq(D.pathSpace(base), "hashed", "a shipped tree reads as hashed");
  eq(D.pathSpace(project), "canonical", "a project tree reads as canonical");
  eq(D.spaceProblem(base, project), null, "a project against the remaster is not refused");
});

// The pre-remaster builds ship canonical names too, so canonical against
// canonical is a perfectly ordinary pair and must not trip the guard.
atest("a canonical base and a canonical mod are not a space mismatch", async () => {
  const base = [];
  for (let i = 0; i < 200; i++) base.push("audio/bgm/track" + i + ".ogg");
  const mod = ["audio/bgm/track3.ogg", "audio/bgm/mine.ogg", "data/Map001.json"];
  eq(D.spaceProblem(base, mod), null, "same convention on both sides");
});

// The direction that stays refused. Nothing can be derived here: the hash is
// one-way and a pre-remaster base holds no table to look the names up in, so
// every path would miss and the package would read as "delete the game, here
// are 2000 files of mine".
atest("a hashed mod against a pre-remaster base is still refused", async () => {
  const base = [];
  for (let i = 0; i < 200; i++) base.push("audio/bgm/track" + i + ".ogg");
  const mod = [];
  for (let i = 0; i < 20; i++) {
    mod.push("audio/bgm/" + i.toString(16).padStart(16, "0"));
  }
  const problem = D.spaceProblem(base, mod);
  assert(problem, "a hashed mod against a canonical base must be refused");
  assert(/canonical names/.test(problem), "say what is wrong: " + problem);
});

// Project space -> game space

console.log("\nproject space:");

atest("storagePath hashes exactly what the game redirects", async () => {
  // The three families App.redirect() bridges.
  eq((await C.storagePath("data/System.json")).rel, HASHED);
  eq((await C.storagePath("data/System.json")).enc, true);
  eq(
    (await C.storagePath("img/pictures/knife.png")).rel,
    await C.hashPath("img/pictures/knife.png"),
  );
  eq(
    (await C.storagePath("audio/bgm/mine.ogg")).rel,
    await C.hashPath("audio/bgm/mine.ogg"),
  );
  // Everything the engine opens under its own name and reads raw. movies/ is
  // the sharp one: the stock engine assigns "movies/x.webm" to a <video src>
  // with neither a redirect nor a decrypt, so hashing it loses the file.
  for (const rel of [
    "movies/wakeuptest.webm",
    "languages/english/dialogue.loc",
    "js/plugins/MyPlugin.js",
    "fonts/gamefont.css",
    "data/Credits.txt",
    "index.html",
  ]) {
    const t = await C.storagePath(rel);
    eq(t.rel, rel, rel + " must stay where it is");
    eq(t.enc, false, rel + " must stay unencrypted");
  }
});

atest("storagePath never hashes a name that is already a storage name", async () => {
  // A tree already in game space: identity, so wrapping it changes nothing.
  eq((await C.storagePath(HASHED)).rel, HASHED);
  eq((await C.storagePath("img/faces/" + "a".repeat(16))).rel, "img/faces/" + "a".repeat(16));
  // ...and one an extractor gave an extension to: strip it back, do not hash
  // the hash (which would bury the file where nothing looks for it).
  eq((await C.storagePath(HASHED + ".json")).rel, HASHED);
  eq(
    (await C.storagePath("img/pictures/0123456789abcdef.png")).rel,
    "img/pictures/0123456789abcdef",
  );
  // The two decorations the hashed names carry survive the round trip.
  eq(
    (await C.storagePath("img/faces/s_chat[BUST].png")).rel,
    await C.hashPath("img/faces/s_chat[BUST].png"),
  );
  eq(
    (await C.storagePath("img/characters/!Other10.png")).rel,
    await C.hashPath("img/characters/!Other10.png"),
  );
});

atest("storageNames maps a modder's tree to where the game keeps each file", async () => {
  const names = await D.storageNames([
    "data/System.json",
    "img/pictures/knife.png",
    "img/pictures/0123456789abcdef.png",
    "js/plugins/Mine.js",
    "movies/intro.webm",
  ]);
  eq(names.get("data/System.json"), HASHED);
  eq(names.get("img/pictures/knife.png"), await C.hashPath("img/pictures/knife.png"));
  // An extension a project tool appended to a storage name is stripped, the
  // hash itself is never hashed again.
  eq(names.get("img/pictures/0123456789abcdef.png"), "img/pictures/0123456789abcdef");
  // Everything the engine opens under its own name maps to itself.
  eq(names.get("js/plugins/Mine.js"), "js/plugins/Mine.js");
  eq(names.get("movies/intro.webm"), "movies/intro.webm");
});

// The rule every entry below follows: a file is laid down under the name and
// with the bytes the modder shipped, because the engine their mod runs with
// is the one that opened them that way. The game's own storage name is used
// only to FIND the player's copy of that file, so that the base game's
// content never has to travel in the package.
atest("a project-space overlay is laid down under the modder's own names", async () => {
  const keep = await C.hashPath("audio/bgm/keep.ogg");
  const swap = await C.hashPath("img/pictures/swap.png");
  const kept = new Uint8Array([1, 2, 3, 4]);
  const base = new Map([
    [HASHED, C.enkit(new TextEncoder().encode('{"a":1,"b":2}'), HASHED, 0)],
    [keep, C.enkit(kept, keep, 40)],
    [swap, C.enkit(new Uint8Array([9, 9]), swap, 0)],
  ]);
  for (let i = 0; i < 20; i++) {
    base.set("img/pictures/" + i.toString(16).padStart(16, "0"), new Uint8Array([i]));
  }
  const project = new Map([
    // Edited: a patch against the player's own file, replayed at the mod's name.
    ["data/System.json", new TextEncoder().encode('{"a":1,"b":3}')],
    // Untouched, only stored differently: the player's copy, laid down under
    // the name the mod's engine opens. Its bytes never enter the package.
    ["audio/bgm/keep.ogg", kept],
    // Replaced, and one the mod authored outright: as shipped.
    ["img/pictures/swap.png", new Uint8Array([7, 7])],
    ["img/pictures/mine.png", new Uint8Array([5, 5])],
    // The game's own track under a name of the modder's choosing: found by
    // content, laid down from the player's copy, nothing carried.
    ["audio/bgm/renamed.ogg", kept],
  ]);

  const baseNames = [...base.keys()];
  const modNames = [...project.keys()];
  const storage = await D.storageNames(modNames);
  eq(D.spaceProblem(baseNames, modNames), null, "no space refusal");
  eq(D.detectMode(baseNames, [...storage.values()]).mode, "overlay");

  const payloads = new Map();
  const r = await D.compare(memSource(base), memSource(project), payloads, () => {}, {
    mode: "overlay",
    storage,
  });
  eq(r.stats.patched, 1, "the edited data file is a patch");
  eq(r.stats.copied, 2, "the untouched track is the player's own copy, under both names");
  eq(r.stats.replaced, 1, "the replaced picture is verbatim");
  eq(r.stats.added, 1, "the modder's own picture is verbatim");
  eq(r.stats.deleted, 0, "an overlay deletes nothing");
  eq(r.stats.unchanged, 0, "nothing sits at a name the base already has");

  const byRel = new Map(r.files.map((f) => [f.rel, f]));
  const patch = byRel.get("data/System.json");
  eq(patch.type, "patch");
  eq(patch.from, HASHED, "the patch replays on the game's own storage name");
  eq(patch.enc, false, "and is written the way the modder's file is: plain");
  eq(JSON.stringify(patch.ops), JSON.stringify([{ op: "replace", path: "/b", value: 3 }]));

  const copy = byRel.get("audio/bgm/keep.ogg");
  eq(copy.type, "copy");
  eq(copy.from, keep);
  eq(copy.enc, false);
  assert(!("payload" in copy), "a copy carries no bytes");
  const renamed = byRel.get("audio/bgm/renamed.ogg");
  eq(renamed.type, "copy");
  eq(renamed.from, keep, "found by content, not by name");

  const rep = byRel.get("img/pictures/swap.png");
  eq(rep.type, "verbatim");
  eq(rep.enc, false);
  eq(Buffer.from(payloads.get(rep.payload)).toString("hex"), "0707");
  eq(byRel.get("img/pictures/mine.png").type, "verbatim");

  // The whole point: not one byte of the base game reaches the payloads.
  for (const [, bytes] of payloads) {
    assert(
      Buffer.from(bytes).toString("hex") !== Buffer.from(kept).toString("hex"),
      "an unchanged base file must never enter the package",
    );
  }
});

// The real shape of an overhaul's folder: a canonical Actor1.png beside a
// stale <hash>.png that also stands for Actor1. Both are files the modder
// shipped and both are laid down; which one their engine opens is its
// business, exactly as when the same folder is imported into the loader.
atest("two of the modder's files that stand for one game file are both kept", async () => {
  const hashed = await C.hashPath("img/characters/Actor1.png");
  const base = new Map([[hashed, C.enkit(new Uint8Array([1]), hashed, 0)]]);
  for (let i = 0; i < 20; i++) {
    base.set("img/pictures/" + i.toString(16).padStart(16, "0"), new Uint8Array([i]));
  }
  const project = new Map([
    ["img/characters/Actor1.png", new Uint8Array([2, 2, 2])],
    ["img/characters/" + hashed.split("/").pop() + ".png", new Uint8Array([3, 3, 3])],
  ]);
  const storage = await D.storageNames([...project.keys()]);
  eq(storage.get("img/characters/Actor1.png"), hashed);
  eq(storage.get("img/characters/" + hashed.split("/").pop() + ".png"), hashed);
  const payloads = new Map();
  const r = await D.compare(memSource(base), memSource(project), payloads, () => {}, {
    mode: "overlay",
    storage,
  });
  eq(r.files.length, 2, "both files travel");
  eq(r.files.filter((f) => f.type === "verbatim").length, 2);
  eq(r.stats.replaced, 2);
});

// A tree already in game space maps every name to itself, so nothing about
// the diff of a whole modded game changes: no copy, no from, same entries.
atest("a game-space tree diffs exactly as it did without a storage map", async () => {
  const base = new Map([
    [HASHED, C.enkit(new TextEncoder().encode('{"a":1}'), HASHED, 0)],
    ["js/plugins/A.js", new TextEncoder().encode("a")],
  ]);
  const modded = new Map([
    [HASHED, C.enkit(new TextEncoder().encode('{"a":2}'), HASHED, 0)],
    ["js/plugins/A.js", new TextEncoder().encode("a")],
  ]);
  const storage = await D.storageNames([...modded.keys()]);
  for (const [k, v] of storage) eq(v, k, k + " maps to itself");
  const p1 = new Map();
  const r1 = await D.compare(memSource(base), memSource(modded), p1, () => {});
  const p2 = new Map();
  const r2 = await D.compare(memSource(base), memSource(modded), p2, () => {}, { storage });
  eq(JSON.stringify(r1.files), JSON.stringify(r2.files));
  eq(r2.stats.copied, 0);
  assert(!("from" in r2.files[0]), "no from on a same-name patch");
});

atest("a full project-space copy deletes by the game's storage name", async () => {
  const gone = await C.hashPath("img/pictures/gone.png");
  const base = new Map([
    [HASHED, C.enkit(new TextEncoder().encode('{"a":1}'), HASHED, 0)],
    [gone, C.enkit(new Uint8Array([1]), gone, 0)],
    ["js/plugins/A.js", new TextEncoder().encode("a")],
  ]);
  const project = new Map([
    ["data/System.json", new TextEncoder().encode('{"a":1}')],
    ["js/plugins/A.js", new TextEncoder().encode("a")],
  ]);
  const storage = await D.storageNames([...project.keys()]);
  const r = await D.compare(memSource(base), memSource(project), new Map(), () => {}, {
    mode: "full",
    storage,
  });
  eq(r.stats.deleted, 1);
  const del = r.files.find((f) => f.type === "delete");
  eq(del.rel, gone, "the delete names the file the player actually has");
  eq(r.stats.copied, 1, "System.json is the player's own file under the mod's name");
  eq(r.stats.unchanged, 1, "the plugin is unchanged at its own name");
});

// Bundled plugins: the Browser Player's plugins ticked in create.html ride
// on top of the modded tree before the diff runs (bundlePlugins), and the
// registry is edited as text (registerPlugins).

console.log("\nbundled plugins:");

const REGISTRY =
  "// Generated by RPG Maker.\n// Do not edit this file directly.\nvar $plugins =\n[\n" +
  '{"name":"AudioStreaming","status":true,"description":"","parameters":{"x":"1"}},\n' +
  '{"name":"GameCode","status":true,"description":"","parameters":{}}\n' +
  "];\n";
const T = new TextEncoder();
const Dc = new TextDecoder();
function evalPlugins(text) {
  const fn = new Function(text + "; return $plugins;");
  return fn();
}

test("registerPlugins appends entries after the modder's own, as JSON lines", () => {
  const out = Dc.decode(
    D.registerPlugins(T.encode(REGISTRY), [
      { name: "MouseControl", description: "Mouse and touch control.", parameters: {} },
      { name: "ImprovedLoader", description: "Better save/load.", parameters: { Label: "auto" } },
    ]),
  );
  const list = evalPlugins(out);
  eq(list.length, 4);
  eq(list[0].name, "AudioStreaming");
  eq(list[1].name, "GameCode");
  eq(list[2].name, "MouseControl");
  eq(list[2].status, true);
  eq(list[3].name, "ImprovedLoader");
  eq(list[3].parameters.Label, "auto");
  // The modder's lines are byte-identical: only the tail of the array moved.
  assert(out.indexOf(REGISTRY.slice(0, REGISTRY.indexOf("\n];"))) === 0, "prefix kept verbatim");
  assert(/\n\];\n$/.test(out), "closing kept");
});

test("registerPlugins keeps the modder's line for a plugin already registered", () => {
  const own = REGISTRY.replace(
    '{"name":"GameCode"',
    '{"name":"MouseControl","status":false,"description":"mine","parameters":{"k":"v"}},\n{"name":"GameCode"',
  );
  const raw = T.encode(own);
  const out = D.registerPlugins(raw, [
    { name: "MouseControl", description: "Mouse and touch control.", parameters: {} },
  ]);
  // Nothing to add: the very same buffer comes back.
  assert(out === raw, "unchanged input returned as is");
  const both = Dc.decode(
    D.registerPlugins(raw, [
      { name: "MouseControl", description: "x", parameters: {} },
      { name: "UnlockAll", description: "y", parameters: {} },
    ]),
  );
  const list = evalPlugins(both);
  eq(list.length, 4);
  eq(list[1].name, "MouseControl");
  eq(list[1].status, false);
  eq(list[1].parameters.k, "v");
  eq(list[3].name, "UnlockAll");
});

test("registerPlugins handles an empty array and refuses a file without one", () => {
  const list = evalPlugins(
    Dc.decode(D.registerPlugins(T.encode("var $plugins = [];\n"), [{ name: "A" }])),
  );
  eq(list.length, 1);
  eq(list[0].name, "A");
  eq(list[0].status, true);
  eq(JSON.stringify(list[0].parameters), "{}");
  let threw = null;
  try {
    D.registerPlugins(T.encode("var nothing = 1;\n"), [{ name: "A" }]);
  } catch (e) {
    threw = e;
  }
  assert(threw && /\$plugins/.test(threw.message), "refuses a file with no $plugins array");
});

test("registerPlugins does not take a plugins.js list entry name from the file's own JS", () => {
  // A name inside a parameter value is not a registered plugin.
  const reg = 'var $plugins = [\n{"name":"X","status":true,"description":"","parameters":{"hint":"\\"name\\":\\"MouseControl\\""}}\n];\n';
  const list = evalPlugins(Dc.decode(D.registerPlugins(T.encode(reg), [{ name: "MouseControl" }])));
  // The escaped quotes inside the value do not read as a name key, so the
  // plugin is added.
  eq(list.length, 2);
  eq(list[1].name, "MouseControl");
});

atest("bundlePlugins lays the plugins over the tree and registers them in the modder's plugins.js", async () => {
  const mod = new Map([
    ["js/plugins.js", T.encode(REGISTRY)],
    ["js/plugins/GameCode.js", T.encode("// mine")],
    ["js/plugins/MouseControl.js", T.encode("// stale copy")],
  ]);
  const base = new Map([["js/plugins.js", T.encode("var $plugins = [];")]]);
  const src = await D.bundlePlugins(memSource(mod), memSource(base), [
    { file: "js/plugins/MouseControl.js", bytes: T.encode("// bundled"), name: "MouseControl", description: "m" },
    { file: "js/plugins/UnlockAll.js", bytes: T.encode("// unlock"), name: "UnlockAll", description: "u" },
  ]);
  const names = await src.list();
  eq(names.join(","), "js/plugins.js,js/plugins/GameCode.js,js/plugins/MouseControl.js,js/plugins/UnlockAll.js");
  eq(Dc.decode(await src.read("js/plugins/MouseControl.js")), "// bundled", "bundled copy replaces the tree's file");
  eq(Dc.decode(await src.read("js/plugins/GameCode.js")), "// mine", "untouched files read through");
  const list = evalPlugins(Dc.decode(await src.read("js/plugins.js")));
  eq(list.map((e) => e.name).join(","), "AudioStreaming,GameCode,MouseControl,UnlockAll");
  // Reads hand back fresh buffers, as memSource does for payload safety.
  const a = await src.read("js/plugins/UnlockAll.js");
  const b = await src.read("js/plugins/UnlockAll.js");
  assert(a !== b, "fresh buffer per read");
});

atest("bundlePlugins registers into the BASE plugins.js when the overlay ships none", async () => {
  const mod = new Map([["data/Actors.json", T.encode("[]")]]);
  const base = new Map([["js/plugins.js", T.encode(REGISTRY)]]);
  const src = await D.bundlePlugins(memSource(mod), memSource(base), [
    { file: "js/plugins/SeamlessMaps.js", bytes: T.encode("// s"), name: "SeamlessMaps" },
  ]);
  eq((await src.list()).join(","), "data/Actors.json,js/plugins.js,js/plugins/SeamlessMaps.js");
  const list = evalPlugins(Dc.decode(await src.read("js/plugins.js")));
  eq(list.map((e) => e.name).join(","), "AudioStreaming,GameCode,SeamlessMaps");
  // And with nothing ticked the tree is handed back untouched.
  const same = memSource(mod);
  assert((await D.bundlePlugins(same, memSource(base), [])) === same, "no plugins: same source");
});

atest("bundlePlugins fails when no registry exists anywhere", async () => {
  let threw = null;
  try {
    await D.bundlePlugins(memSource(new Map()), memSource(new Map()), [
      { file: "js/plugins/A.js", bytes: T.encode("a"), name: "A" },
    ]);
  } catch (e) {
    threw = e;
  }
  assert(threw && /plugins\.js/.test(threw.message), "names the missing registry");
});

atest("a bundled plugin travels verbatim and the registry as the modder's own file", async () => {
  // Through compare(): the plugin file is new (verbatim), and plugins.js,
  // now differing from the base's, is replaced rather than patched (it is
  // JS, not a JSON document).
  const base = new Map([
    [HASHED, C.enkit(T.encode(JSON.stringify({ gameTitle: "b" })), HASHED, 0)],
    ["js/plugins.js", T.encode(REGISTRY)],
  ]);
  const mod = new Map([["data/System.json", T.encode(JSON.stringify({ gameTitle: "b" }))]]);
  const storage = await D.storageNames(Array.from(mod.keys()).concat(["js/plugins.js", "js/plugins/MouseControl.js"]));
  const src = await D.bundlePlugins(memSource(mod), memSource(base), [
    { file: "js/plugins/MouseControl.js", bytes: T.encode("// bundled"), name: "MouseControl", description: "m" },
  ]);
  const payloads = new Map();
  const r = await D.compare(memSource(base), src, payloads, () => {}, { mode: "overlay", storage });
  const byRel = {};
  r.files.forEach((f) => { byRel[f.rel] = f; });
  eq(byRel["js/plugins/MouseControl.js"].type, "verbatim");
  eq(byRel["js/plugins.js"].type, "verbatim");
  eq(byRel["data/System.json"].type, "copy", "the game's own data file is a reference, not bytes");
  const reg = Dc.decode(payloads.get(byRel["js/plugins.js"].payload));
  eq(evalPlugins(reg).map((e) => e.name).join(","), "AudioStreaming,GameCode,MouseControl");
});


// A remaster mod may replace hashed files AND add new assets under their real
// names. That mix must not read as a project folder.
atest("a mixed-convention mod tree is not refused", async () => {
  const base = [];
  for (let i = 0; i < 200; i++) {
    base.push("audio/bgm/" + i.toString(16).padStart(16, "0"));
  }
  const mod = [];
  for (let i = 0; i < 20; i++) {
    mod.push("audio/bgm/" + i.toString(16).padStart(16, "0"));
  }
  for (let i = 0; i < 20; i++) mod.push("audio/bgm/mine" + i + ".ogg");
  eq(D.pathSpace(mod), null, "an even mix yields no verdict");
  eq(D.spaceProblem(base, mod), null, "and so is never refused on convention");
});

// Full copy vs overlay
//
// A mod is distributed either as a whole modded game or, far more often, as
// just the files it ships. The same missing base path means "deleted on
// purpose" in the first and "never touched" in the second, and reading an
// overlay as a full copy builds a package that deletes the player's game.

console.log("\nmod shape:");

function names(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push((prefix || "audio/bgm/") + i.toString(16).padStart(16, "0"));
  }
  return out;
}

test("a whole modded game reads as a full copy", () => {
  const base = names(200);
  const modded = base.slice();
  modded.splice(0, 3); // a mod may delete a few files and still be a full copy
  modded.push("audio/bgm/" + (900).toString(16).padStart(16, "0"));
  eq(D.detectMode(base, modded).mode, "full");
});

test("a tree holding only the mod's own files reads as an overlay", () => {
  const base = names(200);
  const overlay = base.slice(0, 12).concat(names(8, "img/pictures/"));
  const shape = D.detectMode(base, overlay);
  eq(shape.mode, "overlay");
  eq(shape.covered, 12);
  eq(shape.baseCount, 200);
});

atest("an overlay deletes nothing and reports what it left alone", async () => {
  const base = new Map();
  for (const rel of names(200)) {
    base.set(rel, new TextEncoder().encode("base " + rel));
  }
  const keys = [...base.keys()];
  // What a mod actually ships: a few replaced files and a few new ones.
  const overlay = new Map();
  for (let i = 0; i < 5; i++) {
    overlay.set(keys[i], new TextEncoder().encode("modded " + i));
  }
  overlay.set(keys[5], base.get(keys[5])); // shipped unchanged: still dropped
  for (let i = 0; i < 3; i++) {
    overlay.set("img/pictures/mine" + i, new TextEncoder().encode("mine " + i));
  }

  const payloads = new Map();
  const r = await D.compare(
    memSource(base),
    memSource(overlay),
    payloads,
    () => {},
    { mode: "overlay" },
  );
  eq(r.stats.mode, "overlay");
  eq(r.stats.deleted, 0, "an overlay must never delete a base file");
  eq(r.stats.replaced, 5);
  eq(r.stats.added, 3);
  eq(r.stats.unchanged, 1, "a file shipped identical to the base is dropped");
  eq(r.stats.untouched, 194, "and the rest of the game is reported as left alone");
  assert(
    !r.files.some((f) => f.type === "delete"),
    "no delete entry may reach the package",
  );
  eq(D.pairProblem(r.stats), null, "an overlay is not a mismatched pair");
});

// The same two trees built the old way: this is the package the user reported,
// and the reason the mode exists at all.
atest("the same overlay built as a full copy would delete the game", async () => {
  const base = new Map();
  for (const rel of names(200)) {
    base.set(rel, new TextEncoder().encode("base " + rel));
  }
  const keys = [...base.keys()];
  const overlay = new Map();
  for (let i = 0; i < 5; i++) {
    overlay.set(keys[i], new TextEncoder().encode("modded " + i));
  }
  const payloads = new Map();
  const r = await D.compare(memSource(base), memSource(overlay), payloads, () => {});
  eq(r.stats.mode, "full");
  eq(r.stats.deleted, 195, "every base file it does not carry reads as deleted");
  const problem = D.pairProblem(r.stats);
  assert(problem, "and forcing that shape must be refused");
  assert(
    /Only the files my mod changes/.test(problem),
    "the message must name the control that fixes it: " + problem,
  );
});

atest("a real mod, however large, is not refused", async () => {
  const base = new Map();
  for (let i = 0; i < 200; i++) {
    base.set("audio/bgm/" + i.toString(16).padStart(16, "0"), new TextEncoder().encode("bgm " + i));
  }
  // An overhaul: replaces a third of the game, drops a few files, adds its own.
  const modded = new Map(base);
  const keys = [...base.keys()];
  for (let i = 0; i < 70; i++) modded.set(keys[i], new TextEncoder().encode("new " + i));
  for (let i = 70; i < 80; i++) modded.delete(keys[i]);
  for (let i = 0; i < 40; i++) {
    modded.set("audio/bgm/" + (1000 + i).toString(16).padStart(16, "0"), new TextEncoder().encode("mine " + i));
  }
  const payloads = new Map();
  const r = await D.compare(memSource(base), memSource(modded), payloads, () => {});
  eq(D.pairProblem(r.stats), null, "an overhaul that keeps the game must build");
});

atest("an empty base against a full mod would copy the whole game (why the guard exists)", async () => {
  // Demonstrates the failure the guard prevents, at the compare() layer where
  // it genuinely happens. This is not a bug in compare, which is a pure
  // function of two trees; it is why the caller must validate its base.
  const mod = new Map();
  for (let i = 0; i < 20; i++) mod.set("data/f" + i, new TextEncoder().encode("game asset " + i));
  const payloads = new Map();
  const r = await D.compare(memSource(new Map()), memSource(mod), payloads, () => {});
  eq(r.files.length, 20, "every file of an unmatched tree classifies as added");
  eq(r.stats.added, 20);
  eq(payloads.size, 20, "and its bytes are all copied into the package");
});

// Summary

(async () => {
  await Promise.all(_pending);
  const total = passed + failed;
  console.log(
    `\n${total} tests:  \x1b[32m${passed} passed\x1b[0m` +
      (failed ? `, \x1b[31m${failed} failed\x1b[0m` : "") +
      "\n",
  );
  if (failed > 0) process.exit(1);
})();

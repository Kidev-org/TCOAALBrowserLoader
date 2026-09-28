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
 * Tests for app/js/libs/mod-install.js, the in-browser .tcoaalmod installer,
 * against an in-memory store laid out the way loader.html leaves IndexedDB
 * (the game's files under their plain storage names, encrypted as shipped).
 *
 * Run with: node tools/test-mod-install.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const nodeCrypto = require("crypto");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32mok\x1b[0m", name);
    passed++;
  } catch (e) {
    console.error("  \x1b[31mFAIL\x1b[0m", name);
    console.error("    ", e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n     ") : e);
    failed++;
  }
}

function eq(a, b, label) {
  if (a !== b) {
    throw new Error(`${label || "eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

async function rejects(p, re, label) {
  try {
    await p;
  } catch (e) {
    if (re && !re.test(String(e && e.message))) {
      throw new Error(`${label || "rejects"}: wrong message: ${e && e.message}`);
    }
    return;
  }
  throw new Error(`${label || "rejects"}: expected a rejection`);
}

const LIBS = [
  "app/js/libs/tcoaal-codec.js",
  "app/js/libs/json-diff.js",
  "app/js/libs/mod-package.js",
  "app/js/libs/mod-install.js",
];

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
for (const rel of LIBS) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx);
}
const { TcoaalCodec: C, ModPackage: P, ModInstall: I } = ctx.self;

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// A Map-backed store with the adapter shape idbStore() returns.
function memStore(init) {
  const m = new Map(init || []);
  return {
    map: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    putMany: async (pairs) => {
      for (const [k, v] of pairs) m.set(k, v);
    },
    keys: async (prefix) => [...m.keys()].filter((k) => k.indexOf(prefix || "") === 0).sort(),
    deleteMany: async (keys) => {
      for (const k of keys) m.delete(k);
    },
  };
}

function bytesOf(v) {
  if (v == null) return null;
  if (typeof v === "string") return enc(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v);
}

// The shipped game, as loader.html stores it: data under hashed names inside
// a TCOAAL container, a plugin file under its own name.
async function makeBase(versionId, extra) {
  const sysRel = await C.hashPath("data/System.json");
  const actorsRel = await C.hashPath("data/Actors.json");
  const picRel = await C.hashPath("img/pictures/cameraview.png");
  const system = { versionId: versionId, gameTitle: "Base" };
  const actors = [null, { id: 1, name: "Andrew", nickname: "" }, { id: 2, name: "Ashley", nickname: "" }];
  const files = [
    [sysRel, C.enkit(enc(JSON.stringify(system)), sysRel, 0).buffer],
    [actorsRel, C.enkit(enc(JSON.stringify(actors)), actorsRel, 0).buffer],
    [picRel, C.enkit(enc("PNG-cameraview"), picRel, 16).buffer],
    ["js/plugins.js", enc("var $plugins = [];").buffer],
    // Not game files: must not count toward the fingerprint.
    ["__active_mod__", "x"],
    ["mod:other:js/a.js", enc("a").buffer],
  ].concat(extra || []);
  return { store: memStore(files), sysRel, actorsRel, picRel, count: 4 + (extra || []).length };
}

async function buildPackage(o) {
  const payloads = new Map(Object.entries(o.payloads || {}).map(([k, v]) => [k, typeof v === "string" ? enc(v) : v]));
  const bytes = await P.build({
    id: o.id || "test-mod",
    name: o.name || "Test Mod",
    author: "tester",
    version: o.version || "1.0.0",
    icon: o.icon || null,
    variants: o.variants,
    payloads,
    online: o.online,
  });
  return bytes;
}

function variant(fp, files, label) {
  return { base: { label: label || "Remaster " + (fp.version || "?"), fingerprint: fp }, files };
}

(async function main() {
  console.log("\nmod-install:");

  await test("verbatim, copy and patch entries land under mod:{id}: as plain files", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      icon: enc("ICON"),
      variants: [
        variant({ version: "123", files: b.count }, [
          { rel: "js/plugins/New.js", type: "verbatim", payload: "payload/0" },
          { rel: "img/pictures/cameraview.png", type: "copy", from: b.picRel, enc: false },
          {
            rel: "data/Actors.json",
            type: "patch",
            from: b.actorsRel,
            ops: [{ op: "replace", path: "/1/name", value: "Andy" }],
          },
          { rel: "data/Gone.json", type: "delete" },
          { rel: "languages/english/dialogue.loc", type: "verbatim", payload: "payload/1" },
        ]),
      ],
      payloads: { "payload/0": "console.log('new');", "payload/1": '   {"linesLUT":{}}' },
    });
    const r = await I.install({ store: b.store, bytes: pkg });
    eq(r.id, "test-mod");
    eq(dec(bytesOf(b.store.map.get("mod:test-mod:js/plugins/New.js"))), "console.log('new');");
    eq(dec(bytesOf(b.store.map.get("mod:test-mod:img/pictures/cameraview.png"))), "PNG-cameraview", "copy is decoded");
    const actors = JSON.parse(dec(bytesOf(b.store.map.get("mod:test-mod:data/Actors.json"))));
    eq(actors[1].name, "Andy", "patch applied");
    eq(actors[2].name, "Ashley", "rest of the document kept");
    assert(!b.store.map.has("mod:test-mod:data/Gone.json"), "a delete writes nothing");
    eq(r.stats.copied, 1);
    eq(r.stats.patched, 1);
    eq(r.stats.verbatim, 2);
    eq(r.stats.deleted, 1);
    eq(dec(r.icon), "ICON");
    eq(r.langFile, "languages/english/dialogue.loc");
    // Base untouched.
    assert(C.isEncrypted(bytesOf(b.store.map.get(b.actorsRel))), "the base game stays as imported");
  });

  await test("a reinstall drops files the new version no longer ships, and leaves other mods alone", async () => {
    const b = await makeBase("123");
    const v1 = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "js/a.js", type: "verbatim", payload: "p/a" },
        { rel: "js/b.js", type: "verbatim", payload: "p/b" },
      ])],
      payloads: { "p/a": "A", "p/b": "B" },
    });
    await I.install({ store: b.store, bytes: v1 });
    const v2 = await buildPackage({
      version: "2.0.0",
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "js/a.js", type: "verbatim", payload: "p/a" },
      ])],
      payloads: { "p/a": "A2" },
    });
    const r = await I.install({ store: b.store, bytes: v2 });
    eq(r.manifest.version, "2.0.0");
    eq(dec(bytesOf(b.store.map.get("mod:test-mod:js/a.js"))), "A2");
    assert(!b.store.map.has("mod:test-mod:js/b.js"), "stale file removed");
    assert(b.store.map.has("mod:other:js/a.js"), "another mod's key is untouched");
  });

  await test("a `from` written earlier in the same install is read from the mod, as the native loader does", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "data/X.json", type: "verbatim", payload: "p/x" },
        { rel: "data/Y.json", type: "patch", from: "data/X.json", ops: [{ op: "add", path: "/b", value: 2 }] },
      ])],
      payloads: { "p/x": '{"a":1}' },
    });
    await I.install({ store: b.store, bytes: pkg });
    eq(dec(bytesOf(b.store.map.get("mod:test-mod:data/Y.json"))), '{"a":1,"b":2}');
  });

  await test("variant order: versionId, then file count, then the nearest release", async () => {
    const base = { version: "200", files: 10, gameVersion: "3.0.12" };
    const a = variant({ version: "100", files: 10 }, []);
    const bb = variant({ version: "200", files: 99 }, []);
    eq(I.selectVariant({ variants: [a, bb] }, base), bb, "version wins over count");
    eq(I.selectVariant({ variants: [variant({ version: "1", files: 10 }, [])] }, { version: null, files: 10 }).base.fingerprint.files, 10, "count");
    // selectVariant never guesses; install tries the others (rankVariants).
    eq(I.selectVariant({ variants: [a] }, { version: "999", files: 5 }), null, "no guess");
    const v2 = variant({ version: "7", files: 7 }, [], "v2.0.14");
    const v313 = variant({ version: "8", files: 8 }, [], "v3.0.13");
    const v310 = variant({ version: "9", files: 9 }, [], "v3.0.10");
    const unknown = variant({ version: "6", files: 6 }, [], "some build");
    const order = I.rankVariants({ variants: [unknown, v2, v310, v313] }, base);
    eq(order.map((v) => v.base.label).join(","), "v3.0.13,v3.0.10,v2.0.14,some build");
    eq(I.variantGameVersion(v313), "3.0.13");
  });

  await test("a mod built on another release is installed when it applies", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "1", files: 1 }, [
        { rel: "js/a.js", type: "verbatim", payload: "p" },
      ], "v3.0.13")],
      payloads: { p: "x" },
    });
    const r = await I.install({ store: b.store, bytes: pkg });
    eq(r.variant.base.label, "v3.0.13");
    assert(b.store.map.has("mod:test-mod:js/a.js"));
  });

  await test("a mod that does not apply names the release it needs, and writes nothing", async () => {
    const b = await makeBase("123");
    const before = [...b.store.map.keys()].join("|");
    const pkg = await buildPackage({
      variants: [variant({ version: "1", files: 1 }, [
        { rel: "js/a.js", type: "verbatim", payload: "p" },
        { rel: "img/x.png", type: "copy", from: "img/pictures/0000000000000000" },
      ], "v3.0.13")],
      payloads: { p: "x" },
    });
    let err = null;
    try {
      await I.install({ store: b.store, bytes: pkg });
    } catch (e) {
      err = e;
    }
    assert(err, "expected a refusal");
    eq(err.code, "GAME_VERSION");
    eq(err.short, "v3.0.13 is required");
    assert(/does not work with your version of the game.*v3\.0\.13 is required/.test(err.message), err.message);
    assert(/needs img\/pictures\/0000000000000000 for img\/x\.png/.test(err.problems.join("\n")), "the reason is kept");
    eq([...b.store.map.keys()].join("|"), before, "nothing written");
  });

  await test("an update that does not apply leaves the installed version whole", async () => {
    const b = await makeBase("123");
    const v1 = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "js/a.js", type: "verbatim", payload: "p" },
      ])],
      payloads: { p: "one" },
    });
    await I.install({ store: b.store, bytes: v1 });
    const v2 = await buildPackage({
      variants: [variant({ version: "1", files: 1 }, [
        { rel: "js/a.js", type: "verbatim", payload: "p" },
        { rel: "data/Y.json", type: "patch", from: "data/Missing.json", ops: [] },
      ], "v9.0.0")],
      payloads: { p: "two" },
    });
    await rejects(I.install({ store: b.store, bytes: v2 }), /v9\.0\.0 is required/);
    eq(dec(bytesOf(b.store.map.get("mod:test-mod:js/a.js"))), "one");
  });

  await test("of several releases, the first that applies is taken", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [
        variant({ version: "1", files: 1 }, [
          { rel: "img/x.png", type: "copy", from: "img/pictures/0000000000000000" },
        ], "v3.0.13"),
        variant({ version: "2", files: 2 }, [
          { rel: "js/b.js", type: "verbatim", payload: "p" },
        ], "v3.0.10"),
      ],
      payloads: { p: "x" },
    });
    const r = await I.install({ store: b.store, bytes: pkg });
    eq(r.variant.base.label, "v3.0.10");
    assert(!b.store.map.has("mod:test-mod:img/x.png"));
  });

  await test("several required releases are all named", async () => {
    const b = await makeBase("123");
    const bad = [{ rel: "img/x.png", type: "copy", from: "img/pictures/0000000000000000" }];
    const pkg = await buildPackage({
      variants: [
        variant({ version: "1", files: 1 }, bad, "v3.0.12"),
        variant({ version: "2", files: 2 }, bad, "v3.0.13"),
      ],
    });
    await rejects(I.install({ store: b.store, bytes: pkg }), /v3\.0\.12 or v3\.0\.13 is required/);
  });

  await test("no imported game is refused before anything is written", async () => {
    const pkg = await buildPackage({ variants: [variant({ version: "1", files: 1 }, [])] });
    const s = memStore();
    await rejects(I.install({ store: s, bytes: pkg }), /Import your copy of the game first/);
    eq(s.map.size, 0);
  });

  await test("a copy whose source the game lacks names the file", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "img/x.png", type: "copy", from: "img/pictures/0000000000000000" },
      ])],
    });
    let err = null;
    try {
      await I.install({ store: b.store, bytes: pkg });
    } catch (e) {
      err = e;
    }
    assert(err && /needs img\/pictures\/0000000000000000 for img\/x\.png/.test(err.problems.join("\n")));
  });

  await test("unsafe paths are refused", async () => {
    for (const rel of ["../x", "/etc/x", "a//b", "C:/x", "a\\b", "./a"]) {
      eq(I.safeRel(rel), false, rel);
    }
    eq(I.safeRel("img/pictures/a b.png"), true);
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [{ rel: "../evil", type: "verbatim", payload: "p" }])],
      payloads: { p: "x" },
    });
    await rejects(I.install({ store: b.store, bytes: pkg }), /unsafe path/);
  });

  await test("an id override installs under the catalog key", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [{ rel: "js/a.js", type: "verbatim", payload: "p" }])],
      payloads: { p: "x" },
    });
    await I.install({ store: b.store, bytes: pkg, id: "MyCatalogMod" });
    assert(b.store.map.has("mod:MyCatalogMod:js/a.js"));
  });

  await test("an online placeholder without a fetcher is refused; not-a-zip says so", async () => {
    const b = await makeBase("123");
    const ph = await buildPackage({ variants: [], online: { github: "octo/mod" } });
    await rejects(I.install({ store: b.store, bytes: ph }), /link to the mod, not the mod itself/);
    await rejects(I.install({ store: b.store, bytes: enc("hello") }), /not a \.tcoaalmod mod/);
  });

  await test("an online placeholder downloads its package through the GitHub API asset endpoint", async () => {
    const b = await makeBase("123");
    const real = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [{ rel: "js/a.js", type: "verbatim", payload: "p" }])],
      payloads: { p: "downloaded" },
    });
    const ph = await buildPackage({ variants: [], online: { github: "octo/mod" } });
    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push([url, (init && init.headers && init.headers.Accept) || ""]);
      if (url === "https://api.github.com/repos/octo/mod/releases/latest") {
        return new Response(JSON.stringify({ assets: [{ name: "mod.tcoaalmod", url: "https://api.github.com/repos/octo/mod/releases/assets/7" }] }));
      }
      if (url === "https://api.github.com/repos/octo/mod/releases/assets/7") return new Response(real);
      return new Response("", { status: 404 });
    };
    await I.install({ store: b.store, bytes: ph, fetch: fakeFetch });
    eq(dec(bytesOf(b.store.map.get("mod:test-mod:js/a.js"))), "downloaded");
    eq(seen[1][1], "application/octet-stream", "asset fetched as bytes");
  });

  await test("a download that answers to another id is refused", async () => {
    const b = await makeBase("123");
    const real = await buildPackage({ id: "other-mod", variants: [variant({ version: "123", files: b.count }, [])] });
    const ph = await buildPackage({ variants: [], online: { url: "https://example.com/m.tcoaalmod" } });
    await rejects(
      I.install({ store: b.store, bytes: ph, fetch: async () => new Response(real) }),
      /"other-mod", not "test-mod"/,
    );
  });

  await test("ModPackage.open reads lazily and agrees with readZip", async () => {
    const pkg = await buildPackage({
      variants: [variant({ version: "1", files: 1 }, [{ rel: "a", type: "verbatim", payload: "p" }])],
      payloads: { p: "x".repeat(5000) },
    });
    const full = await P.readZip(pkg);
    const lazy = await P.open(pkg);
    eq(lazy.manifest.id, "test-mod");
    for (const [name, data] of full) eq(dec(await lazy.zip.read(name)), dec(data), name);
    eq(await lazy.zip.read("nope"), null);
  });

  await test("detectLangFile (names only) prefers English, then data/dialogues, then the hashed CLD", async () => {
    eq(I.detectLangFile(["languages/french/dialogue.loc", "languages/english/dialogue.loc"]), "languages/english/dialogue.loc");
    eq(I.detectLangFile(["languages/french/dialogue.loc"]), "languages/french/dialogue.loc");
    eq(I.detectLangFile(["data/9c7050ae76645487", "data/dialogues", "img/a.png"]), "data/dialogues");
    eq(I.detectLangFile(["img/a.png"]), null);
  });

  // The regression: a mod keeping its dialogue as a LANGDATA blob under the
  // game's own hashed name got the base game's dialogue, and every line showed
  // as its raw key ("(label)[Narrator] (lines)[wait30]").
  await test("the language file is found by content, wherever the mod keeps it", async () => {
    const b = await makeBase("123");
    const cld = 'LANGDATA{"langName":"English","linesLUT":{"(lines)[wait30]":"Hello"},"labelLUT":{"(label)[Narrator]":"Narrator"}}';
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "data/9c7050ae76645487", type: "verbatim", payload: "p/cld" },
        { rel: "data/Map001.json", type: "verbatim", payload: "p/map" },
        { rel: "img/pictures/linesLUT.png", type: "verbatim", payload: "p/img" },
      ])],
      payloads: { "p/cld": cld, "p/map": '{"events":[],"note":"no tables here"}', "p/img": "linesLUT" },
    });
    const r = await I.install({ store: b.store, bytes: pkg });
    eq(r.langFile, "data/9c7050ae76645487");
    const doc = JSON.parse(r.langData);
    eq(doc.linesLUT["(lines)[wait30]"], "Hello", "langData is the parsed document, LANGDATA prefix dropped");
  });

  await test("an unusual path is found too, and English wins over another language", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "lang/fr.json", type: "verbatim", payload: "p/fr" },
        { rel: "languages/english/strings.loc", type: "verbatim", payload: "p/en" },
      ])],
      payloads: { "p/fr": '{"linesLUT":{"a":"Bonjour"}}', "p/en": '      {"linesLUT":{"a":"Hi"}}' },
    });
    const r = await I.install({ store: b.store, bytes: pkg });
    eq(r.langFile, "languages/english/strings.loc");
    eq(JSON.parse(r.langData).linesLUT.a, "Hi");
    const lone = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "lang/fr.json", type: "verbatim", payload: "p/fr" },
      ])],
      payloads: { "p/fr": '{"linesLUT":{"a":"Bonjour"}}' },
    });
    eq((await I.install({ store: b.store, bytes: lone })).langFile, "lang/fr.json");
  });

  await test("no language file: langFile and langData are null, and a broken candidate is skipped", async () => {
    const b = await makeBase("123");
    const pkg = await buildPackage({
      variants: [variant({ version: "123", files: b.count }, [
        { rel: "data/broken", type: "verbatim", payload: "p/x" },
        { rel: "languages/english/dialogue.txt", type: "verbatim", payload: "p/t" },
      ])],
      payloads: { "p/x": '{"linesLUT": oops', "p/t": '{"linesLUT":{}}' },
    });
    const r = await I.install({ store: b.store, bytes: pkg });
    eq(r.langFile, null);
    eq(r.langData, null);
  });

  console.log("\nModPackage.fetchEntry (icon of a package that is not downloaded):");

  // A fetch that streams a package in small chunks and counts how much of it
  // was actually pulled before the reader let go.
  function streamFetch(bytes, opts) {
    const o = opts || {};
    const fn = async () => {
      let pos = 0;
      const body = new ReadableStream({
        pull(c) {
          if (pos >= bytes.length) {
            c.close();
            return;
          }
          const n = Math.min(16 * 1024, bytes.length - pos);
          c.enqueue(bytes.slice(pos, pos + n));
          pos += n;
          fn.pulled = pos;
        },
        cancel() {
          fn.cancelled = true;
        },
      });
      return new Response(body, { status: o.status || 200 });
    };
    fn.pulled = 0;
    fn.cancelled = false;
    return fn;
  }

  // Random bytes: deflate cannot shrink them, so the package really is
  // megabytes long and the icon really is 40 KB into it.
  const ICON = new Uint8Array(nodeCrypto.randomBytes(40000));
  const bigPayload = new Uint8Array(nodeCrypto.randomBytes(3 * 1024 * 1024));
  const iconPkg = await buildPackage({
    icon: ICON,
    variants: [variant({ version: "1" }, [{ rel: "img/x.png", type: "verbatim", payload: "p/big" }])],
    payloads: { "p/big": bigPayload },
  });

  await test("reads the icon off the start of the package and lets go of the rest", async () => {
    const f = streamFetch(iconPkg);
    const got = await P.fetchEntry("https://host/m.tcoaalmod", "icon.png", f);
    assert(got, "no icon");
    eq(Buffer.compare(Buffer.from(got), Buffer.from(ICON)), 0, "icon bytes");
    assert(f.pulled < iconPkg.length / 4, `pulled ${f.pulled} of ${iconPkg.length}`);
    assert(f.cancelled, "the stream was not cancelled");
  });

  await test("a package without an icon resolves to null", async () => {
    const pkg = await buildPackage({ variants: [variant({ version: "1" }, [])] });
    eq(await P.fetchEntry("https://host/m.tcoaalmod", "icon.png", streamFetch(pkg)), null);
  });

  await test("an HTTP error or a body that is not a zip gives null", async () => {
    eq(await P.fetchEntry("u", "icon.png", streamFetch(iconPkg, { status: 404 })), null);
    const html = enc("<!DOCTYPE html><html>not found</html>".repeat(40));
    eq(await P.fetchEntry("u", "icon.png", streamFetch(html)), null);
  });

  await test("a package cut short before the icon ends gives null", async () => {
    const cut = iconPkg.slice(0, 200 + ICON.length / 2);
    eq(await P.fetchEntry("u", "icon.png", streamFetch(cut)), null);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

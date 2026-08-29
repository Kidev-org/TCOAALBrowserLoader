#!/usr/bin/env node
/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/*
 * End-to-end test for tools/mod-apply.js: builds a real .tcoaalmod out of a
 * synthetic shipped tree with app/js/libs (exactly as app/create.html does),
 * then drives the CLI (--info, --apply, --rollback) as a child process and
 * asserts the game folder round-trips byte for byte.
 *
 * Run with: node tools/test-mod-apply.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let passed = 0,
  failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label || "eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function test(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32m+\x1b[0m", name);
    passed++;
  } catch (e) {
    console.error("  \x1b[31mx\x1b[0m", name);
    console.error("    ", e.message);
    failed++;
  }
}

function loadLibs() {
  const ctx = vm.createContext({
    self: {},
    crypto: globalThis.crypto || require("crypto").webcrypto,
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    Response,
    console,
  });
  for (const rel of [
    "app/js/libs/tcoaal-codec.js",
    "app/js/libs/json-diff.js",
    "app/js/libs/mod-package.js",
    "app/js/libs/mod-diff-worker.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx);
  }
  return ctx.self;
}

const L = loadLibs();
const C = L.TcoaalCodec;
const P = L.ModPackage;
const D = L.ModDiff;

const SYSTEM = "data/be1a37535e921f91"; // hashPath("data/System.json")
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** A tiny shipped tree: an encrypted JSON data file, an encrypted image, a
 *  plain plugin, and one file the mod deletes. */
function baseTree() {
  const m = new Map();
  m.set(SYSTEM, C.enkit(enc(JSON.stringify({ gameTitle: "TCOAAL", versionId: 30800, locale: "en" })), SYSTEM, 0));
  m.set("img/pictures/0123456789abcdef", C.enkit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "img/pictures/0123456789abcdef", 4));
  m.set("js/plugins/Stock.js", enc("var stock = 1;\n"));
  m.set("js/rpg_core.js", enc("// engine\n"));
  return m;
}

function moddedTree(base) {
  const m = new Map(base);
  const sys = JSON.parse(dec(C.dekit(base.get(SYSTEM), SYSTEM)));
  sys.gameTitle = "TCOAAL (modded)";
  m.set(SYSTEM, C.enkit(enc(JSON.stringify(sys)), SYSTEM, 0));
  m.set("img/pictures/0123456789abcdef", C.enkit(new Uint8Array([9, 9, 9]), "img/pictures/0123456789abcdef", 4));
  m.set("js/plugins/Mine.js", enc("var mine = 1;\n"));
  m.delete("js/plugins/Stock.js");
  return m;
}

function writeTree(dir, tree) {
  for (const [rel, bytes] of tree) {
    const abs = path.join(dir, "www", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
}

function readTree(dir) {
  const www = path.join(dir, "www");
  const out = new Map();
  (function walk(d, base) {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const rel = base ? base + "/" + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else out.set(rel, new Uint8Array(fs.readFileSync(full)));
    }
  })(www, "");
  return out;
}

function hex(b) {
  return Buffer.from(b).toString("hex");
}

function sameTree(a, b) {
  if (a.size !== b.size) return `size ${a.size} != ${b.size}`;
  for (const [k, v] of a) {
    if (!b.has(k)) return `missing ${k}`;
    if (hex(v) !== hex(b.get(k))) return `bytes differ for ${k}`;
  }
  return null;
}

function run(args, opts) {
  return execFileSync(process.execPath, [path.join(ROOT, "tools/mod-apply.js"), ...args], {
    encoding: "utf8",
    ...(opts || {}),
  });
}

async function buildMod(base, modded, fp) {
  const payloads = new Map();
  const r = await D.compare(D.memSource(base), D.memSource(modded), payloads, () => {});
  return {
    bytes: await P.build({
      id: "test-mod",
      name: "Test Mod",
      author: "kidev",
      version: "1.0.0",
      description: "",
      icon: null,
      saves: "isolated",
      update: null,
      theme: [],
      payloads,
      variants: [
        {
          base: { label: "v3.0.8", fingerprint: fp, steam: { appid: "2378900", name: "v3.0.8" } },
          files: r.files,
          stats: r.stats,
        },
      ],
    }),
    files: r.files,
  };
}

(async function main() {
  console.log("\nmod-apply:");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcoaal-modapply-"));
  const game = path.join(tmp, "game");
  const base = baseTree();
  const modded = moddedTree(base);
  writeTree(game, base);
  const fp = await D.fingerprint(D.memSource(base));
  const { bytes, files } = await buildMod(base, modded, fp);
  const modFile = path.join(tmp, "test-mod-1.0.0.tcoaalmod");
  fs.writeFileSync(modFile, bytes);

  await test("the package carries one entry per change and nothing else", () => {
    eq(files.length, 4, "changed entries");
    assert(
      files.some((f) => f.rel === SYSTEM && f.type === "patch"),
      "System.json must travel as a JSON patch",
    );
    assert(
      files.some((f) => f.rel === "js/plugins/Stock.js" && f.type === "delete"),
      "the removed plugin must travel as a delete",
    );
  });

  await test("--info reports the mod and its supported versions", () => {
    const out = JSON.parse(run(["--info", modFile]));
    eq(out.name, "Test Mod");
    eq(out.version, "1.0.0");
    eq(out.variants.length, 1);
    eq(out.variants[0].label, "v3.0.8");
    eq(out.variants[0].steam.appid, "2378900");
  });

  await test("--apply reproduces the modded tree byte for byte", () => {
    run(["--apply", modFile, "--base", game]);
    const diff = sameTree(readTree(game), modded);
    assert(!diff, "applied tree differs: " + diff);
  });

  await test("an installed mod leaves an undo archive at the game root", () => {
    assert(fs.existsSync(path.join(game, ".tcoaalmod-rollback.zip")), "no rollback archive");
  });

  await test("a second install is refused while one is applied", () => {
    let threw = false;
    try {
      run(["--apply", modFile, "--base", game], { stdio: "pipe" });
    } catch (e) {
      threw = true;
      assert(/already installed/.test(String(e.stderr)), "wrong error: " + e.stderr);
    }
    assert(threw, "a second --apply must fail");
  });

  await test("--rollback restores the original game byte for byte", () => {
    run(["--rollback", game]);
    const diff = sameTree(readTree(game), base);
    assert(!diff, "restored tree differs: " + diff);
    assert(!fs.existsSync(path.join(game, ".tcoaalmod-rollback.zip")), "archive must be gone");
  });

  await test("--out builds a standalone modded tree and leaves the game alone", () => {
    const out = path.join(tmp, "modded-www");
    run(["--apply", modFile, "--base", game, "--out", out]);
    const got = new Map();
    (function walk(d, b) {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const rel = b ? b + "/" + name : name;
        if (fs.statSync(full).isDirectory()) walk(full, rel);
        else got.set(rel, new Uint8Array(fs.readFileSync(full)));
      }
    })(out, "");
    const diff = sameTree(got, modded);
    assert(!diff, "standalone tree differs: " + diff);
    const untouched = sameTree(readTree(game), base);
    assert(!untouched, "the base game was modified: " + untouched);
    assert(!fs.existsSync(path.join(game, ".tcoaalmod-rollback.zip")), "no archive for --out");
  });

  await test("a mod for another version is refused unless forced", async () => {
    const other = new Map(base);
    other.set("js/rpg_core.js", enc("// other engine\n"));
    const otherFp = await D.fingerprint(D.memSource(other));
    otherFp.version = "30900";
    const two = await buildMod(base, modded, fp);
    // Two variants, neither matching the game: strict selection must refuse.
    const manifestPatched = await P.parse(two.bytes);
    manifestPatched.manifest.variants.push({
      base: { label: "v3.0.9", fingerprint: otherFp },
      files: two.files,
      stats: {},
    });
    manifestPatched.manifest.variants[0].base.fingerprint = otherFp;
    const rebuilt = [];
    manifestPatched.entries.forEach((data, name) => {
      rebuilt.push({
        name,
        data:
          name === "mod.json"
            ? enc(JSON.stringify(manifestPatched.manifest))
            : data,
      });
    });
    const bad = path.join(tmp, "bad.tcoaalmod");
    fs.writeFileSync(bad, await P.writeZip(rebuilt));
    let threw = false;
    try {
      run(["--apply", bad, "--base", game], { stdio: "pipe" });
    } catch (e) {
      threw = true;
      assert(/does not support your version/.test(String(e.stderr)), "wrong error: " + e.stderr);
    }
    assert(threw, "an unmatched mod must be refused");
    run(["--apply", bad, "--base", game, "--force"]);
    run(["--rollback", game]);
  });

  await test("a mod with a traversing path is refused", async () => {
    const parsed = await P.parse(bytes);
    parsed.manifest.variants[0].files = [
      { rel: "../../evil.js", type: "verbatim", enc: false, payload: "f/x" },
    ];
    const rebuilt = [];
    parsed.entries.forEach((data, name) => {
      rebuilt.push({ name, data: name === "mod.json" ? enc(JSON.stringify(parsed.manifest)) : data });
    });
    const evil = path.join(tmp, "evil.tcoaalmod");
    fs.writeFileSync(evil, await P.writeZip(rebuilt));
    let threw = false;
    try {
      run(["--apply", evil, "--base", game], { stdio: "pipe" });
    } catch (e) {
      threw = true;
      assert(/unsafe path/.test(String(e.stderr)), "wrong error: " + e.stderr);
    }
    assert(threw, "a traversing path must be refused");
    assert(!fs.existsSync(path.join(tmp, "evil.js")), "nothing may be written outside the game");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();

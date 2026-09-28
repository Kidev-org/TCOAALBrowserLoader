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
 * tools/build-mod.js, the release workflow's builder, against a synthetic
 * game (its reference index in .config/base-index.json, as create.html's
 * GitHub kit writes it) and a local site serving the plugins, then installed
 * with the browser installer to prove the package means what the builder
 * says.
 *
 * Installers are not stamped here (they need the published stubs):
 * tools/test-stub-stamp.js covers stamping, and the workflow's own run is
 * the check that the published stubs take a CI-built package.
 *
 * Run with: node tools/test-build-mod.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { loadLibs } = require("./lib/load-libs.js");
const { build, readConfig, isSafeRelPath } = require("./build-mod.js");
const { buildIndex } = require("./base-index.js");

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
  if (a !== b) throw new Error(`${label || "eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assert(c, m) {
  if (!c) throw new Error(m || "assertion failed");
}
async function rejects(p, re) {
  try {
    await p;
  } catch (e) {
    if (re && !re.test(String(e && e.message))) throw new Error("wrong message: " + (e && e.message));
    return;
  }
  throw new Error("expected a rejection");
}

const L = loadLibs(["tcoaal-codec", "json-diff", "mod-package", "mod-install", "bundled-plugins"]);
const C = L.TcoaalCodec;
const enc = (s) => new TextEncoder().encode(s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-mod-"));

function put(root, rel, bytes) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, bytes);
}

// A shipped game: data and pictures under hashed names in TCOAAL containers.
async function makeGame(dir) {
  const files = {
    "data/System.json": '{"versionId":4242}',
    "data/Actors.json": '[null,{"name":"Andrew"}]',
    "data/Map001.json": '{"displayName":"Home","events":[]}',
    "img/pictures/cameraview.png": "PNG-camera",
  };
  for (const [logical, text] of Object.entries(files)) {
    const rel = (await C.storagePath(logical)).rel;
    put(dir, rel, C.enkit(enc(text), rel, 0));
  }
  put(dir, "js/main.js", 'var GAME_VERSION = "3.0.13";');
  put(dir, "js/plugins.js", 'var $plugins =\n[\n{"name":"Base","status":true,"description":"","parameters":{}}\n];\n');
  put(dir, "Copyrights - Coffin of Andy and Leyley.txt", "notice");
}

// A local site serving what the builder downloads.
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.statusCode = 404;
        return res.end();
      }
      res.end(fs.readFileSync(f));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function writeConfig(repo, over) {
  const cfg = Object.assign(
    { id: "test-mod", name: "Test Mod", author: "me", game: "3.0.13" },
    over || {},
  );
  put(repo, ".config/mod.json", JSON.stringify(cfg));
}

(async () => {
  const game = path.join(tmp, "game");
  const site = path.join(tmp, "site");
  await makeGame(game);
  const index = await buildIndex(game);
  put(site, "plugins/MouseControl.js", "/* MouseControl */");
  const server = await serve(site);
  const siteUrl = "http://127.0.0.1:" + server.address().port;
  const quiet = () => {};

  console.log("\nbuild-mod config:");

  await test("mod.json is checked with create.html's rules", async () => {
    const repo = path.join(tmp, "cfg");
    put(repo, "www/a.txt", "x");
    writeConfig(repo, { id: "Bad_Id", game: "latest", saves: "maybe", plugins: ["Nope"] });
    let msg = "";
    try {
      readConfig(repo, L.BundledPlugins);
    } catch (e) {
      msg = e.message;
    }
    assert(/"id"/.test(msg) && /"game"/.test(msg) && /"saves"/.test(msg) && /unknown plugin "Nope"/.test(msg), msg);
  });

  await test("mod.json falls back on the repository's name, owner and description", async () => {
    const repo = path.join(tmp, "cfgdefaults");
    put(repo, "www/a.txt", "x");
    put(repo, ".config/mod.json", JSON.stringify({ game: "3.0.13", name: "", author: "" }));
    const cfg = readConfig(repo, L.BundledPlugins, {
      name: "My_Cool.Mod",
      author: "octo",
      description: "From the repository.",
    });
    eq(cfg.id, "my-cool-mod");
    eq(cfg.name, "My_Cool.Mod");
    eq(cfg.author, "octo");
    eq(cfg.description, "From the repository.");
    eq(cfg.saves, "isolated");
    eq(cfg.content, "www");
    eq(cfg.plugins.length, 0);
    eq(cfg.thumbnail, "img/titles1/Book.png");
  });

  await test("a thumbnail is a URL or a path inside the repository", async () => {
    const repo = path.join(tmp, "cfgthumb");
    put(repo, "www/a.txt", "x");
    for (const [thumbnail, ok] of [
      ["img/titles1/Title.png", true],
      ["/art/thumb.png", true],
      ["https://example.com/t.png", true],
      ["../outside.png", false],
      ["http://example.com/t.png", false],
    ]) {
      writeConfig(repo, { thumbnail });
      let err = null;
      try {
        readConfig(repo, L.BundledPlugins);
      } catch (e) {
        err = e;
      }
      eq(!err, ok, thumbnail + (err ? ": " + err.message : ""));
    }
  });

  await test("names that would escape or misbehave on Windows are refused", async () => {
    for (const bad of ["../x", "a/../b", "C:/x", "a\\b", "CON", "a/nul.txt", "x.", "x "]) {
      eq(isSafeRelPath(bad), false, bad);
    }
    eq(isSafeRelPath("img/pictures/a b.png"), true);
  });

  console.log("\nbuild-mod package:");

  const repo = path.join(tmp, "repo");
  const actorsRel = (await C.storagePath("data/Actors.json")).rel;
  const camRel = (await C.storagePath("img/pictures/cameraview.png")).rel;
  // The game's Actors under its project name: referenced.
  put(repo, "www/data/Actors.json", '[null,{"name":"Andrew"}]');
  // A game picture renamed: referenced by content.
  put(repo, "www/img/pictures/Renamed.png", "PNG-camera");
  // The game's own encrypted picture, as shipped: left out.
  put(repo, "www/" + camRel, fs.readFileSync(path.join(game, camRel)));
  // An edited map: carried whole (no patch without the game's bytes).
  put(repo, "www/data/Map001.json", '{"displayName":"Modded","events":[]}');
  // New content, and a notice that must never ship.
  put(repo, "www/img/pictures/New.png", "PNG-new");
  put(repo, "www/Copyrights - Coffin of Andy and Leyley.txt", "notice\r\n");
  put(repo, "www/js/plugins.js", fs.readFileSync(path.join(game, "js/plugins.js")));
  put(repo, "www/.DS_Store", "junk");
  writeConfig(repo, { plugins: ["MouseControl"], game: undefined });
  put(repo, ".config/base-index.json", JSON.stringify(index));
  const out = path.join(tmp, "dist");

  let result;
  await test("a repository builds against the reference index", async () => {
    result = await build({
      repo, out, version: "1.2.3", site: siteUrl, github: "octo/test-mod",
      installers: [], os: [], log: quiet, repoDefaults: null,
    });
    eq(result.indexed, true);
    eq(result.files.join(","), "test-mod-1.2.3.tcoaalmod");
    eq(result.stats.copied, 2, "copied");
    eq(result.stats.unchanged, 1, "left out");
  });

  const pkgBytes = new Uint8Array(fs.readFileSync(path.join(out, "test-mod-1.2.3.tcoaalmod")));
  await test("the package carries none of the game's own bytes", async () => {
    const parsed = await L.ModPackage.parse(pkgBytes);
    const v = parsed.manifest.variants[0];
    const byRel = Object.fromEntries(v.files.map((f) => [f.rel, f]));
    eq(byRel["data/Actors.json"].type, "copy");
    eq(byRel["data/Actors.json"].from, actorsRel);
    eq(byRel["img/pictures/Renamed.png"].from, camRel);
    eq(byRel[camRel], undefined, "unchanged file");
    eq(byRel["Copyrights - Coffin of Andy and Leyley.txt"], undefined, "notice");
    eq(byRel[".DS_Store"], undefined, "junk");
    eq(byRel["data/Map001.json"].type, "verbatim");
    eq(byRel["js/plugins/MouseControl.js"].type, "verbatim");
    for (const [name, data] of parsed.entries) {
      const text = new TextDecoder().decode(data);
      assert(!/Andrew|PNG-camera/.test(text), "game content in " + name);
    }
    eq(v.base.label, "v3.0.13");
    eq(v.base.fingerprint.version, "4242");
    eq(parsed.manifest.version, "1.2.3");
    eq(parsed.manifest.update.github, "octo/test-mod");
  });

  await test("the browser installer lays it down over the game as intended", async () => {
    const m = new Map();
    (function walk(d, r) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rr = r ? r + "/" + e.name : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rr);
        else m.set(rr, new Uint8Array(fs.readFileSync(path.join(d, e.name))).buffer);
      }
    })(game, "");
    const store = {
      get: async (k) => (m.has(k) ? m.get(k) : null),
      putMany: async (p) => p.forEach(([k, v]) => m.set(k, v)),
      keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p || "")),
      deleteMany: async (ks) => ks.forEach((k) => m.delete(k)),
    };
    const r = await L.ModInstall.install({ store, bytes: pkgBytes });
    eq(r.variant.base.label, "v3.0.13");
    const text = (k) => new TextDecoder().decode(new Uint8Array(m.get("mod:test-mod:" + k)));
    eq(text("data/Actors.json"), '[null,{"name":"Andrew"}]');
    eq(text("img/pictures/Renamed.png"), "PNG-camera");
    eq(JSON.parse(text("data/Map001.json")).displayName, "Modded");
    assert(/"name":"MouseControl"/.test(text("js/plugins.js")), "plugin registered");
  });

  await test("with no icon in .config, the thumbnail is the package icon", async () => {
    const repo6 = path.join(tmp, "repo6");
    put(repo6, "www/img/pictures/New.png", "PNG-new");
    const png = await require("sharp")({
      create: { width: 64, height: 32, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    put(repo6, "www/img/titles1/Book.png", png);
    writeConfig(repo6, { game: "9.9.9" });
    const r = await build({
      repo: repo6, out: path.join(tmp, "dist8"), version: "1.0.0", site: siteUrl,
      installers: [], os: [], log: quiet, repoDefaults: null,
    });
    const parsed = await L.ModPackage.parse(
      new Uint8Array(fs.readFileSync(path.join(tmp, "dist8", r.files[0]))),
    );
    const icon = parsed.entries.get("icon.png");
    assert(icon && icon[0] === 0x89, "a PNG icon");
    const meta = await require("sharp")(Buffer.from(icon)).metadata();
    eq(meta.width, 64, "squared to the longer side");
    eq(meta.height, 64);
  });

  await test("without a reference index every file is carried, with a warning", async () => {
    const lines = [];
    const repo2 = path.join(tmp, "repo2");
    put(repo2, "www/img/pictures/New.png", "PNG-new");
    writeConfig(repo2, { game: "9.9.9" });
    const r = await build({
      repo: repo2, out: path.join(tmp, "dist2"), version: "0.0.1", site: siteUrl,
      installers: [], os: [], log: (l) => lines.push(l),
    });
    eq(r.indexed, false);
    assert(lines.some((l) => /no \.config\/base-index\.json/.test(l)), "warned");
  });

  await test("without www/, a repository laid out like www is the mod itself", async () => {
    const root = path.join(tmp, "rootrepo");
    put(root, "data/Map001.json", '{"displayName":"Root","events":[]}');
    put(root, "img/pictures/New.png", "PNG-new");
    put(root, "README.md", "# my mod");
    put(root, "LICENSE", "MIT");
    put(root, ".github/workflows/release.yml", "name: Release");
    put(root, ".gitignore", "node_modules");
    writeConfig(root, { game: undefined });
    put(root, ".config/base-index.json", JSON.stringify(index));
    const r = await build({
      repo: root, out: path.join(tmp, "distroot"), version: "1.0.0", site: siteUrl,
      installers: [], os: [], log: quiet,
    });
    const parsed = await L.ModPackage.parse(
      new Uint8Array(fs.readFileSync(path.join(tmp, "distroot", r.files[0]))),
    );
    const rels = parsed.manifest.variants[0].files.map((f) => f.rel).sort();
    eq(rels.join(","), "data/Map001.json,img/pictures/New.png");
  });

  await test("content names the www folder, or the folder around it", async () => {
    const nested = path.join(tmp, "nested");
    put(nested, "mod/www/img/pictures/A.png", "PNG-a");
    put(nested, "game/img/pictures/B.png", "PNG-b");
    put(nested, ".config/base-index.json", JSON.stringify(index));
    for (const [content, expect] of [["mod", "img/pictures/A.png"], ["mod/www", "img/pictures/A.png"], ["game", "img/pictures/B.png"]]) {
      writeConfig(nested, { game: undefined, content });
      const out = path.join(tmp, "distnested-" + content.replace("/", "-"));
      const r = await build({ repo: nested, out, version: "1.0.0", site: siteUrl, installers: [], os: [], log: quiet });
      const parsed = await L.ModPackage.parse(new Uint8Array(fs.readFileSync(path.join(out, r.files[0]))));
      eq(parsed.manifest.variants[0].files.map((f) => f.rel).join(","), expect, content);
    }
    writeConfig(nested, { game: undefined, content: "nowhere" });
    await rejects(
      build({ repo: nested, out: path.join(tmp, "distnowhere"), version: "1.0.0", site: siteUrl, installers: [], os: [], log: quiet }),
      /"nowhere" does not exist/,
    );
  });

  await test("a repository with neither www/ nor a www layout is refused", async () => {
    const bare = path.join(tmp, "bare");
    put(bare, "notes/a.txt", "x");
    writeConfig(bare);
    await rejects(
      build({ repo: bare, out: path.join(tmp, "distbare"), version: "1.0.0", site: siteUrl, installers: [], os: [], log: quiet }),
      /No mod files found/,
    );
  });

  await test("mod.json and the index must name the same game release", async () => {
    const repo4 = path.join(tmp, "repo4");
    put(repo4, "www/img/a.png", "x");
    writeConfig(repo4, { game: "3.0.12" });
    put(repo4, ".config/base-index.json", JSON.stringify(index));
    await rejects(
      build({ repo: repo4, out: path.join(tmp, "dist6"), version: "1.0.0", site: siteUrl, installers: [], os: [], log: quiet }),
      /says the mod is for v3\.0\.12, but \.config\/base-index\.json describes v3\.0\.13/,
    );
  });

  await test("a release is required from mod.json or the index", async () => {
    const repo5 = path.join(tmp, "repo5");
    put(repo5, "www/img/a.png", "x");
    writeConfig(repo5, { game: undefined });
    await rejects(
      build({ repo: repo5, out: path.join(tmp, "dist7"), version: "1.0.0", site: siteUrl, installers: [], os: [], log: quiet }),
      /Name the game release/,
    );
  });

  await test("plugins need the mod's own js/plugins.js", async () => {
    const repo3 = path.join(tmp, "repo3");
    put(repo3, "www/img/a.png", "x");
    writeConfig(repo3, { plugins: ["MouseControl"] });
    await rejects(
      build({ repo: repo3, out: path.join(tmp, "dist3"), version: "1.0.0", site: siteUrl, installers: [], os: [], log: quiet }),
      /needs the mod's own js\/plugins\.js/,
    );
  });

  await test("online installers need the repository", async () => {
    await rejects(
      build({ repo, out: path.join(tmp, "dist4"), version: "1.0.0", site: siteUrl, installers: ["online"], os: ["linux"], log: quiet }),
      /pass --github owner\/repo/,
    );
  });

  await test("a version must be x.y.z", async () => {
    await rejects(
      build({ repo, out: path.join(tmp, "dist5"), version: "v1", site: siteUrl, installers: [], os: [], log: quiet }),
      /not a version/,
    );
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

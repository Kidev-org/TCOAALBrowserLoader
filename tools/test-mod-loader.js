#!/usr/bin/env node
/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/*
 * End-to-end test for tools/mod-loader.js: builds two real .tcoaalmod files
 * out of a synthetic game (exactly as app/create.html does), then drives the
 * CLI as a child process and asserts the things the loader promises.
 *
 * The one that matters most: THE GAME IS NEVER WRITTEN TO. Every check that
 * looks at the game folder compares bytes AND inodes, because a hardlinked
 * mirror that is written through, rather than unlinked and replaced, leaves
 * the bytes of the profile and the game identical while quietly destroying the
 * player's copy of a paid game. Only the inode tells those two apart.
 *
 * Run with: node tools/test-mod-loader.js
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

function baseTree() {
  const m = new Map();
  m.set(SYSTEM, C.enkit(enc(JSON.stringify({ gameTitle: "TCOAAL", versionId: 30800 })), SYSTEM, 0));
  m.set("img/pictures/0123456789abcdef", C.enkit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "img/pictures/0123456789abcdef", 4));
  m.set("js/plugins/Stock.js", enc("var stock = 1;\n"));
  m.set("js/rpg_core.js", enc("// engine\n"));
  return m;
}

/** Mod A: retitles the game, replaces a picture, adds and removes a plugin. */
function treeA(base) {
  const m = new Map(base);
  const sys = JSON.parse(dec(C.dekit(base.get(SYSTEM), SYSTEM)));
  sys.gameTitle = "TCOAAL (A)";
  m.set(SYSTEM, C.enkit(enc(JSON.stringify(sys)), SYSTEM, 0));
  m.set("img/pictures/0123456789abcdef", C.enkit(new Uint8Array([9, 9, 9]), "img/pictures/0123456789abcdef", 4));
  m.set("js/plugins/Mine.js", enc("var mine = 1;\n"));
  m.delete("js/plugins/Stock.js");
  return m;
}

/** Mod B: touches a different key of the same data file, plus its own plugin. */
function treeB(base) {
  const m = new Map(base);
  const sys = JSON.parse(dec(C.dekit(base.get(SYSTEM), SYSTEM)));
  sys.locale = "fr";
  m.set(SYSTEM, C.enkit(enc(JSON.stringify(sys)), SYSTEM, 0));
  m.set("js/plugins/Other.js", enc("var other = 1;\n"));
  return m;
}

/** A synthetic game root: the shipped tree plus the NW.js pieces beside it. */
function writeGame(root, tree) {
  for (const [rel, bytes] of tree) {
    const abs = path.join(root, "www", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tcoaal", main: "www/index.html" }));
  const exe = path.join(root, path.basename(root));
  fs.writeFileSync(exe, "#!/bin/sh\necho game\n");
  fs.chmodSync(exe, 0o755);
  // Steam writes every file in a depot 0755, so the game ships next to
  // documents that carry the exec bit and are not executable at all. This one
  // is here in every test because picking it is how Play used to die with
  // "Exec format error".
  const doc = path.join(root, "credits.html");
  fs.writeFileSync(doc, "<h1>credits</h1>\n");
  fs.chmodSync(doc, 0o755);
  fs.mkdirSync(path.join(root, "locales"), { recursive: true });
  fs.writeFileSync(path.join(root, "locales", "en-US.pak"), "pak");
  fs.mkdirSync(path.join(root, "www", "save"), { recursive: true });
  fs.writeFileSync(path.join(root, "www", "save", "config.rpgsave"), "saved");
}

function readTree(www) {
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

/** Compare two trees, ignoring paths matching `skip`. */
function sameTree(a, b, skip) {
  const keys = (m) => [...m.keys()].filter((k) => !skip || !skip.test(k));
  const ka = keys(a).sort();
  const kb = keys(b).sort();
  if (ka.join("|") !== kb.join("|")) {
    const extra = ka.filter((k) => kb.indexOf(k) === -1);
    const missing = kb.filter((k) => ka.indexOf(k) === -1);
    return `different files (extra: ${extra.join(",") || "-"}; missing: ${missing.join(",") || "-"})`;
  }
  for (const k of ka) if (hex(a.get(k)) !== hex(b.get(k))) return `bytes differ for ${k}`;
  return null;
}

function ino(p) {
  return fs.statSync(p).ino;
}

function run(args, opts) {
  return execFileSync(process.execPath, [path.join(ROOT, "tools/mod-loader.js"), ...args], {
    encoding: "utf8",
    ...(opts || {}),
  });
}

/** The single @result line every command ends with. */
function runJson(args, opts) {
  const out = run(args, opts);
  const line = out.split("\n").filter((l) => l.startsWith("@result "))[0];
  assert(line, "no @result line in:\n" + out);
  return JSON.parse(line.slice("@result ".length));
}

async function buildMod(base, modded, fp, meta) {
  const payloads = new Map();
  const r = await D.compare(D.memSource(base), D.memSource(modded), payloads, () => {});
  return P.build({
    id: meta.id,
    name: meta.name,
    author: "kidev",
    version: meta.version || "1.0.0",
    description: "",
    icon: meta.icon || null,
    saves: meta.saves || "isolated",
    update: null,
    theme: meta.theme || [],
    payloads,
    variants: [{ base: { label: "v3.0.8", fingerprint: fp }, files: r.files, stats: r.stats }],
  });
}

/**
 * The package a stamped ONLINE installer carries: this mod's identity, icon
 * and theme, and no content whatsoever. app/create.html builds it with exactly
 * these arguments.
 */
function buildPlaceholder(meta) {
  return P.build({
    id: meta.id,
    name: meta.name,
    author: "kidev",
    version: meta.version || "1.0.0",
    description: "",
    icon: meta.icon || null,
    saves: "isolated",
    update: null,
    theme: meta.theme || [],
    variants: [],
    payloads: new Map(),
    online: meta.online,
  });
}

/**
 * Serve the mod loader's downloads out of local files.
 *
 * mod-loader reaches the network through the global `fetch` and nothing else,
 * so a --require preload that replaces it is the whole of the seam. That keeps
 * the https-only rule under test as the real thing rather than something
 * relaxed for a local server, and keeps these tests off the network.
 */
function fetchStubEnv(tmp, map) {
  const mapFile = path.join(tmp, "fetch-map.json");
  const stub = path.join(tmp, "fetch-stub.js");
  fs.writeFileSync(mapFile, JSON.stringify(map));
  fs.writeFileSync(
    stub,
    'const fs = require("fs");\n' +
      'const map = JSON.parse(fs.readFileSync(process.env.TCOAAL_FETCH_MAP, "utf8"));\n' +
      "globalThis.fetch = async (url) => {\n" +
      "  const file = map[String(url)];\n" +
      "  if (!file) return { ok: false, status: 404 };\n" +
      "  const b = fs.readFileSync(file);\n" +
      // A real download arrives in chunks under a content-length, which is
      // what the loader turns into a progress fraction, so the stub answers in
      // the same shape rather than only as one buffer.
      "  return {\n" +
      "    ok: true,\n" +
      "    status: 200,\n" +
      '    headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(b.length) : null) },\n' +
      "    body: (async function* () {\n" +
      "      for (let i = 0; i < b.length; i += 4096) yield b.subarray(i, Math.min(i + 4096, b.length));\n" +
      "    })(),\n" +
      "    async arrayBuffer() {\n" +
      "      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);\n" +
      "    },\n" +
      '    async json() { return JSON.parse(b.toString("utf8")); },\n' +
      "  };\n" +
      "};\n",
  );
  return {
    ...process.env,
    TCOAAL_FETCH_MAP: mapFile,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${stub}`.trim(),
  };
}

(async function main() {
  console.log("\nmod-loader:");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcoaal-modloader-"));
  const game = path.join(tmp, "The Coffin of Andy and Leyley");
  const base = baseTree();
  writeGame(game, base);
  const www = path.join(game, "www");
  const fp = await D.fingerprint(D.memSource(base));

  const modA = path.join(tmp, "a.tcoaalmod");
  const modB = path.join(tmp, "b.tcoaalmod");
  const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  fs.writeFileSync(
    modA,
    await buildMod(base, treeA(base), fp, {
      id: "mod-a",
      name: "Mod A",
      icon,
      theme: [{ name: "theme/index.html", data: enc("<h1>A</h1>") }],
    }),
  );
  fs.writeFileSync(modB, await buildMod(base, treeB(base), fp, { id: "mod-b", name: "Mod B" }));

  // Snapshot of the pristine game, bytes and inodes, taken before anything ran.
  const pristine = readTree(www);
  const pristineInos = new Map([...pristine.keys()].map((k) => [k, ino(path.join(www, k))]));
  const profile = path.join(game, "addons", ".profile");
  const profileWww = path.join(profile, "www");

  function gameIsPristine() {
    const diff = sameTree(readTree(www), pristine);
    if (diff) return "the game's files changed: " + diff;
    for (const [rel, i] of pristineInos) {
      if (ino(path.join(www, rel)) !== i) return `the game's ${rel} was replaced (inode changed)`;
    }
    return null;
  }

  await test("--status finds the game before anything is installed", () => {
    const st = runJson(["--status", "--game", game]);
    eq(st.root, game, "root");
    eq(st.wwwRel, "www", "wwwRel");
    eq(st.version, "30800", "version");
    eq(st.mods.length, 0, "mods");
    eq(st.profile.built, false, "profile.built");
    assert(st.exe && path.basename(st.exe) === path.basename(game), "the game executable was not found: " + st.exe);
  });

  // A Linux player's copy of the game is the WINDOWS build under Proton: there
  // is no native binary to find, only Game.exe and a pile of 0755 documents
  // beside it. Picking any of those documents is what made Play fail with
  // "Could not start the game: Exec format error (os error 8)", so the shape
  // gets its own root rather than riding on the synthetic game above.
  await test("a Windows-only copy resolves to the .exe, not a 0755 document", () => {
    const winGame = path.join(tmp, "Windows Copy");
    fs.mkdirSync(path.join(winGame, "www", "data"), { recursive: true });
    fs.writeFileSync(path.join(winGame, "www", "index.html"), "<html></html>");
    fs.writeFileSync(path.join(winGame, "package.json"), JSON.stringify({ name: "tcoaal", main: "www/index.html" }));
    for (const name of ["Game.exe", "credits.html", "icudtl.dat", "LICENSES.chromium.html"]) {
      const abs = path.join(winGame, name);
      fs.writeFileSync(abs, name === "Game.exe" ? "MZ\0\0" : "not a program\n");
      fs.chmodSync(abs, 0o755);
    }
    const st = runJson(["--status", "--game", winGame]);
    eq(path.basename(st.exe || ""), "Game.exe", "exe");
  });

  // Same shape, one step further: the Windows binary is not called .exe at
  // all. The bytes are what say it is a program, here and in the app that
  // decides to hand it to Proton.
  await test("a Windows binary without the .exe name is still the one picked", () => {
    const winGame = path.join(tmp, "Renamed Copy");
    fs.mkdirSync(path.join(winGame, "www", "data"), { recursive: true });
    fs.writeFileSync(path.join(winGame, "www", "index.html"), "<html></html>");
    fs.writeFileSync(path.join(winGame, "package.json"), JSON.stringify({ name: "tcoaal", main: "www/index.html" }));
    for (const name of ["Renamed Copy", "credits.html", "readme"]) {
      const abs = path.join(winGame, name);
      fs.writeFileSync(abs, name === "Renamed Copy" ? "MZ\0\0" : "not a program\n");
      fs.chmodSync(abs, 0o755);
    }
    const st = runJson(["--status", "--game", winGame]);
    eq(path.basename(st.exe || ""), "Renamed Copy", "exe");
  });

  await test("--install puts the mod in addons/ and builds a profile", () => {
    const res = runJson(["--install", modA, "--game", game]);
    eq(res.id, "mod-a");
    assert(fs.existsSync(path.join(game, "addons", "mod-a", "mod.tcoaalmod")), "package not stored");
    assert(fs.existsSync(path.join(game, "addons", "mod-a", "mod.json")), "manifest not stored");
    assert(fs.existsSync(path.join(game, "addons", "mod-a", "icon.png")), "icon not unpacked");
    assert(fs.existsSync(path.join(game, "addons", "mod-a", "theme", "index.html")), "theme not unpacked");
    assert(res.profile.built, "no profile");
  });

  await test("installing did not touch one byte of the game", () => {
    const bad = gameIsPristine();
    assert(!bad, bad);
  });

  await test("the profile plays the modded game", () => {
    const diff = sameTree(readTree(profileWww), treeA(base), /^save\//);
    assert(!diff, "profile tree differs: " + diff);
  });

  await test("the profile is a mirror: unchanged files are hardlinks, changed ones are not", () => {
    eq(ino(path.join(profileWww, "js/rpg_core.js")), pristineInos.get("js/rpg_core.js"), "unchanged file must be the same inode");
    assert(
      ino(path.join(profileWww, SYSTEM)) !== pristineInos.get(SYSTEM),
      "a patched file must be a NEW file, not a write through the link",
    );
    assert(
      ino(path.join(profileWww, "img/pictures/0123456789abcdef")) !==
        pristineInos.get("img/pictures/0123456789abcdef"),
      "a replaced file must be a NEW file, not a write through the link",
    );
  });

  await test("the profile is a complete game root, launchable on its own", () => {
    assert(fs.existsSync(path.join(profile, "package.json")), "no package.json in the profile");
    assert(fs.existsSync(path.join(profile, "locales", "en-US.pak")), "the profile is missing game files");
    const st = runJson(["--status", "--game", game]);
    assert(st.profile.exe && st.profile.exe.startsWith(profile), "no executable in the profile: " + st.profile.exe);
  });

  // Steam did not start this copy, so nothing tells the game's Steam module
  // which app it is and it dies with "STEAM MODULE FAILURE" before the title
  // screen. The app id belongs to the profile - and only to the profile.
  await test("the profile carries the Steam app id, and the game folder does not", () => {
    const inProfile = path.join(profile, "steam_appid.txt");
    assert(fs.existsSync(inProfile), "the profile has no steam_appid.txt");
    eq(fs.readFileSync(inProfile, "utf8").trim(), "2378900", "app id");
    assert(
      !fs.existsSync(path.join(game, "steam_appid.txt")),
      "steam_appid.txt was written into the player's own game folder",
    );
  });

  await test("isolated saves are copies, so playing a mod cannot touch the real ones", () => {
    const p = path.join(profileWww, "save", "config.rpgsave");
    assert(fs.existsSync(p), "the profile has no save folder");
    assert(ino(p) !== pristineInos.get("save/config.rpgsave"), "saves must not be hardlinked");
    fs.writeFileSync(p, "modded save");
    eq(fs.readFileSync(path.join(www, "save", "config.rpgsave"), "utf8"), "saved", "the real save changed");
  });

  await test("a second --profile with nothing changed does not rebuild", () => {
    const res = runJson(["--profile", "--game", game]);
    eq(res.profile.rebuilt, false, "rebuilt");
  });

  // The Steamworks API DELETES steam_appid.txt once it has read it, so the
  // file is gone the moment the player closes the game for the first time.
  // Nothing about the profile is stale, so the stamp still matches and no
  // rebuild happens: without a repair pass, every launch after the first has
  // no app id and the game stops at "STEAM MODULE FAILURE".
  await test("a launch that consumed steam_appid.txt gets it back without a rebuild", () => {
    const appid = path.join(profile, "steam_appid.txt");
    fs.rmSync(appid);
    const res = runJson(["--profile", "--game", game]);
    eq(res.profile.rebuilt, false, "rebuilt");
    assert(fs.existsSync(appid), "steam_appid.txt was not put back");
    eq(fs.readFileSync(appid, "utf8").trim(), "2378900", "app id");
    assert((res.profile.repaired || []).indexOf("steam_appid.txt") !== -1, "the repair was not reported");
  });

  // Same shape, one directory down: the save folder is the one thing in the
  // profile the player writes to, and a game that cannot open it fails on
  // launch rather than on save.
  await test("a missing save folder is rebuilt in place too", () => {
    const saves = path.join(profileWww, "save");
    fs.rmSync(saves, { recursive: true, force: true });
    const res = runJson(["--profile", "--game", game]);
    eq(res.profile.rebuilt, false, "rebuilt");
    assert(fs.existsSync(saves), "the save folder was not put back");
  });

  await test("a second mod coexists and both are applied in load order", () => {
    runJson(["--install", modB, "--game", game]);
    const st = runJson(["--status", "--game", game]);
    eq(st.mods.length, 2, "installed mods");
    eq(st.mods.map((m) => m.id).join(","), "mod-a,mod-b", "load order");
    const sys = JSON.parse(dec(C.dekit(new Uint8Array(fs.readFileSync(path.join(profileWww, SYSTEM))), SYSTEM)));
    eq(sys.gameTitle, "TCOAAL (A)", "mod A's change");
    eq(sys.locale, "fr", "mod B's change");
    assert(fs.existsSync(path.join(profileWww, "js/plugins/Mine.js")), "mod A's plugin");
    assert(fs.existsSync(path.join(profileWww, "js/plugins/Other.js")), "mod B's plugin");
    const bad = gameIsPristine();
    assert(!bad, bad);
  });

  await test("--enable off rebuilds the profile without that mod", () => {
    runJson(["--enable", "mod-a", "--on", "0", "--game", game]);
    const sys = JSON.parse(dec(C.dekit(new Uint8Array(fs.readFileSync(path.join(profileWww, SYSTEM))), SYSTEM)));
    eq(sys.gameTitle, "TCOAAL", "mod A must be gone");
    eq(sys.locale, "fr", "mod B must remain");
    assert(!fs.existsSync(path.join(profileWww, "js/plugins/Mine.js")), "mod A's plugin must be gone");
    assert(fs.existsSync(path.join(profileWww, "js/plugins/Stock.js")), "the deleted plugin must be back");
    runJson(["--enable", "mod-a", "--on", "1", "--game", game]);
  });

  await test("--order decides who wins", () => {
    runJson(["--order", "mod-b,mod-a", "--game", game]);
    const st = runJson(["--status", "--game", game]);
    eq(st.mods.map((m) => m.id).join(","), "mod-b,mod-a", "load order");
  });

  await test("uninstalling the last mod leaves the game exactly as it was", () => {
    runJson(["--uninstall", "mod-a", "--game", game]);
    assert(fs.existsSync(path.join(game, "addons")), "addons/ must survive while a mod remains");
    runJson(["--uninstall", "mod-b", "--game", game]);
    assert(!fs.existsSync(path.join(game, "addons")), "addons/ must be gone with the last mod");
    const bad = gameIsPristine();
    assert(!bad, bad);
    const entries = fs.readdirSync(game).sort();
    eq(
      entries.join(","),
      ["credits.html", "locales", "package.json", "www", path.basename(game)].sort().join(","),
      "leftovers in the game folder",
    );
  });

  await test("a mod built for another build is refused", async () => {
    const otherFp = await D.fingerprint(D.memSource(base));
    otherFp.version = "39900";
    otherFp.files = 999;
    const bad = path.join(tmp, "bad.tcoaalmod");
    fs.writeFileSync(bad, await buildMod(base, treeA(base), otherFp, { id: "mod-c", name: "Mod C" }));
    let threw = false;
    try {
      run(["--install", bad, "--game", game], { stdio: "pipe" });
    } catch (e) {
      threw = true;
      assert(/does not support your version/.test(String(e.stderr)), "wrong error: " + e.stderr);
    }
    assert(threw, "installing a mod for another build must fail");
  });

  await test("a game still modded by the old in-place installer is refused", () => {
    fs.writeFileSync(path.join(game, ".tcoaalmod-rollback.zip"), "not really a zip");
    let threw = false;
    try {
      run(["--install", modA, "--game", game], { stdio: "pipe" });
    } catch (e) {
      threw = true;
      assert(/old way/.test(String(e.stderr)), "wrong error: " + e.stderr);
    }
    fs.rmSync(path.join(game, ".tcoaalmod-rollback.zip"));
    fs.rmSync(path.join(game, "addons"), { recursive: true, force: true });
    assert(threw, "a legacy install must block the loader");
  });

  // Online installers.
  //
  // A stamped ONLINE installer carries a placeholder: the mod's face, none of
  // its content, and a link to the real package. These run against their own
  // copy of the game so the sequence above keeps its state.
  {
    const onlineGame = path.join(tmp, "Online Copy");
    writeGame(onlineGame, base);
    const onlineWww = path.join(onlineGame, "www");
    const onlineProfileWww = path.join(onlineGame, "addons", ".profile", "www");
    // writeGame lays down a save file of its own, so the pristine reference is
    // the folder as written, not the base tree.
    const onlinePristine = readTree(onlineWww);
    const onlinePristineInos = new Map(
      [...onlinePristine.keys()].map((k) => [k, ino(path.join(onlineWww, k))]),
    );
    const URL_A = "https://mods.example/mod-a.tcoaalmod";
    const placeholder = path.join(tmp, "online-a.tcoaalmod");
    fs.writeFileSync(
      placeholder,
      await buildPlaceholder({
        id: "mod-a",
        name: "Mod A",
        icon,
        theme: [{ name: "theme/index.html", data: enc("<h1>A</h1>") }],
        online: { url: URL_A },
      }),
    );

    await test("an online placeholder is readable without any base variants", () => {
      const out = path.join(tmp, "unpacked-online");
      const info = runJson(["--unpack", placeholder, "--out", out]);
      eq(info.id, "mod-a", "id");
      eq(info.online, true, "online");
      eq(info.variants.length, 0, "variants");
      // The face the installer renders before anything is downloaded.
      assert(fs.existsSync(path.join(out, "icon.png")), "icon not unpacked");
      assert(fs.existsSync(path.join(out, "theme", "index.html")), "theme not unpacked");
    });

    await test("installing an online placeholder downloads the mod it points at", () => {
      const res = runJson(["--install", placeholder, "--game", onlineGame], {
        env: fetchStubEnv(tmp, { [URL_A]: modA }),
      });
      eq(res.id, "mod-a", "id");
      eq(res.base, "v3.0.8", "the DOWNLOAD's variant is what gets matched");
      assert(res.profile.built, "no profile");
      const stored = path.join(onlineGame, "addons", "mod-a", "mod.tcoaalmod");
      eq(
        hex(new Uint8Array(fs.readFileSync(stored))),
        hex(new Uint8Array(fs.readFileSync(modA))),
        "the DOWNLOADED package must be the one stored, not the placeholder",
      );
      const diff = sameTree(readTree(onlineProfileWww), treeA(base), /^save\//);
      assert(!diff, "profile tree differs: " + diff);
    });

    await test("downloading a mod did not touch one byte of the game", () => {
      const diff = sameTree(readTree(onlineWww), onlinePristine);
      assert(!diff, "the game's files changed: " + diff);
      // Bytes are not enough: a mirror written THROUGH rather than unlinked
      // and replaced leaves them identical and destroys the player's copy.
      for (const [rel, i] of onlinePristineInos) {
        eq(ino(path.join(onlineWww, rel)), i, `the game's ${rel} was replaced`);
      }
    });

    const leftoverDownloads = () =>
      fs
        .readdirSync(path.join(onlineGame, "addons"))
        .filter((n) => n.indexOf(".download-") === 0)
        .join(",");

    await test("the scratch download is not left behind", () => {
      eq(leftoverDownloads(), "", "leftover downloads");
    });

    await test("a download answering to another mod's id is refused", () => {
      let threw = false;
      try {
        run(["--install", placeholder, "--game", onlineGame, "--force"], {
          stdio: "pipe",
          env: fetchStubEnv(tmp, { [URL_A]: modB }),
        });
      } catch (e) {
        threw = true;
        const err = String(e.stderr);
        assert(/mod-b/.test(err) && /mod-a/.test(err), "wrong error: " + err);
      }
      assert(threw, "an id mismatch must not install");
      // fail() ends the process with process.exit, which does not unwind the
      // finally that removes the download, so a failed install used to leave a
      // whole mod behind in the player's addons folder.
      eq(leftoverDownloads(), "", "a failed install left its download behind");
    });

    await test("an online placeholder cannot point at another placeholder", () => {
      let threw = false;
      try {
        run(["--install", placeholder, "--game", onlineGame], {
          stdio: "pipe",
          env: fetchStubEnv(tmp, { [URL_A]: placeholder }),
        });
      } catch (e) {
        threw = true;
        assert(/placeholder/.test(String(e.stderr)), "wrong error: " + e.stderr);
      }
      assert(threw, "a chain of placeholders must not be followed");
      eq(leftoverDownloads(), "", "a failed install left its download behind");
    });

    await test("an online source must be https", async () => {
      const plain = path.join(tmp, "online-http.tcoaalmod");
      fs.writeFileSync(
        plain,
        await buildPlaceholder({
          id: "mod-a",
          name: "Mod A",
          online: { url: "http://mods.example/mod-a.tcoaalmod" },
        }),
      );
      let threw = false;
      try {
        run(["--install", plain, "--game", onlineGame], {
          stdio: "pipe",
          env: fetchStubEnv(tmp, { "http://mods.example/mod-a.tcoaalmod": modA }),
        });
      } catch (e) {
        threw = true;
        assert(/https/.test(String(e.stderr)), "wrong error: " + e.stderr);
      }
      assert(threw, "a mod is executable content: http must be refused");
    });

    await test("a package with no variants and no online source is still refused", async () => {
      const empty = path.join(tmp, "no-variants.tcoaalmod");
      fs.writeFileSync(empty, await buildPlaceholder({ id: "mod-a", name: "Mod A" }));
      let threw = false;
      try {
        run(["--install", empty, "--game", onlineGame], { stdio: "pipe" });
      } catch (e) {
        threw = true;
        assert(/no base variants/.test(String(e.stderr)), "wrong error: " + e.stderr);
      }
      assert(threw, "only an ONLINE package may carry no variants");
    });
  }

  await test("unsafe ids and paths are refused", () => {
    const loader = require(path.join(ROOT, "tools/mod-loader.js"));
    assert(!loader.safeId("../evil"), "id traversal");
    assert(!loader.safeId("Mod A"), "id with a space");
    assert(loader.safeId("mod-a"), "a normal id must pass");
    assert(!loader.safeRel("../evil"), "rel traversal");
    assert(!loader.safeRel("/etc/passwd"), "absolute rel");
    assert(!loader.safeRel("C:\\evil"), "windows rel");
    assert(loader.safeRel("data/be1a37535e921f91"), "a normal rel must pass");
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();

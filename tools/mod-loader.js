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
 * The mod loader engine: install `tcoaal-mod/3` packages beside a game and
 * play them WITHOUT ever writing inside the game's own files.
 *
 *   node tools/mod-loader.js --status  --game <GameFolder>
 *   node tools/mod-loader.js --install <mod.tcoaalmod> --game <GameFolder>
 *   node tools/mod-loader.js --uninstall <id> --game <GameFolder>
 *   node tools/mod-loader.js --enable <id> --on 0|1 --game <GameFolder>
 *   node tools/mod-loader.js --order <id,id,...> --game <GameFolder>
 *   node tools/mod-loader.js --profile --game <GameFolder>
 *   node tools/mod-loader.js --check-update [id] --game <GameFolder>
 *   node tools/mod-loader.js --apply-update <id> --game <GameFolder>
 *
 * How it differs from tools/mod-apply.js
 * --------------------------------------
 * mod-apply overlays a mod ONTO the player's game and keeps a rollback
 * archive as the only way back. That is what the first installer did, and it
 * is why a Steam file check could undo a mod, why two mods could not coexist,
 * and why a failed uninstall left a damaged copy of a paid game.
 *
 * This tool never writes to the game. Everything it owns lives in ONE folder
 * next to www/:
 *
 *   <game>/addons/state.json        enabled mods and their load order
 *   <game>/addons/<id>/             the package, its manifest, icon and theme
 *   <game>/addons/.profile/         the tree the game is actually launched from
 *
 * The profile is a mirror of the game folder built out of HARDLINKS (symlinks
 * where hardlinks are unavailable), so it costs no disk space and holds no
 * copy of the game's content. Only the files a mod changes are turned into
 * real files, and always by REMOVING the link first and creating a new file -
 * never by writing through it, which would write straight into the original.
 * That single rule is what keeps the Steam copy pristine, so it is asserted by
 * tools/test-mod-loader.js rather than left to review.
 *
 * The profile is a complete game root (the game's own executable and its
 * package.json are mirrored too) so the game is launched from the profile and
 * NW.js resolves `main` next to that package.json. No command-line app path,
 * no assumption about how the runtime was packaged.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const FORMAT = "tcoaal-mod/3";
const STATE_FORMAT = "tcoaal-addons/1";
const ADDONS = "addons";
const STATE_FILE = "state.json";
const PROFILE_DIR = ".profile";
const STAMP_FILE = ".stamp";
const PACKAGE_NAME = "mod.tcoaalmod";
/** Written by the older in-place installer (tools/mod-apply.js). */
const LEGACY_ROLLBACK = ".tcoaalmod-rollback.zip";
const STD_SYSTEM = "data/be1a37535e921f91"; // hashPath("data/System.json")

/*
 * The game's Steam app id, and the file that hands it to a copy Steam did not
 * launch itself.
 *
 * The profile is started directly (it is not the copy Steam knows about), so
 * the game's Steam module has nothing telling it which app it belongs to and
 * dies with "STEAM MODULE FAILURE" before the title screen. steam_appid.txt
 * beside the executable is the documented answer: the Steamworks API reads it
 * when the process was not launched by the client, and greenworks - which is
 * what the game uses - falls back to it explicitly. It is written into the
 * PROFILE only, never into the player's own folder.
 */
const STEAM_APPID = "2378900";
const STEAM_APPID_FILE = "steam_appid.txt";

// Browser libraries, loaded into one shared vm context. Same list and same
// reason as tools/mod-apply.js: enkit here is byte-for-byte the enkit the
// modder's diff was computed against, because it is literally the same file.

function loadLibs() {
  const nodeCrypto = require("crypto");
  const ctx = vm.createContext({
    self: {},
    crypto: globalThis.crypto || nodeCrypto.webcrypto,
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    Response,
    console,
  });
  const root = path.join(__dirname, "..");
  for (const rel of [
    "app/js/libs/tcoaal-codec.js",
    "app/js/libs/json-diff.js",
    "app/js/libs/mod-package.js",
    "app/js/libs/mod-diff-worker.js",
  ]) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) fail(`Missing bundled library: ${abs}`);
    vm.runInContext(fs.readFileSync(abs, "utf8"), ctx);
  }
  return ctx.self;
}

const LIBS = loadLibs();
const C = LIBS.TcoaalCodec;
const J = LIBS.JsonDiff;
const P = LIBS.ModPackage;

// Output protocol
//
// stdout carries two kinds of line the caller cares about, both prefixed so a
// stray log line from anywhere can never be mistaken for either:
//
//   @progress {"done":n,"total":n,"message":"..."}   streamed while working
//   @result   {...}                                  exactly one, at the end
//
// tools/desktop reads them line by line, turns @progress into the OnProgress
// callback a theme registered, and parses @result as the command's answer.

function emit(kind, obj) {
  process.stdout.write("@" + kind + " " + JSON.stringify(obj) + "\n");
}

let _lastPct = -1;
let _lastMessage = null;
function progress(done, total, message) {
  // Throttled to whole percent: a mirror of a real game is ~9000 files and a
  // line per file would cost more than the work it reports on. A NEW message
  // always goes out whatever the percentage says: the phase markers are how
  // the installer tells the player which part of the job it is on, and two
  // phases in a row that both start at 0% would otherwise cost the second one.
  const pct = total ? Math.floor((done * 100) / total) : 0;
  const msg = message || "";
  if (pct === _lastPct && msg === _lastMessage && done !== total) return;
  _lastPct = pct;
  _lastMessage = msg;
  emit("progress", { done, total, message: msg });
}

function result(obj) {
  emit("result", obj);
}

function fail(msg) {
  process.stderr.write(String(msg) + "\n");
  process.exit(1);
}

// Game layout

function isGameWww(dir) {
  return fs.existsSync(path.join(dir, "data"));
}

/**
 * Resolve whatever folder the player picked into { root, wwwRel, www }.
 *
 * `root` is the folder that gets an addons/, the one the game's executable
 * lives in. `wwwRel` is where the shipped tree sits under it, which is "www"
 * everywhere except a macOS bundle, where the game data is inside the .app.
 */
function resolveGame(input) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) fail(`Folder not found: ${input}`);

  if (isGameWww(path.join(abs, "www"))) {
    return layout(abs, "www");
  }
  // The player picked www/ itself.
  if (isGameWww(abs)) {
    return layout(path.dirname(abs), path.basename(abs));
  }
  // macOS: the game data lives inside the app bundle. Either the bundle was
  // picked, or the folder holding it was.
  const macTail = path.join("Contents", "Resources", "app.nw", "www");
  if (isGameWww(path.join(abs, macTail))) {
    return layout(path.dirname(abs), path.join(path.basename(abs), macTail));
  }
  for (const name of safeReaddir(abs)) {
    if (!name.endsWith(".app")) continue;
    if (isGameWww(path.join(abs, name, macTail))) {
      return layout(abs, path.join(name, macTail));
    }
  }
  fail(
    `No game found in ${input}.\n` +
      `Pick the folder that holds www/ (the one with the game's executable in it).`,
  );
}

function layout(root, wwwRel) {
  return {
    root: root,
    wwwRel: wwwRel.split(path.sep).join("/"),
    www: path.join(root, wwwRel),
  };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
}

function addonsDir(game) {
  return path.join(game.root, ADDONS);
}

function profileDir(game) {
  return path.join(addonsDir(game), PROFILE_DIR);
}

/** versionId out of the game's own System.json, for variant selection. */
function baseVersionOf(www) {
  const abs = path.join(www, STD_SYSTEM);
  if (!fs.existsSync(abs)) return null;
  try {
    const plain = C.dekit(new Uint8Array(fs.readFileSync(abs)), STD_SYSTEM);
    const sys = JSON.parse(new TextDecoder().decode(plain));
    return sys && sys.versionId != null ? String(sys.versionId) : null;
  } catch (e) {
    return null;
  }
}

/*
 * A .tcoaalmod is untrusted input a player downloaded from the internet, and
 * every `rel` in it becomes a path we write to. Anything that could escape the
 * tree (a parent segment, an absolute path, a drive or UNC prefix, a
 * backslash smuggling one of those past a "/" split) is refused outright.
 * Same rule, same reasoning, as tools/mod-apply.js.
 */
function safeRel(rel) {
  if (typeof rel !== "string" || !rel) return false;
  if (rel.indexOf("\\") !== -1) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split("/").some((p) => p === "" || p === "." || p === "..");
}

/** Mod ids name a directory we create and later delete recursively. */
function safeId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

// state.json

function readState(game) {
  const abs = path.join(addonsDir(game), STATE_FILE);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    state = null;
  }
  if (!state || typeof state !== "object") state = {};
  return {
    format: STATE_FORMAT,
    mods: state.mods && typeof state.mods === "object" ? state.mods : {},
    order: Array.isArray(state.order) ? state.order.filter(safeId) : [],
    saves: state.saves === "shared" ? "shared" : "isolated",
  };
}

function writeState(game, state) {
  const dir = addonsDir(game);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    JSON.stringify({ format: STATE_FORMAT, ...state }, null, 2) + "\n",
  );
}

/** Installed ids in load order: the recorded order first, then any stragglers. */
function orderedIds(state) {
  const known = Object.keys(state.mods).filter(safeId);
  const out = state.order.filter((id) => known.indexOf(id) !== -1);
  for (const id of known) if (out.indexOf(id) === -1) out.push(id);
  return out;
}

// Installed mods

function modDir(game, id) {
  return path.join(addonsDir(game), id);
}

function readManifestOf(game, id) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(modDir(game, id), "mod.json"), "utf8"),
    );
  } catch (e) {
    return null;
  }
}

function iconDataUrl(game, id) {
  const abs = path.join(modDir(game, id), "icon.png");
  try {
    const b = fs.readFileSync(abs);
    // Big enough to be a mistake rather than an icon: skip it instead of
    // pushing megabytes of base64 through the IPC channel on every refresh.
    if (b.length > 4 * 1024 * 1024) return null;
    return "data:image/png;base64," + b.toString("base64");
  } catch (e) {
    return null;
  }
}

function labelOf(variant) {
  return (
    (variant.base &&
      (variant.base.label ||
        (variant.base.steam && variant.base.steam.name))) ||
    "unnamed build"
  );
}

/**
 * The variant matching this game, or null. Cheap signals only: System.json's
 * versionId, then the file count. The authoritative digest costs a full read
 * of a multi-gigabyte game, which is not a thing to do while a player waits -
 * create.html already refuses to build a variant that does not describe a real
 * build, and a wrong guess here fails loudly at patch time (a patch entry
 * whose target is missing or shaped differently is an error, not a silent
 * corruption).
 */
function selectVariant(manifest, game, opts) {
  const variants = manifest.variants || [];
  if (!variants.length) return null;
  const version = baseVersionOf(game.www);
  if (version) {
    const byVersion = variants.filter((v) => {
      const fp = (v.base && v.base.fingerprint) || {};
      return fp.version != null && String(fp.version) === version;
    });
    if (byVersion.length) return byVersion[0];
  }
  const count = countFiles(game.www);
  const byCount = variants.filter((v) => {
    const fp = (v.base && v.base.fingerprint) || {};
    return fp.files === count;
  });
  if (byCount.length) return byCount[0];
  return opts && opts.force ? variants[0] : null;
}

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of readdirTypes(d)) {
      if (ent.isDirectory()) stack.push(path.join(d, ent.name));
      else n++;
    }
  }
  return n;
}

function readdirTypes(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

// Reading a package

async function readPackage(modFile) {
  if (!fs.existsSync(modFile)) fail(`Mod file not found: ${modFile}`);
  const bytes = new Uint8Array(fs.readFileSync(modFile));
  let parsed;
  try {
    parsed = await P.parse(bytes);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg.indexOf("tcoaal-share/") !== -1) {
      fail(
        `This is an older project-space mod (${msg.split(": ").pop()}).\n` +
          `It cannot be installed by the mod loader.`,
      );
    }
    fail(msg);
  }
  const m = parsed.manifest;
  // An ONLINE placeholder legitimately has no variants: it carries identity
  // and theme only, and the package it points at is the one that gets checked
  // against the player's game.
  if (!m.online && (!Array.isArray(m.variants) || !m.variants.length)) {
    fail("Invalid mod file: no base variants.");
  }
  if (!safeId(m.id)) fail(`Invalid mod file: bad mod id "${m.id}".`);
  return { ...parsed, bytes };
}

/**
 * Write a package's manifest, icon and theme into `dir` as loose files.
 *
 * Used for both halves of the same job: an installed mod under addons/<id>/,
 * and the mod a stamped installer carries inside itself, which the app unpacks
 * into its cache so it can show the modder's own theme before anything is
 * installed anywhere.
 */
function unpackInto(dir, manifest, entries) {
  // Replace rather than merge: a reinstall (or an update) must not leave a
  // theme file the new package no longer ships.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mod.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  if (manifest.icon && entries.get(manifest.icon)) {
    fs.writeFileSync(path.join(dir, "icon.png"), entries.get(manifest.icon));
  }
  for (const [name, data] of entries) {
    if (!name.startsWith("theme/")) continue;
    const rel = name.slice("theme/".length);
    if (!safeRel(rel)) fail(`Refusing an unsafe path in the mod: ${name}`);
    const abs = path.join(dir, "theme", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
}

async function unpack(opts) {
  const { manifest, entries } = await readPackage(opts.modFile);
  unpackInto(opts.out, manifest, entries);
  result({
    id: manifest.id,
    name: manifest.name || manifest.id,
    author: manifest.author || "",
    version: manifest.version || "",
    description: manifest.description || "",
    saves: manifest.saves === "shared" ? "shared" : "isolated",
    icon: manifest.icon ? "icon.png" : null,
    theme: fs.existsSync(path.join(opts.out, "theme", "index.html"))
      ? "theme/index.html"
      : null,
    variants: (manifest.variants || []).map(labelOf),
    // True for a stamped ONLINE installer: it holds this mod's face, and the
    // mod itself arrives when the player presses Install.
    online: manifest.online ? true : false,
    dir: opts.out,
  });
}

// install / uninstall / enable / order

/**
 * Fetch what an ONLINE placeholder stands in for.
 *
 * A stamped online installer carries a package holding the mod's identity,
 * icon and theme but none of its content, so the app wears the mod's own face
 * offline while weighing a few hundred KB instead of the whole mod. The real
 * package is fetched here, at install time, from the source the author put in
 * `online`. Returns the path of a scratch file the caller must remove.
 */
async function fetchOnline(game, placeholder) {
  const name = placeholder.name || placeholder.id;
  let src;
  try {
    src = await resolveSource(placeholder.online);
  } catch (e) {
    // A player reads this. Whatever the network did, say which half of the
    // job failed and give them the one sentence underneath, not a stack.
    fail(
      `Could not find "${name}" to download.\n${(e && e.message) || e}\n` +
        `Check your connection, or try again later.`,
    );
  }
  if (!src) fail(`"${name}" does not say where to download it from.`);
  try {
    return await downloadPackage(
      game,
      src.url,
      `download-${placeholder.id}`,
      `Downloading ${name}...`,
    );
  } catch (e) {
    fail(
      `Could not download "${name}".\n${(e && e.message) || e}\n` +
        `Check your connection, or try again later.`,
    );
  }
}

async function install(opts) {
  const game = resolveGame(opts.game);
  // Opening the package is the first thing that happens and, for a mod of any
  // size, not the fastest: without this line the window sits on whatever the
  // theme last said until the profile mirror starts reporting, which reads as
  // a button that did nothing.
  progress(0, 1, "Opening the mod...");
  let pkg = await readPackage(opts.modFile);
  let downloaded = null;
  try {
    if (pkg.manifest.online) {
      const placeholder = pkg.manifest;
      downloaded = await fetchOnline(game, placeholder);
      pkg = await readPackage(downloaded);
      // One hop only. A package that points somewhere else again is either a
      // mistake or a redirect chain, and neither is worth following.
      if (pkg.manifest.online) {
        fail(
          `The download for "${placeholder.name || placeholder.id}" is another online placeholder, not the mod.`,
        );
      }
      // The installer already wears the placeholder's identity, and the theme
      // it renders calls back with that id. A download answering to a
      // different one would install a mod the page cannot then address.
      if (pkg.manifest.id !== placeholder.id) {
        fail(
          `The download is "${pkg.manifest.id}", but this installer is for "${placeholder.id}".`,
        );
      }
    }
    await installPackage(game, pkg, opts);
  } finally {
    if (downloaded) fs.rmSync(downloaded, { force: true });
  }
}

async function installPackage(game, { manifest, entries, bytes }, opts) {
  const variant = selectVariant(manifest, game, opts);
  if (!variant) {
    fail(
      `"${manifest.name}" does not support your version of the game.\n` +
        `It was built for: ${(manifest.variants || []).map(labelOf).join(", ")}.\n` +
        `Install it anyway only if you know the builds match.`,
    );
  }

  const id = manifest.id;
  const dir = modDir(game, id);
  progress(0, 1, `Installing ${manifest.name || id}...`);
  unpackInto(dir, manifest, entries);
  fs.writeFileSync(path.join(dir, PACKAGE_NAME), bytes);

  const state = readState(game);
  state.mods[id] = {
    name: manifest.name || id,
    version: manifest.version || "",
    enabled: true,
    saves: manifest.saves === "shared" ? "shared" : "isolated",
    sha: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32),
    installedAt: new Date().toISOString(),
    base: labelOf(variant),
  };
  if (state.order.indexOf(id) === -1) state.order.push(id);
  writeState(game, state);

  const profile = await buildProfile(game, { reason: "install" });
  result({
    id,
    name: manifest.name,
    version: manifest.version,
    base: labelOf(variant),
    profile,
  });
}

function uninstall(opts) {
  const game = resolveGame(opts.game);
  if (!safeId(opts.id)) fail(`Invalid mod id: ${opts.id}`);
  const state = readState(game);
  if (!state.mods[opts.id]) fail(`"${opts.id}" is not installed here.`);

  fs.rmSync(modDir(game, opts.id), { recursive: true, force: true });
  delete state.mods[opts.id];
  state.order = state.order.filter((x) => x !== opts.id);

  if (!Object.keys(state.mods).length) {
    // Last mod out: take the whole addons/ folder with it, so an uninstall
    // leaves the game exactly as Steam installed it, with nothing of ours left.
    fs.rmSync(addonsDir(game), { recursive: true, force: true });
    result({
      id: opts.id,
      removed: true,
      profile: { built: false, dir: null },
    });
    return Promise.resolve();
  }
  writeState(game, state);
  return buildProfile(game, { reason: "uninstall" }).then((profile) => {
    result({ id: opts.id, removed: true, profile });
  });
}

function setEnabled(opts) {
  const game = resolveGame(opts.game);
  if (!safeId(opts.id)) fail(`Invalid mod id: ${opts.id}`);
  const state = readState(game);
  if (!state.mods[opts.id]) fail(`"${opts.id}" is not installed here.`);
  state.mods[opts.id].enabled = !!opts.on;
  writeState(game, state);
  return buildProfile(game, { reason: "enable" }).then((profile) => {
    result({ id: opts.id, enabled: !!opts.on, profile });
  });
}

function setOrder(opts) {
  const game = resolveGame(opts.game);
  const state = readState(game);
  const wanted = String(opts.order || "")
    .split(",")
    .map((s) => s.trim())
    .filter((id) => safeId(id) && state.mods[id]);
  for (const id of Object.keys(state.mods)) {
    if (wanted.indexOf(id) === -1) wanted.push(id);
  }
  state.order = wanted;
  writeState(game, state);
  return buildProfile(game, { reason: "order" }).then((profile) => {
    result({ order: wanted, profile });
  });
}

// status

function status(opts) {
  const game = resolveGame(opts.game);
  const state = readState(game);
  const ids = orderedIds(state);
  const version = baseVersionOf(game.www);

  const mods = ids.map((id) => {
    const rec = state.mods[id] || {};
    const manifest = readManifestOf(game, id) || {};
    return {
      id: id,
      name: manifest.name || rec.name || id,
      author: manifest.author || "",
      version: manifest.version || rec.version || "",
      description: manifest.description || "",
      icon: iconDataUrl(game, id),
      theme: fs.existsSync(path.join(modDir(game, id), "theme", "index.html"))
        ? "theme/index.html"
        : null,
      enabled: rec.enabled !== false,
      installed: true,
      base: rec.base || "",
      saves: rec.saves || "isolated",
      update: manifest.update || null,
      installedAt: rec.installedAt || "",
    };
  });

  const prof = profileDir(game);
  result({
    root: game.root,
    www: game.www,
    wwwRel: game.wwwRel,
    version: version,
    // The older in-place installer's undo archive. Its files are IN the game,
    // so the loader refuses to build a profile over them: the player has to
    // put the game back first.
    legacy: legacyRollbackPath(game) !== null,
    profile: {
      dir: prof,
      built: fs.existsSync(path.join(prof, STAMP_FILE)),
      exe: findExecutable(prof, game.wwwRel),
    },
    exe: findExecutable(game.root, game.wwwRel),
    mods: mods,
  });
}

function legacyRollbackPath(game) {
  for (const p of [
    path.join(game.root, LEGACY_ROLLBACK),
    path.join(game.www, LEGACY_ROLLBACK),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The play profile

/**
 * Cheap signature of the base tree, so a Steam update invalidates the profile
 * instead of leaving the player on silently outdated hardlinks. File count and
 * total size only: it is one stat per file, no reads.
 */
function baseSignature(www) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const stack = [www];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of readdirTypes(d)) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (e) {
        continue;
      }
      files++;
      bytes += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  return { files, bytes, newest: Math.floor(newest) };
}

function profileHash(game, state, ids) {
  const payload = {
    format: STATE_FORMAT,
    wwwRel: game.wwwRel,
    base: baseSignature(game.www),
    saves: savesMode(state, ids),
    mods: ids.map((id) => ({
      id,
      sha: (state.mods[id] || {}).sha || "",
      version: (state.mods[id] || {}).version || "",
    })),
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/** Shared saves only when every enabled mod asked for them. */
function savesMode(state, ids) {
  if (!ids.length) return "isolated";
  return ids.every((id) => (state.mods[id] || {}).saves === "shared")
    ? "shared"
    : "isolated";
}

function enabledIds(state) {
  return orderedIds(state).filter(
    (id) => (state.mods[id] || {}).enabled !== false,
  );
}

/**
 * Mirror one file into the profile. Hardlink first (no disk cost, no copy of
 * the game's content anywhere), then symlink, then copy, so an exotic
 * filesystem degrades in quality rather than failing.
 */
function mirrorFile(src, dst, stats) {
  try {
    fs.linkSync(src, dst);
    stats.linked++;
    return;
  } catch (e) {
    /* fall through */
  }
  try {
    fs.symlinkSync(src, dst);
    stats.symlinked++;
    return;
  } catch (e) {
    /* fall through */
  }
  fs.copyFileSync(src, dst);
  stats.copied++;
}

/**
 * Establish the parts of a profile that are not mirrored from the game and
 * that the game itself can take away.
 *
 * Steam's API DELETES steam_appid.txt as soon as it has read it, so the file
 * is gone once the player has launched once - while nothing about the profile
 * is stale, the stamp still matches and no rebuild is due. Left alone, every
 * launch after the first comes up with no app id and stops at "STEAM MODULE
 * FAILURE". So this runs on every --profile, not only on a rebuild.
 *
 * `rebuilding` is what keeps a repair from touching saves: on a rebuild the
 * shared-save link is (re)made unconditionally, but a profile that fell back
 * to a real save directory (Windows without symlink privilege) must be left
 * exactly as it is. Returns the names it had to put back.
 */
function ensureProfileInvariants(game, dir, saves, savesRel, rebuilding) {
  const repaired = [];
  const savePath = path.join(dir, savesRel);

  if (saves === "shared") {
    const target = path.join(game.www, "save");
    fs.mkdirSync(target, { recursive: true });
    if (rebuilding || !fs.existsSync(savePath)) {
      fs.rmSync(savePath, { recursive: true, force: true });
      try {
        fs.symlinkSync(target, savePath, "junction");
      } catch (e) {
        // No symlink privilege: fall back to a real directory. The player
        // keeps separate saves, which is a smaller surprise than refusing to
        // launch.
        fs.mkdirSync(savePath, { recursive: true });
        emit("progress", {
          done: 1,
          total: 1,
          message:
            "Shared saves are not available here; this profile keeps its own.",
        });
      }
      repaired.push(savesRel);
    }
  } else if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath, { recursive: true });
    repaired.push(savesRel);
  }

  const appidFile = path.join(dir, STEAM_APPID_FILE);
  if (!fs.existsSync(appidFile)) {
    fs.writeFileSync(appidFile, STEAM_APPID + "\n");
    repaired.push(STEAM_APPID_FILE);
  }
  return repaired;
}

async function buildProfile(game, opts) {
  const state = readState(game);
  const ids = enabledIds(state);
  const dir = profileDir(game);

  if (!ids.length) {
    // Nothing to play through: drop the profile so the game folder holds no
    // stale mirror of a build the player is no longer running.
    fs.rmSync(dir, { recursive: true, force: true });
    return { built: false, dir: null, rebuilt: true, mods: 0 };
  }

  const legacy = legacyRollbackPath(game);
  if (legacy) {
    fail(
      `This game still has a mod installed the old way (${path.basename(legacy)}).\n` +
        `Restore the original files first. The loader will not build a profile ` +
        `on top of an already-modified game.`,
    );
  }

  const saves = savesMode(state, ids);
  const savesRel = game.wwwRel + "/save";

  const hash = profileHash(game, state, ids);
  const stamp = path.join(dir, STAMP_FILE);
  if (!(opts && opts.force)) {
    try {
      if (fs.readFileSync(stamp, "utf8").trim() === hash) {
        return {
          built: true,
          dir,
          rebuilt: false,
          mods: ids.length,
          repaired: ensureProfileInvariants(game, dir, saves, savesRel, false),
          exe: findExecutable(dir, game.wwwRel),
        };
      }
    } catch (e) {
      /* no stamp: build it */
    }
  }

  progress(0, 1, "Preparing the mod profile...");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });


  const stats = { linked: 0, symlinked: 0, copied: 0, dirs: 0 };

  // 1. Mirror the game root. addons/ is ours and never enters the profile;
  //    everything else does, including the executable and package.json, which
  //    is what lets the game be launched FROM the profile.
  const files = [];
  (function walk(rel) {
    const abs = rel ? path.join(game.root, rel) : game.root;
    for (const ent of readdirTypes(abs)) {
      const childRel = rel ? rel + "/" + ent.name : ent.name;
      if (!rel && ent.name === ADDONS) continue;
      if (ent.isDirectory()) {
        stats.dirs++;
        fs.mkdirSync(path.join(dir, childRel), { recursive: true });
        walk(childRel);
      } else {
        files.push(childRel);
      }
    }
  })("");

  const total = files.length;
  let done = 0;
  for (const rel of files) {
    const src = path.join(game.root, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // Saves are the one thing a player writes to. An isolated profile gets its
    // own real copy so playing a mod cannot touch the unmodded save files.
    if (
      saves === "isolated" &&
      (rel === savesRel || rel.startsWith(savesRel + "/"))
    ) {
      fs.copyFileSync(src, dst);
      stats.copied++;
    } else {
      let st = null;
      try {
        st = fs.lstatSync(src);
      } catch (e) {
        st = null;
      }
      if (st && st.isSymbolicLink()) {
        try {
          fs.symlinkSync(fs.readlinkSync(src), dst);
          stats.symlinked++;
        } catch (e) {
          mirrorFile(src, dst, stats);
        }
      } else {
        mirrorFile(src, dst, stats);
      }
    }
    done++;
    if (done % 64 === 0 || done === total)
      progress(done, total, "Preparing the mod profile...");
  }

  // Shared saves, and the app id the Steam client would otherwise have handed
  // the process: everything the profile carries that the game folder does not.
  const repaired = ensureProfileInvariants(game, dir, saves, savesRel, true);

  // 2. Apply each enabled mod, in load order, into the profile only.
  const applied = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    progress(i, ids.length, `Applying ${(state.mods[id] || {}).name || id}...`);
    applied.push(await applyModIntoProfile(game, dir, id));
  }

  fs.writeFileSync(stamp, hash + "\n");
  progress(1, 1, "Ready.");
  return {
    built: true,
    dir,
    rebuilt: true,
    mods: ids.length,
    saves,
    repaired,
    applied,
    mirror: stats,
    exe: findExecutable(dir, game.wwwRel),
  };
}

/**
 * Apply one installed mod's entries into an already-mirrored profile.
 *
 * THE INVARIANT: every write removes the mirrored entry first and creates a
 * new file in its place. A mirrored entry is a hardlink to the player's own
 * game file, so opening it for writing would write THROUGH the link, into the
 * original, the exact thing this loader exists to prevent. There is no code
 * path here that opens an existing profile path for writing.
 */
async function applyModIntoProfile(game, dir, id) {
  const modFile = path.join(modDir(game, id), PACKAGE_NAME);
  const { manifest, entries } = await readPackage(modFile);
  const variant = selectVariant(manifest, game, { force: true });
  const wwwOut = path.join(dir, game.wwwRel);
  const counts = { written: 0, deleted: 0, patched: 0 };

  for (const f of variant.files || []) {
    if (!safeRel(f.rel)) fail(`Refusing an unsafe path in "${id}": ${f.rel}`);
    const abs = path.join(wwwOut, f.rel);

    if (f.type === "delete") {
      fs.rmSync(abs, { force: true });
      counts.deleted++;
      continue;
    }

    let plain;
    if (f.type === "verbatim") {
      plain = entries.get(f.payload);
      if (!plain)
        fail(
          `"${id}" is incomplete: missing payload ${f.payload} for ${f.rel}.`,
        );
    } else if (f.type === "patch") {
      if (!fs.existsSync(abs)) {
        fail(
          `"${id}" cannot patch ${f.rel}: it is missing from your game.\n` +
            `Your copy does not match the build this mod was made for.`,
        );
      }
      // Read the profile's current bytes, not the game's: an earlier mod in
      // the load order may already have rewritten this file, and later mods
      // patch what they actually find.
      const live = new Uint8Array(fs.readFileSync(abs));
      const doc = JSON.parse(new TextDecoder().decode(C.dekit(live, f.rel)));
      plain = new TextEncoder().encode(
        JSON.stringify(J.apply(doc, f.ops || [])),
      );
      counts.patched++;
    } else {
      fail(`Unknown entry type "${f.type}" for ${f.rel} in "${id}".`);
    }

    const out = f.enc ? C.enkit(plain, f.rel, f.key || 0) : plain;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.rmSync(abs, { force: true }); // unlink first: see the invariant above
    fs.writeFileSync(abs, out);
    counts.written++;
  }
  return { id, ...counts };
}

/**
 * Whether `file` is something this machine can actually exec.
 *
 * The permission bits alone cannot answer that here. Steam gives every file
 * it writes mode 0755, so in a Linux copy of the game `credits.html` looks
 * exactly as runnable as the game does, and picking it is how Play ends up
 * reporting "Exec format error". What the kernel will accept is a native
 * binary or a script with an interpreter line, and that is what the first
 * four bytes say: ELF on Linux, one of the Mach-O magics (thin, both
 * endiannesses and both widths, plus the fat header) on macOS, or `#!`.
 */
/** A Windows PE image ("MZ"), whatever the file is called. */
function isWindowsExecutable(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(2);
    if (fs.readSync(fd, head, 0, 2, 0) < 2) return false;
    return head[0] === 0x4d && head[1] === 0x5a;
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* nothing to do */
      }
    }
  }
}

function isNativeExecutable(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || !(st.mode & 0o111)) return false;
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    if (head[0] === 0x23 && head[1] === 0x21) return true; // #!
    if (head.toString("latin1") === "\x7fELF") return true;
    const magic = head.readUInt32BE(0);
    return (
      magic === 0xfeedface || // Mach-O 32-bit
      magic === 0xfeedfacf || // Mach-O 64-bit
      magic === 0xcefaedfe || // ... byte-swapped
      magic === 0xcffaedfe ||
      magic === 0xcafebabe || // universal binary
      magic === 0xbebafeca
    );
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* already gone */
      }
    }
  }
}

/**
 * The game's own executable inside `dir`. Everything at the root that is not
 * ours, not the shipped tree and not a known helper, preferring a name that
 * matches the folder, which is what the game's launcher is called.
 */
function findExecutable(dir, wwwRel) {
  if (!fs.existsSync(dir)) return null;
  const skip =
    /^(unins|crashpad|notification_helper|nwjc|chromedriver|payload)/i;
  const wwwTop = String(wwwRel || "www").split("/")[0];
  const candidates = [];
  const fallbacks = [];
  for (const ent of readdirTypes(dir)) {
    if (ent.name === ADDONS || ent.name === wwwTop || skip.test(ent.name))
      continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // macOS: the bundle is what gets launched.
      if (ent.name.endsWith(".app")) candidates.push(abs);
      continue;
    }
    if (process.platform === "win32") {
      if (/\.exe$/i.test(ent.name)) candidates.push(abs);
    } else if (/\.exe$/i.test(ent.name)) {
      // A Windows build on a Linux or macOS machine: that is what a Steam copy
      // running under Proton is, and it is still the thing to launch. Kept as
      // a fallback so a native binary, where one exists, wins.
      fallbacks.push(abs);
    } else {
      if (
        /\.(so|dll|dylib|dat|pak|bin|json|txt|md|ini|log|zip)$/i.test(ent.name)
      )
        continue;
      if (isNativeExecutable(abs)) candidates.push(abs);
      // A Windows binary that is not called .exe is still a Windows binary,
      // and the app decides how to start the game from these same bytes.
      else if (isWindowsExecutable(abs)) fallbacks.push(abs);
    }
  }
  const pool = candidates.length ? candidates : fallbacks;
  if (!pool.length) return null;
  const wanted = path.basename(dir).toLowerCase();
  pool.sort((a, b) => {
    const an = path.basename(a, path.extname(a)).toLowerCase();
    const bn = path.basename(b, path.extname(b)).toLowerCase();
    return (bn === wanted ? 1 : 0) - (an === wanted ? 1 : 0);
  });
  return pool[0];
}

// Downloading: updates, and online installers
//
// Every source is a plain HTTPS GET run through the bundled Node's own fetch:
// no HTTP client in the app, and nothing is ever fetched unless the mod author
// put a source in mod.json. Two fields use the same three source shapes:
//
//   "update": {...}  where a NEWER version of an installed mod lives
//   "online": {...}  where the mod ITSELF lives, for an installer stamped
//                    with a placeholder package that carries only the mod's
//                    name, icon and theme (see readPackage and install)
//
// A source is one of:
//
//   { "url": "https://.../mod.tcoaalmod" }   a direct link
//   { "github": "owner/repo" }               the latest release's .tcoaalmod
//   { "manifest": "https://.../x.json" }     {version, url} written by the author
//
// A direct url carries no version of its own, so it can deliver a mod but can
// never report an update; the other two can do both.

function compareVersions(a, b) {
  const pa = String(a || "").split(/[.\-+]/);
  const pb = String(b || "").split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    if (isNaN(na) && isNaN(nb)) continue;
    if (isNaN(na)) return -1;
    if (isNaN(nb)) return 1;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "tcoaal-mod-loader" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * Refuse anything but https, for both source documents and the package they
 * point at. A mod is executable content: fetching one over a channel any
 * network between here and the author can rewrite is not a risk worth taking
 * to support a scheme nobody hosting a release uses.
 */
function httpsUrl(raw, what) {
  const url = String(raw || "");
  if (!/^https:\/\//i.test(url)) {
    fail(`${what} must be an https:// URL, not "${url}".`);
  }
  return url;
}

/**
 * Resolve one `{url|github|manifest}` source to the package it names.
 * Returns null when the source is empty or answers with nothing usable.
 */
async function resolveSource(src) {
  const s = src || {};
  if (s.url) {
    // A bare link names no version, so "" is the honest answer: it makes
    // compareVersions report "not newer" rather than inventing a number.
    return {
      version: "",
      url: httpsUrl(s.url, "The download URL"),
      via: "url",
    };
  }
  if (s.manifest) {
    const doc = await fetchJson(httpsUrl(s.manifest, "The update file URL"));
    const version = doc.version || (doc.latest && doc.latest.version);
    const url = doc.url || doc.download || (doc.latest && doc.latest.url);
    if (version && url)
      return {
        version: String(version),
        url: httpsUrl(url, "The URL in the update file"),
        via: "manifest",
      };
  }
  if (s.github) {
    const doc = await fetchJson(
      `https://api.github.com/repos/${s.github}/releases/latest`,
    );
    const asset = (doc.assets || []).find((a) =>
      /\.tcoaalmod$/i.test(a.name || ""),
    );
    const version = String(doc.tag_name || "").replace(/^v/, "");
    if (asset && version) {
      return {
        version,
        url: httpsUrl(asset.browser_download_url, "The release asset URL"),
        via: "github",
      };
    }
  }
  return null;
}

async function latestFor(manifest) {
  return resolveSource(manifest.update);
}

/**
 * Download a .tcoaalmod to a scratch file beside the game's addons and return
 * its path. The caller owns the file and must remove it.
 */
async function downloadPackage(game, url, name, label) {
  progress(0, 1, label);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`Download failed: ${url} answered ${res.status}`);
  // Read the body in chunks rather than in one await: a mod is the biggest
  // thing this tool ever moves and the download is the part a player waits
  // longest on, so it is the part that has to report a real fraction. A server
  // that sends no content-length still gets the phase line above.
  const len =
    res.headers && typeof res.headers.get === "function"
      ? res.headers.get("content-length")
      : null;
  const total = Number(len) || 0;
  const streamable =
    res.body && typeof res.body[Symbol.asyncIterator] === "function";
  let bytes;
  if (total > 0 && streamable) {
    const chunks = [];
    let got = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      got += buf.length;
      progress(Math.min(got, total), total, label);
    }
    bytes = Buffer.concat(chunks);
  } else {
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const tmp = path.join(addonsDir(game), `.${name}.tcoaalmod`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, bytes);
  // The caller removes this on its way out, but fail() ends the process with
  // process.exit, which does NOT unwind a pending finally. Without this, every
  // failure AFTER the download (a base mismatch is the ordinary one) leaves a
  // whole mod sitting in the player's addons folder forever.
  process.once("exit", () => {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {}
  });
  return tmp;
}

async function checkUpdate(opts) {
  const game = resolveGame(opts.game);
  const state = readState(game);
  const ids = opts.id ? [opts.id] : orderedIds(state);
  const out = [];
  for (const id of ids) {
    const manifest = readManifestOf(game, id);
    if (!manifest || !manifest.update) continue;
    try {
      const latest = await latestFor(manifest);
      if (!latest) continue;
      out.push({
        id,
        current: manifest.version || "",
        version: latest.version,
        url: latest.url,
        via: latest.via,
        newer: compareVersions(manifest.version, latest.version) < 0,
      });
    } catch (e) {
      out.push({ id, error: String((e && e.message) || e) });
    }
  }
  result({ updates: out });
}

async function applyUpdate(opts) {
  const game = resolveGame(opts.game);
  if (!safeId(opts.id)) fail(`Invalid mod id: ${opts.id}`);
  const manifest = readManifestOf(game, opts.id);
  if (!manifest) fail(`"${opts.id}" is not installed here.`);
  const latest = await latestFor(manifest);
  if (!latest) fail(`"${opts.id}" has no update source.`);

  const tmp = await downloadPackage(
    game,
    latest.url,
    `update-${opts.id}`,
    `Downloading ${manifest.name} ${latest.version}...`,
  );
  try {
    await install({ game: opts.game, modFile: tmp, force: opts.force });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// CLI

function printHelp() {
  process.stdout.write(
    "Install and play .tcoaalmod packages without modifying the game.\n\n" +
      "  node tools/mod-loader.js --status    --game <GameFolder>\n" +
      "  node tools/mod-loader.js --install   <mod.tcoaalmod> --game <GameFolder>\n" +
      "  node tools/mod-loader.js --uninstall <id> --game <GameFolder>\n" +
      "  node tools/mod-loader.js --enable    <id> --on 0|1 --game <GameFolder>\n" +
      "  node tools/mod-loader.js --order     <id,id,...> --game <GameFolder>\n" +
      "  node tools/mod-loader.js --profile   --game <GameFolder> [--force]\n" +
      "  node tools/mod-loader.js --check-update [id] --game <GameFolder>\n" +
      "  node tools/mod-loader.js --unpack  <mod.tcoaalmod> --out <dir>\n" +
      "  node tools/mod-loader.js --apply-update <id> --game <GameFolder>\n\n" +
      "  --force   install even when no variant matches the game exactly\n",
  );
}

function parseArgs(argv) {
  const opts = { mode: "help", force: false, on: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") opts.mode = "status";
    else if (a === "--profile") opts.mode = "profile";
    else if (a === "--install") {
      opts.mode = "install";
      opts.modFile = argv[++i];
    } else if (a === "--uninstall") {
      opts.mode = "uninstall";
      opts.id = argv[++i];
    } else if (a === "--enable") {
      opts.mode = "enable";
      opts.id = argv[++i];
    } else if (a === "--order") {
      opts.mode = "order";
      opts.order = argv[++i];
    } else if (a === "--check-update") {
      opts.mode = "check-update";
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.id = argv[++i];
    } else if (a === "--apply-update") {
      opts.mode = "apply-update";
      opts.id = argv[++i];
    } else if (a === "--unpack") {
      opts.mode = "unpack";
      opts.modFile = argv[++i];
    } else if (a === "--out") opts.out = argv[++i];
    else if (a === "--game") opts.game = argv[++i];
    else if (a === "--on") {
      const v = argv[++i];
      opts.on = v !== "0" && v !== "false";
    } else if (a === "--force") opts.force = true;
    else if (a === "-h" || a === "--help") opts.mode = "help";
    else fail(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const needsGame = opts.mode !== "help" && opts.mode !== "unpack";
  if (needsGame && !opts.game)
    fail(`--${opts.mode} requires --game <GameFolder>.`);

  if (opts.mode === "unpack") {
    if (!opts.out) fail("--unpack requires --out <dir>.");
    await unpack(opts);
  } else if (opts.mode === "status") status(opts);
  else if (opts.mode === "install") await install(opts);
  else if (opts.mode === "uninstall") await uninstall(opts);
  else if (opts.mode === "enable") await setEnabled(opts);
  else if (opts.mode === "order") await setOrder(opts);
  else if (opts.mode === "profile") {
    const game = resolveGame(opts.game);
    result({ profile: await buildProfile(game, { force: opts.force }) });
  } else if (opts.mode === "check-update") await checkUpdate(opts);
  else if (opts.mode === "apply-update") await applyUpdate(opts);
  else printHelp();
}

if (require.main === module) {
  main().catch((e) => fail(String((e && e.stack) || e)));
}

module.exports = {
  resolveGame,
  unpackInto,
  readState,
  writeState,
  buildProfile,
  findExecutable,
  compareVersions,
  safeRel,
  safeId,
  parseArgs,
  FORMAT,
  ADDONS,
};

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
 * Builds a mod repository into a .tcoaalmod and its installers, without a
 * browser and without the game: the release workflow's half of what
 * app/create.html does by hand (templates/mod-repo/ has the workflow).
 *
 * The repository describes the mod in .config/:
 *
 *   .config/mod.json         id, name, author, description, game, content,
 *                            saves, plugins, updates (see readConfig below)
 *   .config/base-index.json  the reference index of the game release the mod
 *                            is built on (ModDiff.baseIndex)
 *   .config/icon.png         optional, the mod's icon (PNG, JPEG, WebP)
 *   .config/theme/           optional, the installer's page: index.html and
 *                            what it loads, plus an optional music.<ext>
 *
 * app/create.html downloads all of it as the "GitHub setup", filled
 * from its form, its Customize screen and the game imported there.
 *
 * The mod's files are laid out as the game's www folder is (data/, img/,
 * js/, ...): the files the mod adds or changes. See contentRoot for where
 * they are looked for.
 *
 * What the runner cannot have is the game, so the rule create.html applies
 * against the player's own copy is applied here against the reference index
 * in .config/base-index.json (the hash of every game file's decoded bytes,
 * nothing of the game). A file of the mod's that the game already holds
 * travels as a reference to the player's copy, never as its bytes. What the
 * index cannot do is make patches, which need the game's own bytes: an
 * edited data file travels whole. Without an index every file travels whole
 * and the build says so.
 *
 * Where the mod is published is not configured: the workflow passes its own
 * repository (--github $GITHUB_REPOSITORY), which is where it creates the
 * release, so installers and update checks point there by construction.
 *
 *   node tools/build-mod.js --repo . --version 1.2.3 --out dist
 *        [--installers offline,online] [--os windows,macos,linux]
 *        [--github owner/repo] [--site https://tcoaal.app]
 *
 * Every library below is the browser's own file (tools/lib/load-libs.js):
 * the package, the stamping and the codec are create.html's code, not a
 * second implementation of it.
 */

const fs = require("fs");
const path = require("path");
const { loadLibs } = require("./lib/load-libs.js");

const DEFAULT_SITE = "https://tcoaal.app";
const OS_STUBS = {
  windows: "win-x64.exe",
  macos: "macos.zip",
  linux: "linux-x86_64.AppImage",
};
const OS_SUFFIX = {
  windows: ".exe",
  macos: ".app.zip",
  linux: ".AppImage",
};
// Files a repository holds that are never part of a mod.
const IGNORED_NAME = /^(\.git.*|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
// The shipped notices directly in www (see NOTICE_RE in mod-diff-worker.js):
// the game hashes one of them on boot, so a mod must never carry them.
const NOTICE_RE = /^[^/]+\.(txt|url)$/i;

class BuildError extends Error {}

function fail(msg) {
  throw new BuildError(msg);
}

// Arguments

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail("Unexpected argument: " + a);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function listArg(v, allowed, what) {
  if (v === undefined || v === true) return allowed.slice();
  const items = String(v)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const it of items) {
    if (allowed.indexOf(it) === -1) {
      fail(`Unknown ${what} "${it}". Use: ${allowed.join(", ")}.`);
    }
  }
  return [...new Set(items)];
}

// Paths

/*
 * Every name here becomes a path on a player's disk (theme files, and the
 * mod's own files through the native loader), so the rule is create.html's
 * isSafeRelPath: no escape, no drive-relative segment, no DOS device name,
 * no trailing dot or space.
 */
function isSafeRelPath(rel) {
  if (typeof rel !== "string" || !rel) return false;
  if (rel.indexOf("\\") !== -1) return false;
  const illegal = /[<>:"|?*\x00-\x1f]/;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  for (const p of rel.split("/")) {
    if (p === "" || p === "." || p === "..") return false;
    if (illegal.test(p) || reserved.test(p) || /[ .]$/.test(p)) return false;
  }
  return true;
}

// At the repository root, what belongs to the repository rather than to the
// game's www folder: dot folders and files (.config, .github, .gitignore,
// ...) and the usual documents. The game's www has none of them at its top.
const REPO_ROOT_ONLY = /^(\..*|readme(\..*)?|license(\..*)?|licence(\..*)?|copying(\..*)?|changelog(\..*)?|.*\.md)$/i;

// The top-level folders of a game's www; a repository root holding one of
// them is the mod's www folder itself.
const WWW_DIRS = ["data", "img", "js", "audio", "fonts", "movies", "icon"];

function walkFiles(dir, atRepoRoot) {
  const out = [];
  (function rec(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (IGNORED_NAME.test(e.name)) continue;
      if (atRepoRoot && !rel && REPO_ROOT_ONLY.test(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) rec(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  })(dir, "");
  return out.sort();
}

// Configuration

/*
 * .config/mod.json, checked with create.html's own rules so a repository
 * cannot build what the page would refuse:
 *
 *   id           lowercase letters, digits and dashes, 3 to 40 characters
 *   name         up to 60 characters
 *   author       optional
 *   description  optional, up to 500 characters
 *   game         the game release the mod is made for, such as "3.0.13";
 *                optional when .config/base-index.json says it
 *   content      "" (default) or a path from the repository root: where to
 *                look for the mod's files (see contentRoot)
 *   icon         the icon inside .config (default "icon.png" when present)
 *   saves        "isolated" (default) or "shared"
 *   plugins      Browser Player plugins to ship, by name (see
 *                app/js/libs/bundled-plugins.js)
 *   updates      false to leave installers without an update source
 */
function readConfig(repo, bundled) {
  const dir = path.join(repo, ".config");
  const file = path.join(dir, "mod.json");
  if (!fs.existsSync(file)) fail("No .config/mod.json in " + repo + ".");
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(".config/mod.json is not valid JSON: " + e.message);
  }
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const cfg = {
    id: str(c.id),
    name: str(c.name),
    author: str(c.author),
    description: str(c.description),
    game: str(c.game),
    content: str(c.content),
    icon: str(c.icon),
    saves: str(c.saves) || "isolated",
    plugins: Array.isArray(c.plugins) ? c.plugins.map(String) : [],
    updates: c.updates !== false,
  };
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(cfg.id)) {
    errors.push('"id": use lowercase letters, digits and dashes, 3 to 40 characters.');
  }
  if (!cfg.name) errors.push('"name" is required.');
  else if (cfg.name.length > 60) errors.push('"name": 60 characters or fewer.');
  if (cfg.description.length > 500) {
    errors.push('"description": 500 characters or fewer.');
  }
  if (cfg.game && !/^\d+(\.\d+)+$/.test(cfg.game)) {
    errors.push('"game": the game release the mod is made for, such as "3.0.13".');
  }
  if (cfg.saves !== "isolated" && cfg.saves !== "shared") {
    errors.push('"saves": "isolated" or "shared".');
  }
  if (cfg.content && cfg.content !== "." && !isSafeRelPath(cfg.content)) {
    errors.push('"content": a folder inside the repository.');
  }
  const known = bundled.map((p) => p.name);
  for (const p of cfg.plugins) {
    if (known.indexOf(p) === -1) {
      errors.push(`"plugins": unknown plugin "${p}". Available: ${known.join(", ")}.`);
    }
  }
  if (errors.length) fail("Fix .config/mod.json:\n  " + errors.join("\n  "));

  contentRoot(repo, cfg);
  const iconName = cfg.icon || (fs.existsSync(path.join(dir, "icon.png")) ? "icon.png" : "");
  cfg.iconFile = iconName ? path.join(dir, iconName) : null;
  if (cfg.iconFile && !fs.existsSync(cfg.iconFile)) {
    fail(`The icon .config/${iconName} does not exist.`);
  }
  cfg.themeDir = path.join(dir, "theme");
  cfg.index = readIndex(path.join(dir, "base-index.json"));
  if (cfg.index) {
    if (cfg.game && cfg.game !== cfg.index.game) {
      fail(
        `.config/mod.json says the mod is for v${cfg.game}, but .config/base-index.json ` +
          `describes v${cfg.index.game}. Download the GitHub setup again from the game the mod is built on.`,
      );
    }
    cfg.game = cfg.index.game;
  } else if (!cfg.game) {
    fail('Name the game release in .config/mod.json ("game": "3.0.13") or add .config/base-index.json.');
  }
  return cfg;
}

function readIndex(file) {
  if (!fs.existsSync(file)) return null;
  let index;
  try {
    index = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(".config/base-index.json is not valid JSON: " + e.message);
  }
  if (
    !index ||
    index.format !== "tcoaal-base-index/1" ||
    !index.files ||
    !index.fingerprint ||
    !/^\d+(\.\d+)+$/.test(String(index.game))
  ) {
    fail(".config/base-index.json is not a base index (tcoaal-base-index/1).");
  }
  return index;
}

/*
 * Where the mod's files are. The search starts at `content`, a path from the
 * repository root ("" is the root itself), and takes, in order:
 *   - its www/ folder, when it has one;
 *   - the folder itself, when it is laid out like a www folder (holds data/,
 *     img/, js/, ...).
 * So `content` may name the www folder or the folder around it, and "" finds
 * either at the root. Sets cfg.content (for messages), cfg.contentDir and
 * cfg.atRepoRoot.
 */
function isDir(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function contentRoot(repo, cfg) {
  const start = path.join(repo, cfg.content || ".");
  const where = cfg.content ? `"${cfg.content}"` : "the repository root";
  if (!isDir(start)) fail(`The content folder ${where} does not exist.`);
  if (isDir(path.join(start, "www"))) {
    cfg.contentDir = path.join(start, "www");
  } else if (WWW_DIRS.some((d) => isDir(path.join(start, d)))) {
    cfg.contentDir = start;
  } else {
    fail(
      `No mod files found in ${where}: it needs a www/ folder, or to be laid ` +
        "out like the game's www folder itself (data/, img/, js/, ...).",
    );
  }
  cfg.content = path.relative(repo, cfg.contentDir).split(path.sep).join("/") || ".";
  cfg.atRepoRoot = path.resolve(cfg.contentDir) === path.resolve(repo);
}

function validateVersion(v) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) {
    fail(`"${v}" is not a version such as 1.0.0.`);
  }
  return v;
}

function githubSlug(v) {
  if (!v || v === true) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(v)) {
    fail(`"${v}" is not a GitHub repository (owner/repo).`);
  }
  return v;
}

// Network

async function fetchBytes(url, what) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    fail(`Could not download ${what} (${url}): ${e.message}`);
  }
  if (!res.ok) fail(`Could not download ${what} (${url}): HTTP ${res.status}.`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchJsonOrNull(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Icon

let _sharp = null;
function sharp() {
  if (_sharp) return _sharp;
  try {
    _sharp = require("sharp");
  } catch (e) {
    fail(
      "The icon needs the sharp image library: run `npm install sharp` " +
        "next to tools/ (the release workflow does).",
    );
  }
  return _sharp;
}

// create.html re-encodes the picked image as PNG capped at 512px: the same
// here, so a package's icon.png is the same whichever tool built it.
async function loadIcon(file) {
  const img = sharp()(fs.readFileSync(file));
  const meta = await img.metadata();
  const size = Math.min(512, Math.max(meta.width || 0, meta.height || 0) || 512);
  const png = await img
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

async function iconSizes(png, sizes) {
  const out = new Map();
  for (const s of sizes) {
    const b = await sharp()(Buffer.from(png)).resize(s, s).png().toBuffer();
    out.set(s, new Uint8Array(b));
  }
  return out;
}

// Theme

function readTheme(themeDir) {
  if (!fs.existsSync(themeDir)) return [];
  const rels = walkFiles(themeDir);
  if (!rels.length) return [];
  if (rels.indexOf("index.html") === -1) {
    fail(".config/theme/ has files but no index.html: the installer opens that page.");
  }
  return rels.map((rel) => {
    if (!isSafeRelPath(rel)) fail(`Unsafe theme file name: .config/theme/${rel}`);
    return { name: "theme/" + rel, data: new Uint8Array(fs.readFileSync(path.join(themeDir, rel))) };
  });
}

// The package

/*
 * The mod's files as one variant, against the reference index when there is
 * one. Mirrors ModDiff.classify for the cases an index can decide:
 *
 *   the game's own file under its own name     left out (untouched)
 *   the game's own content under another name  copy from the game's file
 *   anything else                              verbatim
 *
 * An encrypted file of the mod's is never turned into a copy, for the reason
 * classify gives (its mask depends on the name it is laid down under).
 */
async function diffAgainstIndex(L, source, index, payloads) {
  const C = L.TcoaalCodec;
  const byHash = new Map();
  if (index) {
    for (const rel of Object.keys(index.files).sort()) {
      if (NOTICE_RE.test(rel)) continue;
      const h = index.files[rel];
      if (!byHash.has(h)) byHash.set(h, rel);
    }
  }
  const files = [];
  const stats = { mode: "overlay", added: 0, replaced: 0, copied: 0, unchanged: 0 };
  for (const rel of await source.list()) {
    if (NOTICE_RE.test(rel)) continue;
    const raw = await source.read(rel);
    const plain = C.dekit(raw, rel);
    const enc = C.isEncrypted(raw);
    const h = await L.ModDiff.sha16(plain);
    const storage = (await C.storagePath(rel)).rel;
    const inBase = !!(index && index.files[storage] !== undefined);
    let from = null;
    if (inBase && index.files[storage] === h) from = storage;
    else if (byHash.has(h)) from = byHash.get(h);
    if (from !== null && from === rel) {
      stats.unchanged++;
      continue;
    }
    if (from !== null && !enc) {
      files.push({ rel, type: "copy", from, enc: false });
      stats.copied++;
      continue;
    }
    const key = "f/" + h;
    if (!payloads.has(key)) payloads.set(key, plain);
    const encFields = enc ? { enc: true, key: C.readKeyByte(raw) } : { enc: false };
    files.push(Object.assign({ rel }, encFields, { type: "verbatim", payload: key }));
    if (inBase) stats.replaced++;
    else stats.added++;
  }
  return { files, stats };
}

async function fetchPlugins(site, bundled, names) {
  const out = [];
  for (const name of names) {
    const p = bundled.find((b) => b.name === name);
    const url = site + "/" + p.src.replace(/\?.*$/, "");
    const bytes = await fetchBytes(url, "the " + p.title + " plugin");
    if (!bytes.length) fail(`The ${p.title} plugin came back empty.`);
    out.push({
      file: p.file,
      bytes,
      name: p.name,
      status: true,
      description: p.description,
      parameters: p.parameters || {},
    });
  }
  return out;
}

// Installers

function stubUrl(site, entry) {
  return site + "/stub/" + entry.file;
}

async function stamp(L, os, stub, payload, meta, iconPng) {
  const S = L.StubStamp;
  if (os === "windows") {
    if (!iconPng) return S.attachTrailer(stub, payload);
    const sizes = [16, 32, 48, 64, 128, 256];
    const pngs = await iconSizes(iconPng, sizes);
    return S.stampWindows(stub, {
      payload,
      icons: sizes.map((s) => ({ width: s, height: s, png: pngs.get(s) })),
      name: meta.name,
    });
  }
  if (os === "macos") {
    let icnsBytes;
    if (iconPng) {
      icnsBytes = L.Icns.build(await iconSizes(iconPng, [32, 64, 128, 256, 512, 1024]));
    } else {
      const entries = await L.ModPackage.readZip(stub);
      for (const [key, data] of entries) {
        if (/\/Contents\/Resources\/icon\.icns$/.test(key)) icnsBytes = data;
      }
      if (!icnsBytes) fail("The macOS stub has no icon to keep.");
    }
    return S.stampMac(stub, {
      payload,
      icnsBytes,
      name: meta.name,
      bundleId: "app.tcoaal.mod." + meta.id,
    });
  }
  return S.stampLinux(stub, { payload });
}

// Build

async function build(opts) {
  const log = opts.log || console.log;
  const site = String(opts.site || DEFAULT_SITE).replace(/\/+$/, "");
  const L = loadLibs([
    "tcoaal-codec",
    "json-diff",
    "mod-package",
    "mod-diff-worker",
    "pe-resources",
    "icns",
    "stub-stamp",
    "bundled-plugins",
  ]);
  const P = L.ModPackage;
  const repo = path.resolve(opts.repo || ".");
  const version = validateVersion(String(opts.version || ""));
  const installers = opts.installers || [];
  const oses = opts.os || [];
  const github = githubSlug(opts.github);
  const cfg = readConfig(repo, L.BundledPlugins);
  if (installers.indexOf("online") !== -1 && !github) {
    fail("Online installers download the mod from a GitHub repository: pass --github owner/repo.");
  }

  // The mod's tree, with the chosen plugins laid on top as create.html does.
  const rels = walkFiles(cfg.contentDir, cfg.atRepoRoot);
  if (!rels.length) fail(`The content folder "${cfg.content}" is empty.`);
  for (const rel of rels) {
    if (!isSafeRelPath(rel)) fail(`Unsafe file name in ${cfg.content}/: ${rel}`);
  }
  let source = {
    list: async () => rels.slice(),
    read: async (rel) => new Uint8Array(fs.readFileSync(path.join(cfg.contentDir, rel))),
  };
  if (cfg.plugins.length) {
    log(`Fetching plugins: ${cfg.plugins.join(", ")}`);
    const plugins = await fetchPlugins(site, L.BundledPlugins, cfg.plugins);
    // The game's own js/plugins.js is not here to add them to: the mod has
    // to ship its registry for the plugins to be registered in.
    const noBase = { list: async () => [], read: async () => null };
    try {
      source = await L.ModDiff.bundlePlugins(source, noBase, plugins);
    } catch (e) {
      fail(
        "Shipping plugins needs the mod's own js/plugins.js in " + cfg.content +
          "/ (the game's cannot be read here): " + e.message,
      );
    }
  }

  const index = cfg.index;
  if (!index) {
    log(
      "warning: no .config/base-index.json; every file is packaged as it is, " +
        "including any the game already has.",
    );
  }

  const payloads = new Map();
  const diff = await diffAgainstIndex(L, source, index, payloads);
  if (!diff.files.length) fail("Every file of the mod is already the game's own: nothing to package.");
  if (cfg.plugins.length) diff.stats.bundled = cfg.plugins.slice();
  const fingerprint = index ? index.fingerprint : { gameVersion: cfg.game };
  const variants = [{ base: { label: "v" + cfg.game, fingerprint }, files: diff.files, stats: diff.stats }];

  const iconPng = cfg.iconFile ? await loadIcon(cfg.iconFile) : null;
  const theme = readTheme(cfg.themeDir);
  const meta = {
    id: cfg.id,
    name: cfg.name,
    author: cfg.author,
    version,
    description: cfg.description,
    icon: iconPng,
    saves: cfg.saves,
    update: cfg.updates && github ? { github } : null,
    theme,
  };
  const pkg = await P.build(Object.assign({}, meta, { variants, payloads }));

  const out = path.resolve(opts.out || "dist");
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  const write = (name, bytes) => {
    fs.writeFileSync(path.join(out, name), bytes);
    written.push(name);
    log(`  ${name} (${(bytes.length / 1048576).toFixed(1)} MB)`);
  };
  log(
    `Packaged ${cfg.id} v${version} for game v${cfg.game}: ` +
      `${diff.stats.added} added, ${diff.stats.replaced} replaced, ` +
      `${diff.stats.copied} referenced from the game, ${diff.stats.unchanged} left out`,
  );
  write(`${cfg.id}-${version}.tcoaalmod`, pkg);

  if (installers.length && oses.length) {
    const stubs = await fetchJsonOrNull(site + "/stub/stubs.json");
    if (!stubs) fail(`The installer stubs are not published at ${site}/stub/stubs.json.`);
    const payloadFor = {
      offline: pkg,
      online:
        installers.indexOf("online") !== -1
          ? await P.build(
              Object.assign({}, meta, {
                variants: [],
                payloads: new Map(),
                online: { github },
              }),
            )
          : null,
    };
    for (const os of oses) {
      const entry = stubs[OS_STUBS[os]];
      if (!entry) fail(`No ${os} installer stub is published.`);
      // A stub reads one package format (see fetchStub in create.html).
      if (entry.format !== P.FORMAT) {
        fail(
          `The published ${os} installer reads ${entry.format || "an older format"}, ` +
            `but this build writes ${P.FORMAT}.`,
        );
      }
      const stub = await fetchBytes(stubUrl(site, entry), `the ${os} installer stub`);
      await L.StubStamp.verifyStub(stub, entry.sha256, entry.file);
      for (const kind of installers) {
        const bytes = await stamp(L, os, stub, payloadFor[kind], meta, iconPng);
        write(`${cfg.id}-${version}-${kind}-${os}${OS_SUFFIX[os]}`, bytes);
      }
    }
  }
  return { out, files: written, stats: diff.stats, indexed: !!index };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.version) {
    console.log(
      "Usage: node tools/build-mod.js --version 1.2.3 [--repo .] [--out dist]\n" +
        "         [--installers offline,online] [--os windows,macos,linux]\n" +
        "         [--github owner/repo] [--site https://tcoaal.app]",
    );
    process.exit(a.help ? 0 : 2);
  }
  await build({
    repo: a.repo,
    out: a.out,
    version: a.version,
    site: a.site,
    github: a.github,
    installers: a.installers === "none" ? [] : listArg(a.installers, ["offline", "online"], "installer"),
    os: a.os === "none" ? [] : listArg(a.os, ["windows", "macos", "linux"], "system"),
  });
}

module.exports = { build, readConfig, diffAgainstIndex, isSafeRelPath, BuildError };

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof BuildError ? "error: " + e.message : e);
    process.exit(1);
  });
}

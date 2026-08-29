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
 * Apply a `tcoaal-mod/3` package (the format app/create.html builds) onto a
 * player's game folder, and roll it back.
 *
 *   node tools/mod-apply.js --info     <mod.tcoaalmod>
 *   node tools/mod-apply.js --apply    <mod.tcoaalmod> --base <GameFolder>
 *   node tools/mod-apply.js --apply    <mod.tcoaalmod> --base <GameFolder> --out <dir>
 *   node tools/mod-apply.js --rollback <GameFolder>
 *
 * This is the tool tools/desktop/user (the TCOAAL Mod Installer, and the stub
 * create.html stamps a mod into) shells out to. It is deliberately NOT
 * share-project.js: that one works in *project space*, so applying a mod means
 * extracting an editable project out of the player's game first
 * (extract-project.js), which is the part of the toolchain this repo does not
 * ship. `tcoaal-mod/3` is a diff over SHIPPED paths, hashed and encrypted
 * exactly as the game stores them, so applying it needs nothing but the codec
 * the service worker already carries:
 *
 *   delete   -> unlink www/<rel>
 *   verbatim -> write the payload, re-encrypted with fileMask(<rel>) when the
 *               entry it replaces was encrypted
 *   patch    -> dekit the player's own file, apply the RFC 6902 ops, re-encrypt
 *
 * Nothing is repacked and no unmodified file is ever rewritten, so a file the
 * mod does not mention keeps its original bytes (including everything under
 * www/save/).
 *
 * In place (--out omitted, or --out equal to --base) every file this overwrites
 * or removes is first copied into `.tcoaalmod-rollback.zip` at the game root -
 * the same `tcoaal-rollback/1` archive share-project.js writes, so either tool
 * can undo the other's install.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROLLBACK_NAME = ".tcoaalmod-rollback.zip";
const FORMAT = "tcoaal-mod/3";

// Browser libraries, loaded into one shared vm context
//
// These are the SAME files app/create.html uses to build the package (they ship
// as bundled app resources next to this script, and live in app/js/libs/ in the
// repo). Loading them instead of porting them is what guarantees the applier
// and the builder cannot drift apart: enkit here is byte-for-byte the enkit the
// modder's diff was computed against.

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
const D = LIBS.ModDiff;

// Small helpers

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function say(msg) {
  process.stdout.write(msg + "\n");
}

function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

/** Where the game's shipped tree is, given whatever folder the user picked. */
function resolveWww(input) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) fail(`Folder not found: ${input}`);
  if (fs.existsSync(path.join(abs, "www", "data")))
    return path.join(abs, "www");
  if (fs.existsSync(path.join(abs, "data"))) return abs;
  fail(`No game found in ${input} (expected a www/data or data folder).`);
}

/** Where the rollback file lives: the game root (parent of www/ when present). */
function gameRootOf(www) {
  const abs = path.resolve(www);
  return path.basename(abs) === "www" ? path.dirname(abs) : abs;
}

/*
 * A .tcoaalmod is untrusted input a player downloaded from the internet, and
 * every `rel` in it becomes a path we write to. Anything that could escape the
 * game's www/ (a parent segment, an absolute path, a Windows drive or UNC
 * prefix, a backslash separator smuggling one of those past a "/" split) is
 * refused outright rather than normalized, because there is no legitimate mod
 * that needs any of them.
 */
function safeRel(rel) {
  if (typeof rel !== "string" || !rel) return false;
  if (rel.indexOf("\\") !== -1) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split("/").some((p) => p === "" || p === "." || p === "..");
}

function walkFiles(dir, base, out) {
  out = out || [];
  base = base || "";
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    const st = fs.lstatSync(full);
    if (st.isDirectory()) walkFiles(full, rel, out);
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

function writeFileEnsured(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

/** A ModDiff source (list/read) over a directory of shipped files. */
function dirSource(www) {
  let cache = null;
  return {
    list: async function () {
      if (!cache) cache = walkFiles(www).sort();
      return cache;
    },
    read: async function (rel) {
      return new Uint8Array(fs.readFileSync(path.join(www, rel)));
    },
  };
}

// Variant selection
//
// Variants are keyed by a fingerprint of the whole base tree (file count, a
// SHA-256 over every path + content hash, and System.json's versionId). The
// digest is authoritative but costs a full read of the game, so it is only
// computed when the cheap signals leave more than one candidate.

const STD_SYSTEM = "data/be1a37535e921f91"; // hashPath("data/System.json")

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

function labelOf(v) {
  return (
    (v.base && (v.base.label || (v.base.steam && v.base.steam.name))) ||
    "unnamed build"
  );
}

async function selectVariant(manifest, www, opts) {
  const variants = manifest.variants;
  if (variants.length === 1 && !opts.strict) return variants[0];

  const version = baseVersionOf(www);
  const fileCount = walkFiles(www).length;
  const cheap = variants.filter((v) => {
    const fp = (v.base && v.base.fingerprint) || {};
    if (version && fp.version) return String(fp.version) === version;
    return fp.files === fileCount;
  });

  if (cheap.length === 1 && !opts.strict) return cheap[0];

  const pool = cheap.length ? cheap : variants;
  say("Checking which supported version this game is...");
  const fp = await D.fingerprint(dirSource(www));
  const exact = pool.find(
    (v) =>
      v.base && v.base.fingerprint && v.base.fingerprint.digest === fp.digest,
  );
  if (exact) return exact;

  if (opts.force) {
    say(
      `No variant matches this game exactly; --force was given, using "${labelOf(pool[0])}".`,
    );
    return pool[0];
  }
  fail(
    `This mod does not support your version of the game.\n` +
      `It supports: ${variants.map(labelOf).join(", ")}.\n` +
      `Download a supported version (Steam versions tab), or pass --force to ` +
      `install onto this one anyway.`,
  );
}

// info

async function info(modFile) {
  const { manifest } = await readPackage(modFile);
  return {
    format: manifest.format,
    id: manifest.id || "",
    name: manifest.name || "",
    author: manifest.author || "",
    version: manifest.version || "",
    description: manifest.description || "",
    created: manifest.created || "",
    saves: manifest.saves || "isolated",
    variants: (manifest.variants || []).map((v) => {
      const fp = (v.base && v.base.fingerprint) || {};
      return {
        label: labelOf(v),
        hash: fp.digest || "",
        fileCount: fp.files || 0,
        steam: (v.base && v.base.steam) || null,
      };
    }),
  };
}

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
          `Install it with the mod creator's share-project.js instead.`,
      );
    }
    fail(msg);
  }
  const m = parsed.manifest;
  if (!Array.isArray(m.variants) || !m.variants.length) {
    fail("Invalid mod file: no base variants.");
  }
  return parsed;
}

// apply

async function apply(opts) {
  const baseWww = resolveWww(opts.base);
  const inPlace =
    !opts.out ||
    path.resolve(opts.out) === path.resolve(opts.base) ||
    path.resolve(opts.out) === path.resolve(baseWww);
  const root = gameRootOf(baseWww);
  const rbPath = path.join(root, ROLLBACK_NAME);

  if (inPlace && fs.existsSync(rbPath)) {
    fail(
      `A mod is already installed here (found ${ROLLBACK_NAME}).\n` +
        `Uninstall it first:\n  node tools/mod-apply.js --rollback ${opts.base}`,
    );
  }

  const { manifest, entries } = await readPackage(opts.modFile);
  say(
    `Installing "${manifest.name}"${manifest.author ? " by " + manifest.author : ""}` +
      ` v${manifest.version || "?"}`,
  );

  const variant = await selectVariant(manifest, baseWww, opts);
  say(`Base version: ${labelOf(variant)}`);

  // Out of place: work on a full copy and leave the player's game untouched.
  let targetWww = baseWww;
  if (!inPlace) {
    targetWww = path.resolve(opts.out);
    if (fs.existsSync(targetWww)) {
      if (!opts.force) fail(`Output exists: ${opts.out} (pass --force).`);
      fs.rmSync(targetWww, { recursive: true, force: true });
    }
    say("Copying the base game...");
    fs.cpSync(baseWww, targetWww, { recursive: true });
  }

  const files = variant.files || [];
  const backup = []; // zip entries holding the pre-install bytes
  const overwritten = [];
  const deleted = [];
  const created = [];
  let bi = 0;

  const backupLive = (rel, list) => {
    if (!inPlace) return true; // nothing to undo: the base was never touched
    const live = path.join(targetWww, rel);
    if (!fs.existsSync(live)) return false;
    const name = "b/" + bi++;
    backup.push({ name: name, data: new Uint8Array(fs.readFileSync(live)) });
    list.push({ rel: rel, payload: name });
    return true;
  };

  let written = 0;
  for (const f of files) {
    if (!safeRel(f.rel)) fail(`Refusing an unsafe path in the mod: ${f.rel}`);
    const abs = path.join(targetWww, f.rel);

    if (f.type === "delete") {
      if (backupLive(f.rel, deleted) && fs.existsSync(abs)) fs.unlinkSync(abs);
      continue;
    }

    let plain;
    if (f.type === "verbatim") {
      plain = entries.get(f.payload);
      if (!plain)
        fail(
          `Mod file is incomplete: missing payload ${f.payload} for ${f.rel}.`,
        );
    } else if (f.type === "patch") {
      if (!fs.existsSync(abs)) {
        fail(
          `Cannot patch ${f.rel}: it is missing from your game. ` +
            `Your copy does not match the version this mod was built for.`,
        );
      }
      const live = new Uint8Array(fs.readFileSync(abs));
      const doc = JSON.parse(new TextDecoder().decode(C.dekit(live, f.rel)));
      plain = new TextEncoder().encode(
        JSON.stringify(J.apply(doc, f.ops || [])),
      );
    } else {
      fail(`Unknown entry type "${f.type}" for ${f.rel}.`);
    }

    const out = f.enc ? C.enkit(plain, f.rel, f.key || 0) : plain;
    if (!backupLive(f.rel, overwritten)) created.push(f.rel);
    writeFileEnsured(abs, out);
    written++;
  }

  if (!inPlace) {
    say(`\nDone. Wrote a complete modded game to: ${targetWww}`);
    say(
      "Import that folder in the BrowserPlayer loader, or run it with your game runtime.",
    );
    return;
  }

  const rollback = {
    format: "tcoaal-rollback/1",
    mod: { name: manifest.name, version: manifest.version },
    appliedAt: new Date().toISOString(),
    created: created,
    overwritten: overwritten,
    deleted: deleted,
  };
  const zipBytes = await P.writeZip([
    {
      name: "rollback.json",
      data: new TextEncoder().encode(JSON.stringify(rollback, null, 2)),
    },
    ...backup,
  ]);
  fs.writeFileSync(rbPath, zipBytes);

  say(
    `  wrote ${written} file(s): ${overwritten.length} changed, ` +
      `${created.length} new, ${deleted.length} removed.`,
  );
  say(`  undo archive: ${ROLLBACK_NAME} (${human(zipBytes.length)})`);
  say(`\nDone. "${manifest.name}" is installed in: ${baseWww}`);
  say("Launch the game the usual way (e.g. through Steam).");
}

// rollback

async function rollback(target) {
  const baseWww = resolveWww(target);
  const root = gameRootOf(baseWww);
  const rbPath = path.join(root, ROLLBACK_NAME);
  if (!fs.existsSync(rbPath)) {
    fail(`No mod to uninstall (no ${ROLLBACK_NAME} in ${root}).`);
  }
  const zip = await P.readZip(new Uint8Array(fs.readFileSync(rbPath)));
  const metaRaw = zip.get("rollback.json");
  if (!metaRaw) fail(`${ROLLBACK_NAME} is corrupt (no rollback.json).`);
  const meta = JSON.parse(new TextDecoder().decode(metaRaw));
  say(`Uninstalling "${meta.mod.name}" v${meta.mod.version} from ${baseWww}`);

  // Restore first, delete second: if anything below throws, the archive is
  // still on disk and the whole thing can be re-run.
  for (const e of [...(meta.overwritten || []), ...(meta.deleted || [])]) {
    if (!safeRel(e.rel))
      fail(`Refusing an unsafe path in the undo archive: ${e.rel}`);
    const data = zip.get(e.payload);
    if (!data)
      fail(`${ROLLBACK_NAME} is missing payload ${e.payload} for ${e.rel}.`);
    writeFileEnsured(path.join(baseWww, e.rel), data);
  }
  for (const rel of meta.created || []) {
    if (!safeRel(rel))
      fail(`Refusing an unsafe path in the undo archive: ${rel}`);
    const abs = path.join(baseWww, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  fs.unlinkSync(rbPath);

  say(
    `Restored ${(meta.overwritten || []).length} changed and ` +
      `${(meta.deleted || []).length} removed file(s), deleted ` +
      `${(meta.created || []).length} added file(s).`,
  );
  say("The game is back to its pre-mod state.");
}

// CLI

function printHelp() {
  say(
    "Apply or undo a .tcoaalmod (tcoaal-mod/3) on a game folder.\n\n" +
      "  node tools/mod-apply.js --info <mod.tcoaalmod>\n" +
      "  node tools/mod-apply.js --apply <mod.tcoaalmod> --base <GameFolder>\n" +
      "  node tools/mod-apply.js --apply <mod.tcoaalmod> --base <GameFolder> --out modded-www\n" +
      "  node tools/mod-apply.js --rollback <GameFolder>\n\n" +
      "  --force   install even when no variant matches the game exactly\n" +
      "  --strict  never fall back to a single variant without a digest match\n",
  );
}

function parseArgs(argv) {
  const opts = { mode: "help", force: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      opts.mode = "apply";
      opts.modFile = argv[++i];
    } else if (a === "--info") {
      opts.mode = "info";
      opts.modFile = argv[++i];
    } else if (a === "--rollback") {
      opts.mode = "rollback";
      opts.target = argv[++i];
    } else if (a === "--base") {
      opts.base = argv[++i];
    } else if (a === "--out") {
      opts.out = argv[++i];
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--strict") {
      opts.strict = true;
    } else if (a === "-h" || a === "--help") {
      opts.mode = "help";
    } else {
      fail(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "apply") {
    if (!opts.modFile) fail("--apply requires a <mod.tcoaalmod>.");
    if (!opts.base) fail("--apply requires --base <GameFolder>.");
    await apply(opts);
  } else if (opts.mode === "info") {
    if (!opts.modFile) fail("--info requires a <mod.tcoaalmod>.");
    process.stdout.write(JSON.stringify(await info(opts.modFile)) + "\n");
  } else if (opts.mode === "rollback") {
    if (!opts.target) fail("--rollback requires a <GameFolder>.");
    await rollback(opts.target);
  } else {
    printHelp();
  }
}

if (require.main === module) {
  main().catch((e) => fail(String((e && e.stack) || e)));
}

module.exports = { apply, rollback, info, parseArgs, FORMAT, ROLLBACK_NAME };

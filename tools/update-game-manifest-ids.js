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
 * update-game-manifest-ids.js: maintain tools/tcoaal-versions.json, the catalog
 * the loader's "Download game" tab uses to map a game version to its depot
 * manifest id (which Steam's public API does not expose).
 *
 * The intended workflow: run this locally, commit the updated JSON, and every
 * app pulls it from the repo's latest commit (raw.githubusercontent.com) for
 * free, so one commit benefits everyone.
 *
 * Sources it merges into the catalog (all optional, additive):
 *   - --add ... one entry typed by hand, e.g. a manifest you read off
 *                         https://steamdb.info/app/2378900/patchnotes/<code>/
 *                         (the only place historical manifest ids are published)
 *   - a local downloaded-versions archive (the tcoaal-mods store): each version
 *     is saved with a steam.json (name/version/manifest), harvested here
 *   - your local Steam install: the currently installed depot manifest
 *
 * Existing entries are preserved and de-duplicated by manifest id; empty
 * placeholder entries are filled in when a matching manifest is found.
 *
 *   node tools/update-game-manifest-ids.js                       # harvest local sources + write
 *   node tools/update-game-manifest-ids.js --add --manifest 7415012965776985886 \
 *        --name "Cry about it! update" --version 3.0.0 --date 2025-XX-XX --patchnote 17942031
 *   node tools/update-game-manifest-ids.js --print               # show result, do not write
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const APPID = "2378900";
const DEPOT = "2378901";
const OUT_DEFAULT = path.join(__dirname, "tcoaal-versions.json");
const REMOTE_URL =
  "https://raw.githubusercontent.com/Kidev-org/TCOAALBrowserLoader/main/tools/tcoaal-versions.json";

function today() {
  return new Date().toISOString().slice(0, 10);
}

// argument parsing

function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    print: false,
    fromArchive: true,
    fromSteam: true,
    steamDir: null,
    archiveDir: null,
    add: null,
    remote: false,
    seed: null,
  };
  let addMode = false;
  const add = {
    major: null,
    label: null,
    name: null,
    version: null,
    date: null,
    patchnote: null,
    manifest: null,
    buildid: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--add") {
      addMode = true;
    } else if (a === "--out" || a === "-o") opts.out = argv[++i];
    else if (a === "--print") opts.print = true;
    else if (a === "--no-archive") opts.fromArchive = false;
    else if (a === "--no-steam") opts.fromSteam = false;
    else if (a === "--remote") opts.remote = true;
    else if (a === "--seed") opts.seed = argv[++i];
    else if (a === "--steam") opts.steamDir = argv[++i];
    else if (a === "--archive") opts.archiveDir = argv[++i];
    else if (a === "--major") add.major = argv[++i];
    else if (a === "--label") add.label = argv[++i];
    else if (a === "--name") add.name = argv[++i];
    else if (a === "--version") add.version = argv[++i];
    else if (a === "--date") add.date = argv[++i];
    else if (a === "--patchnote") add.patchnote = argv[++i];
    else if (a === "--manifest") add.manifest = argv[++i];
    else if (a === "--buildid") add.buildid = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (addMode) {
    if (!add.manifest) {
      console.error("--add requires --manifest <id>.");
      process.exit(1);
    }
    opts.add = add;
  }
  return opts;
}

function printHelp() {
  console.log(
    "Maintain tools/tcoaal-versions.json (the loader's Download-game version catalog).\n\n" +
      "Usage:\n" +
      "  node tools/update-game-manifest-ids.js [options]\n\n" +
      "Add one entry by hand (manifest read from steamdb.info):\n" +
      "  --add --manifest <id> [--name <s>] [--version <s>] [--major <x.x>]\n" +
      "        [--label <s>] [--date <YYYY-MM-DD>] [--patchnote <code>] [--buildid <n>]\n\n" +
      "Sources (on by default, additive):\n" +
      "  --remote            pull the maintained catalog from GitHub and merge it\n" +
      "                      in (best-effort: a failed fetch warns and falls back\n" +
      "                      to the seed/local catalog so an offline run still works)\n" +
      "  --seed <file>       base catalog to start from (e.g. the app-bundled copy)\n" +
      "                      used as the offline fallback when --remote can't connect\n" +
      "  --no-archive        do not harvest the local downloaded-versions archive\n" +
      "  --no-steam          do not read the locally installed Steam manifest\n" +
      "  --steam <dir>       Steam root override\n" +
      "  --archive <dir>     archived-versions dir override (tcoaal-mods/versions)\n\n" +
      "Output:\n" +
      "  -o, --out <file>    output file (default tools/tcoaal-versions.json)\n" +
      "  --print             print the merged catalog, do not write\n\n" +
      "Commit the result; apps pull it from " +
      REMOTE_URL,
  );
}

// platform paths (mirror the Rust core)

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function sharedDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || homeDir(), "tcoaal-mods");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", "tcoaal-mods");
  }
  const base = process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share");
  return path.join(base, "tcoaal-mods");
}

function steamRootCandidates() {
  const out = [];
  if (process.platform === "win32") {
    for (const v of ["ProgramFiles(x86)", "ProgramFiles"]) {
      if (process.env[v]) out.push(path.join(process.env[v], "Steam"));
    }
    out.push("C:\\Program Files (x86)\\Steam");
  } else if (process.platform === "darwin") {
    out.push(path.join(homeDir(), "Library", "Application Support", "Steam"));
  } else {
    const h = homeDir();
    out.push(path.join(h, ".steam", "steam"));
    out.push(path.join(h, ".steam", "root"));
    out.push(path.join(h, ".local", "share", "Steam"));
    out.push(path.join(h, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"));
    out.push(path.join(h, "snap", "steam", "common", ".local", "share", "Steam"));
  }
  return out;
}

// harvest sources

/** Read every archived version's metadata from the local tcoaal-mods store. */
function harvestArchive(archiveDir) {
  const root = archiveDir || sharedDataDir();
  const out = [];
  const indexPath = path.join(root, "versions.json");
  if (fs.existsSync(indexPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      for (const v of Object.values(idx)) {
        if (v && v.manifest) {
          out.push({
            name: v.name || "",
            version: v.version || "",
            manifest: String(v.manifest),
            buildid: v.buildid || "",
            date: v.date || "",
          });
        }
      }
    } catch (e) {}
  }
  // Also scan per-version steam.json in case the index is stale.
  const vroot = path.join(root, "versions");
  if (fs.existsSync(vroot)) {
    for (const d of fs.readdirSync(vroot)) {
      const sj = path.join(vroot, d, "steam.json");
      if (!fs.existsSync(sj)) continue;
      try {
        const v = JSON.parse(fs.readFileSync(sj, "utf8"));
        if (v && v.manifest) {
          out.push({
            name: v.name || "",
            version: v.version || "",
            manifest: String(v.manifest),
            buildid: v.buildid || "",
            date: v.date || "",
          });
        }
      } catch (e) {}
    }
  }
  return out;
}

/** Read the latest *available* public depot manifest from the Steam client's
 *  binary appinfo cache (same data as `app_info_print <appid>`). Best-effort;
 *  returns null on any parse trouble. Mirrors the Rust core's parser. */
function readPublicManifest(steamRoot) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(steamRoot, "appcache", "appinfo.vdf"));
  } catch (e) {
    return null;
  }
  const len = buf.length;
  let p = 0;
  const u8 = () => {
    if (p + 1 > len) throw 0;
    return buf[p++];
  };
  const u16 = () => {
    if (p + 2 > len) throw 0;
    const v = buf.readUInt16LE(p);
    p += 2;
    return v;
  };
  const u32 = () => {
    if (p + 4 > len) throw 0;
    const v = buf.readUInt32LE(p);
    p += 4;
    return v;
  };
  const u64 = () => {
    if (p + 8 > len) throw 0;
    const v = buf.readBigUInt64LE(p);
    p += 8;
    return v;
  };
  const skip = (n) => {
    if (p + n > len) throw 0;
    p += n;
  };
  const cstr = () => {
    const s = p;
    while (p < len && buf[p] !== 0) p++;
    if (p >= len) throw 0;
    const out = buf.toString("utf8", s, p);
    p++;
    return out;
  };
  try {
    const magic = u32();
    const hasStr = (magic & 0xff) >= 0x29;
    u32(); // universe
    let strtab = null;
    if (hasStr) {
      const off = Number(u64());
      const saved = p;
      p = off;
      const count = u32();
      strtab = new Array(count);
      for (let i = 0; i < count; i++) strtab[i] = cstr();
      p = saved;
    }
    const readKey = () => (strtab ? strtab[u32()] : cstr());
    const parseKv = () => {
      const map = {};
      for (;;) {
        const t = u8();
        if (t === 0x08 || t === 0x0b) break;
        const key = readKey();
        if (t === 0x00) map[key] = parseKv();
        else if (t === 0x01) map[key] = cstr();
        else if (t === 0x02 || t === 0x03 || t === 0x04 || t === 0x06) {
          const v = u32();
          if (t === 0x02) map[key] = String(v);
        } else if (t === 0x07 || t === 0x0a) map[key] = u64().toString();
        else if (t === 0x05) {
          for (;;) if (u16() === 0) break;
        } else throw 0;
      }
      return map;
    };
    const target = parseInt(APPID, 10);
    for (;;) {
      const appid = u32();
      if (appid === 0) return null;
      const size = u32();
      const end = p + size;
      if (appid === target) {
        skip(4);
        skip(4);
        skip(8);
        skip(20);
        skip(4);
        if (hasStr) skip(20);
        const root = parseKv();
        const depots = root.depots;
        if (!depots) return null;
        const depot = depots[DEPOT];
        const gid =
          depot && depot.manifests && depot.manifests.public && depot.manifests.public.gid;
        const buildid =
          depots.branches && depots.branches.public && depots.branches.public.buildid;
        if (gid) return { manifest: String(gid), buildid: buildid ? String(buildid) : "" };
        return null;
      }
      p = end;
      if (p > len) return null;
    }
  } catch (e) {
    return null;
  }
}

/** Harvest local Steam: the installed depot manifest (from appmanifest) and the
 *  latest available manifest (from the appinfo cache). De-dup happens in merge. */
function harvestSteam(steamDir) {
  const roots = steamDir ? [steamDir] : steamRootCandidates();
  const root = roots.find(
    (r) =>
      fs.existsSync(path.join(r, "steamapps")) ||
      fs.existsSync(path.join(r, "appcache")),
  );
  if (!root) return [];
  const out = [];

  // Installed version (the game may live in a secondary library).
  const libs = [root];
  const lf = path.join(root, "steamapps", "libraryfolders.vdf");
  if (fs.existsSync(lf)) {
    const text = fs.readFileSync(lf, "utf8");
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text))) {
      const dir = m[1].replace(/\\\\/g, "\\");
      if (!libs.includes(dir)) libs.push(dir);
    }
  }
  for (const lib of libs) {
    const acf = path.join(lib, "steamapps", `appmanifest_${APPID}.acf`);
    if (!fs.existsSync(acf)) continue;
    const text = fs.readFileSync(acf, "utf8");
    const buildid = (text.match(/"buildid"\s*"(\d+)"/) || [])[1] || "";
    const di = text.indexOf(`"${DEPOT}"`);
    if (di < 0) continue;
    const manifest = (text.slice(di).match(/"manifest"\s*"(\d+)"/) || [])[1];
    if (manifest) {
      out.push({
        name: buildid ? "Build " + buildid : "Currently installed",
        version: "",
        manifest: String(manifest),
        buildid,
        date: "",
      });
      break;
    }
  }

  // Latest available version (regardless of what is installed).
  const pub = readPublicManifest(root);
  if (pub && pub.manifest) {
    out.push({
      name: pub.buildid ? "Build " + pub.buildid : "Latest available",
      version: "",
      manifest: pub.manifest,
      buildid: pub.buildid,
      date: "",
    });
  }
  return out;
}

// merge

function loadCatalog(file) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {}
  }
  return {
    _comment:
      "Generated by tools/update-game-manifest-ids.js. Apps pull this from " +
      REMOTE_URL +
      " . Historical depot manifest ids are not in Steam's public API; read them from https://steamdb.info/patchnotes/<code>/ and add with --add.",
    appid: APPID,
    depot: DEPOT,
    updated: "",
    source: "https://steamdb.info/app/2378900/patchnotes/",
    majors: [],
  };
}

/** GET a URL and JSON.parse the body. Follows a single redirect. Rejects on any
 *  network/HTTP/JSON error. Used by --remote to pull the maintained catalog. */
function fetchRemote(url, _redirects) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "tcoaal-versions-tool", Accept: "application/json" } },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if ((_redirects || 0) >= 3) return reject(new Error("too many redirects"));
          return resolve(fetchRemote(res.headers.location, (_redirects || 0) + 1));
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error("HTTP " + code));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("invalid JSON from remote: " + e.message));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("request timed out")));
  });
}

function inferMajor(version, name) {
  const v = String(version || "").match(/^(\d+)\./);
  if (v) return v[1] + ".x";
  const n = String(name || "").match(/v?(\d+)\.\d/);
  if (n) return n[1] + ".x";
  return "other";
}

/** Flatten the catalog's majors into a single list with the major attached. */
function flatten(catalog) {
  const entries = [];
  const labels = {};
  for (const mj of catalog.majors || []) {
    if (mj.label) labels[mj.major] = mj.label;
    for (const v of mj.versions || []) {
      entries.push({
        major: mj.major,
        name: v.name || "",
        version: v.version || "",
        date: v.date || "",
        patchnote: v.patchnote || "",
        manifest: v.manifest || "",
        buildid: v.buildid || "",
      });
    }
  }
  return { entries, labels };
}

function sameEntry(a, b) {
  if (a.manifest && b.manifest) return a.manifest === b.manifest;
  // No manifest on one side: match within the same major by version or name.
  if (a.major !== b.major) return false;
  if (a.version && b.version) return a.version === b.version;
  return !!a.name && a.name === b.name;
}

function mergeEntry(dst, src, weak) {
  // Fill in fields from `src`. A `weak` source (harvested from Steam) only fills
  // empty fields, so it never clobbers curated catalog values (e.g. a real
  // version name with a generated "Build NNN"); an authoritative source
  // (`--add`) overwrites with any non-empty value.
  for (const k of ["name", "version", "date", "patchnote", "manifest", "buildid"]) {
    if (!src[k]) continue;
    if (weak && dst[k]) continue;
    dst[k] = src[k];
  }
}

function upsert(entries, incoming, weak) {
  const found = entries.find((e) => sameEntry(e, incoming));
  if (found) {
    mergeEntry(found, incoming, weak);
    return false;
  }
  entries.push({
    major: incoming.major,
    name: incoming.name || "",
    version: incoming.version || "",
    date: incoming.date || "",
    patchnote: incoming.patchnote || "",
    manifest: incoming.manifest || "",
    buildid: incoming.buildid || "",
  });
  return true;
}

function majorSortKey(major) {
  const m = String(major).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function versionSortKey(v) {
  return String(v.version || "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function cmpVersionDesc(a, b) {
  const ka = versionSortKey(a);
  const kb = versionSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] || 0) - (ka[i] || 0);
    if (d) return d;
  }
  // Then newest build id, then date desc, then name.
  const ba = Number(a.buildid) || 0;
  const bb = Number(b.buildid) || 0;
  if (ba !== bb) return bb - ba;
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return String(a.name).localeCompare(String(b.name));
}

function rebuild(catalog, entries, labels) {
  const byMajor = {};
  for (const e of entries) {
    (byMajor[e.major] = byMajor[e.major] || []).push(e);
  }
  const majors = Object.keys(byMajor)
    .sort((a, b) => majorSortKey(b) - majorSortKey(a))
    .map((mj) => ({
      major: mj,
      label: labels[mj] || "",
      versions: byMajor[mj].sort(cmpVersionDesc).map((e) => ({
        name: e.name,
        version: e.version,
        date: e.date,
        patchnote: e.patchnote,
        manifest: e.manifest,
        buildid: e.buildid || "",
      })),
    }));
  catalog.majors = majors;
  catalog.updated = today();
  return catalog;
}

// run

async function run(opts) {
  // Base catalog: --seed (the app-bundled copy) if given, else the output file.
  // It is both the starting point and the offline fallback for --remote.
  const catalog = loadCatalog(opts.seed || opts.out);
  const { entries, labels } = flatten(catalog);

  // Each incoming entry carries a `_weak` flag. Weak sources (GitHub catalog is
  // *not* weak: it is the curated source of truth; Steam/archive harvests *are*
  // weak) only fill empty fields and never clobber curated names/versions.
  const incoming = [];
  if (opts.add) {
    const a = opts.add;
    incoming.push({
      _weak: false,
      major: a.major || inferMajor(a.version, a.name),
      name: a.name || "",
      version: a.version || "",
      date: a.date || "",
      patchnote: a.patchnote || "",
      manifest: String(a.manifest),
      buildid: a.buildid || "",
    });
    if (a.label && a.major) labels[a.major] = a.label;
  }
  if (opts.remote) {
    try {
      const remote = await fetchRemote(REMOTE_URL);
      if (!remote || typeof remote !== "object" || !Array.isArray(remote.majors)) {
        throw new Error("remote catalog has no majors[]");
      }
      const rf = flatten(remote);
      Object.assign(labels, rf.labels);
      for (const v of rf.entries) incoming.push({ ...v, _weak: false });
    } catch (e) {
      // Best-effort: keep the seed/local catalog and tell the caller on stderr.
      console.error(
        "warning: could not pull the catalog from GitHub (" +
          e.message +
          "); used the bundled catalog + local sources instead.",
      );
    }
  }
  if (opts.fromArchive) {
    for (const v of harvestArchive(opts.archiveDir)) {
      incoming.push({ ...v, _weak: true, major: inferMajor(v.version, v.name), patchnote: "" });
    }
  }
  if (opts.fromSteam) {
    for (const v of harvestSteam(opts.steamDir)) {
      incoming.push({ ...v, _weak: true, major: inferMajor(v.version, v.name), patchnote: "" });
    }
  }

  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    if (upsert(entries, inc, inc._weak !== false)) added++;
    else updated++;
  }

  const result = rebuild(catalog, entries, labels);
  const json = JSON.stringify(result, null, 2) + "\n";

  if (opts.print) {
    process.stdout.write(json);
  } else {
    fs.writeFileSync(opts.out, json);
    const total = entries.length;
    const withManifest = entries.filter((e) => e.manifest).length;
    console.log(
      `Wrote ${opts.out}: ${total} versions (${withManifest} with a manifest), ` +
        `${added} added, ${updated} updated.`,
    );
    console.log(`Commit it; apps pull it from ${REMOTE_URL}`);
  }
  return result;
}

module.exports = { run, parseArgs, harvestArchive, harvestSteam, readPublicManifest };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e && e.message ? e.message : String(e));
    process.exit(1);
  });
}

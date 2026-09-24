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
 * generate-manifests.js
 *
 * Walks each mod directory under mods/ and writes the file lists directly
 * into mods.json (as "version" and "files" fields on each mod entry).
 *
 * - Mods in folders starting with '_' get type prefixed with "built-in"
 *   and author defaults to "kidev".
 * - Non-_ mods with a "repo" field get author and lastUpdate fetched from
 *   the GitHub API.
 * - A mod folder holding a .tcoaalmod and no www/ (mods/<id>/<name>.tcoaalmod)
 *   is a PACKAGED mod: its entry names the file as `package` instead of
 *   listing files, takes its name, author, description and version from the
 *   package's own mod.json, and gets the package's icon extracted beside it
 *   as mods/<id>/icon.png. A new such folder is added to mods.json on its
 *   own, so publishing a third-party mod is dropping its .tcoaalmod into a
 *   folder and running this script.
 *
 * Usage: node tools/generate-manifests.js
 *        node tools/generate-manifests.js --package-icons <mods dir>
 *          (only extract packaged mods' icons into <mods dir>; no network,
 *          no mods.json. The deploy runs this over the copied site.)
 */

"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");
var https = require("https");
var vm = require("vm");

// Tools live in tools/; project root is one level up.
var ROOT = path.join(__dirname, "..");
var MODS_JSON = path.join(ROOT, "mods.json");
var MODS_DIR = path.join(ROOT, "mods");

var TRANSLATIONS_BASE = "https://translations.tcoaal.app/translations";
var TRANSLATIONS_MODS_URL = TRANSLATIONS_BASE + "/mods.txt";
var TRANSLATION_AUTHOR = "TCOAAL Translation Project";

// Remote-hosted overhaul mods. Mirrors the translations source: a flat
// listing file (mods.txt, one folder per line) discovers the published mod
// folders, each of which exposes its content under "<folder>/www/...". Unlike
// translations there is no per-folder manifest.json on the server, so the file
// list is enumerated from a local working copy under mods/<folder>/www (the
// extras content is not committed/deployed with this repo: see README).
var EXTRAS_BASE = "https://extras.tcoaal.app/mods";
var EXTRAS_MODS_URL = EXTRAS_BASE + "/mods.txt";

/** True when path is an absolute http(s) URL (remote-hosted mods). */
function isRemotePath(p) {
  return typeof p === "string" && /^https?:\/\//i.test(p);
}

function walkDir(dir, base) {
  var results = [];
  var entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return results;
  }
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(dir, entries[i]);
    var rel = path.join(base, entries[i]).replace(/\\/g, "/");
    var stat;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (stat.isDirectory()) {
      results = results.concat(walkDir(full, rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

/**
 * Detect the DRM / game-code delivery type for a mod.
 *
 * Returns one of:
 *   "zlib"    Original DRM: _() assembles base64 fragments, zlib-decompresses,
 *               injects as <script>. browser-shim.js intercepts inflateSync.
 *   "script"  Deobfuscated: _() loads a separate JS file (e.g. deobfuscated.js)
 *               via document.createElement('script').
 *   "direct"  Game code shipped as a regular plugin file (e.g. GameCode.js).
 *               Loaded by PluginManager like any other plugin.
 *   "none"    No DRM payload. Standard RPG Maker MV without custom game code
 *               layer. _() may be called but is undefined (no-op fallback).
 */
function detectDrmType(wwwDir) {
  var pluginsDir = path.join(wwwDir, "js", "plugins");
  var pluginsJs = path.join(wwwDir, "js", "plugins.js");

  // Check if GameCode.js exists as a registered plugin
  if (fs.existsSync(path.join(pluginsDir, "GameCode.js"))) {
    try {
      var pjs = fs.readFileSync(pluginsJs, "utf8");
      if (/["']GameCode["']/.test(pjs)) return "direct";
    } catch (e) {}
  }

  // Check if deobfuscated.js exists (loaded by _() via script tag)
  if (fs.existsSync(path.join(pluginsDir, "deobfuscated.js"))) {
    return "script";
  }

  // Check for zlib DRM pattern: a plugin file containing the _() assembler
  // with base64/inflate patterns, or OrangeEventHitboxes.js with embedded
  // compressed payload (>30KB).
  var pluginFiles;
  try {
    pluginFiles = fs.readdirSync(pluginsDir);
  } catch (e) {
    return "none";
  }

  for (var i = 0; i < pluginFiles.length; i++) {
    var pf = pluginFiles[i];
    if (!pf.endsWith(".js")) continue;
    var pfPath = path.join(pluginsDir, pf);
    var stat;
    try {
      stat = fs.statSync(pfPath);
    } catch (e) {
      continue;
    }

    // Large OrangeEventHitboxes.js (>20KB) = embedded zlib DRM payload
    if (pf === "OrangeEventHitboxes.js" && stat.size > 20000) {
      return "zlib";
    }

    // Check YEP_RegionRestrictions.js for the base game DRM assembler
    if (pf === "YEP_RegionRestrictions.js" && stat.size > 20000) {
      try {
        var content = fs.readFileSync(pfPath, "utf8");
        if (
          content.indexOf("decompressFromBase64") >= 0 ||
          content.indexOf("inflateSync") >= 0
        ) {
          return "zlib";
        }
      } catch (e) {}
    }
  }

  return "none";
}

function getModVersion(modDir) {
  var pkgPath = path.join(modDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      var pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return pkg.version;
    } catch (e) {}
  }
  try {
    var ver = cp
      .execSync("git describe --tags --always 2>/dev/null", {
        cwd: modDir,
        encoding: "utf8",
      })
      .trim();
    if (ver) return ver;
  } catch (e) {}
  return "";
}

// Packaged mods (mods/<id>/<name>.tcoaalmod)

// ModPackage and ModInstall are the browser's own libraries, run in a vm the
// way tools/mod-loader.js runs them: the entry written here describes the
// package exactly as the page that installs it will read it.
var _pkgLibs = null;
function pkgLibs() {
  if (_pkgLibs) return _pkgLibs;
  var ctx = vm.createContext({
    self: {},
    crypto: globalThis.crypto || require("crypto").webcrypto,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    CompressionStream: CompressionStream,
    DecompressionStream: DecompressionStream,
    Response: Response,
    console: console,
  });
  [
    "app/js/libs/tcoaal-codec.js",
    "app/js/libs/json-diff.js",
    "app/js/libs/mod-package.js",
    "app/js/libs/mod-install.js",
  ].forEach(function (rel) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx);
  });
  _pkgLibs = ctx.self;
  return _pkgLibs;
}

/** The one .tcoaalmod directly in modDir, or null (none, or ambiguous). */
function findPackageFile(modDir) {
  var names;
  try {
    names = fs.readdirSync(modDir);
  } catch (e) {
    return null;
  }
  var pkgs = names.filter(function (n) {
    return /\.tcoaalmod$/i.test(n) && fs.statSync(path.join(modDir, n)).isFile();
  });
  if (pkgs.length > 1) {
    console.warn(
      "[package] " + modDir + ": more than one .tcoaalmod (" + pkgs.join(", ") +
        "); keep exactly one",
    );
    return null;
  }
  return pkgs.length ? pkgs[0] : null;
}

/**
 * Read a package's manifest, icon and landing paths without inflating its
 * payload. Resolves to {manifest, icon, rels} or throws.
 */
async function readPackageInfo(file) {
  var L = pkgLibs();
  var pkg = await L.ModPackage.open(new Uint8Array(fs.readFileSync(file)));
  var m = pkg.manifest;
  if (m.online) throw new Error("it is an online placeholder, not the mod itself");
  if (!Array.isArray(m.variants) || !m.variants.length) {
    throw new Error("it has no base variants");
  }
  var icon = m.icon && pkg.zip.has(m.icon) ? await pkg.zip.read(m.icon) : null;
  var seen = {};
  var rels = [];
  m.variants.forEach(function (v) {
    (v.files || []).forEach(function (f) {
      if (f.type === "delete" || seen[f.rel]) return;
      seen[f.rel] = true;
      rels.push(f.rel);
    });
  });
  return { manifest: m, icon: icon, rels: rels };
}

/** Write the package's icon as <modDir>/icon.png when it differs. */
function writePackageIcon(modDir, icon) {
  if (!icon) return false;
  var out = path.join(modDir, "icon.png");
  var buf = Buffer.from(icon.buffer, icon.byteOffset, icon.byteLength);
  if (fs.existsSync(out) && fs.readFileSync(out).equals(buf)) return true;
  fs.writeFileSync(out, buf);
  return true;
}

/**
 * Fill a packaged mod's catalog entry. What the modder put in the package is
 * the source for everything the catalog shows about the mod, except fields a
 * maintainer already curated in mods.json (name, author, description,
 * langFile), which are kept.
 */
async function applyPackageEntry(modId, entry, modDir, pkgName) {
  var info = await readPackageInfo(path.join(modDir, pkgName));
  var m = info.manifest;
  var rel = path.relative(ROOT, modDir).split(path.sep).join("/");
  var today = new Date().toISOString().substring(0, 10);
  var version = String(m.version || "");

  if (!entry.name) entry.name = m.name || modId;
  if (!entry.author) entry.author = m.author || "";
  if (!entry.description) entry.description = m.description || "";
  entry.path = rel;
  entry.type = entry.type && !/plugin/i.test(entry.type) ? entry.type : "overhaul";
  entry.package = rel + "/" + pkgName;
  if (entry.version !== version) entry.lastUpdate = today;
  if (!entry.addedDate) entry.addedDate = today;
  entry.version = version;
  if (!entry.langFile) {
    var lang = pkgLibs().ModInstall.detectLangFile(info.rels);
    if (lang) entry.langFile = lang;
  }
  if (writePackageIcon(modDir, info.icon)) entry.icon = rel + "/icon.png";
  // A package installs from itself: a file list (or its hashes) left over
  // from a www/ layout would send the boot repair after files that are not
  // on the server.
  delete entry.files;
  delete entry.hashes;
  delete entry.drmType;
  return { files: info.rels.length, variants: m.variants.length };
}

/**
 * Folders under mods/ that hold a package but have no mods.json entry yet.
 * Built-in ("_") folders are the app's own plugins and never packages.
 */
function discoverPackagedMods(modsData) {
  var added = 0;
  var names;
  try {
    names = fs.readdirSync(MODS_DIR);
  } catch (e) {
    return 0;
  }
  var known = {};
  Object.keys(modsData).forEach(function (k) {
    var p = modsData[k] && modsData[k].path;
    known[k.toLowerCase()] = true;
    if (typeof p === "string") known[p.replace(/^mods\//, "").toLowerCase()] = true;
  });
  names.sort().forEach(function (name) {
    if (name.charAt(0) === "_" || name.charAt(0) === ".") return;
    var dir = path.join(MODS_DIR, name);
    if (!fs.statSync(dir).isDirectory() || known[name.toLowerCase()]) return;
    if (fs.existsSync(path.join(dir, "www"))) return;
    if (!findPackageFile(dir)) return;
    modsData[name] = { path: "mods/" + name, type: "overhaul" };
    console.log("[package] new mod folder: " + name);
    added++;
  });
  return added;
}

/** --package-icons <dir>: extract every packaged mod's icon under <dir>. */
async function extractPackageIcons(dir) {
  var n = 0;
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var modDir = path.join(dir, names[i]);
    if (!fs.statSync(modDir).isDirectory()) continue;
    var pkgName = findPackageFile(modDir);
    if (!pkgName) continue;
    try {
      var info = await readPackageInfo(path.join(modDir, pkgName));
      if (writePackageIcon(modDir, info.icon)) n++;
    } catch (e) {
      console.warn("[package] " + names[i] + ": " + e.message);
    }
  }
  console.log("[package] " + n + " icon(s) in " + dir);
}

/** Parse "https://github.com/owner/repo" -> { owner, repo } or null. */
function parseGithubUrl(url) {
  var m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

/** Fetch JSON from a GitHub API endpoint. */
function ghApiFetch(apiPath) {
  return new Promise(function (resolve) {
    var options = {
      hostname: "api.github.com",
      path: apiPath,
      headers: { "User-Agent": "TCOAAL-Mods" },
    };
    https
      .get(options, function (res) {
        var body = "";
        res.on("data", function (c) {
          body += c;
        });
        res.on("end", function () {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(null);
          }
        });
      })
      .on("error", function () {
        resolve(null);
      });
  });
}

/** Fetch a URL as text. Resolves to null on non-2xx or network error. */
function httpGetText(url) {
  return new Promise(function (resolve) {
    https
      .get(url, { headers: { "User-Agent": "TCOAAL-Mods" } }, function (res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        var body = "";
        res.setEncoding("utf8");
        res.on("data", function (c) {
          body += c;
        });
        res.on("end", function () {
          resolve(body);
        });
      })
      .on("error", function () {
        resolve(null);
      });
  });
}

/** HEAD request; resolves to the Last-Modified header as YYYY-MM-DD or null. */
function httpHeadLastModified(url) {
  return new Promise(function (resolve) {
    var u;
    try {
      u = new URL(url);
    } catch (_) {
      resolve(null);
      return;
    }
    var options = {
      method: "HEAD",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { "User-Agent": "TCOAAL-Mods" },
    };
    var req = https.request(options, function (res) {
      res.resume();
      var lm = res.headers["last-modified"];
      if (!lm) {
        resolve(null);
        return;
      }
      var d = new Date(lm);
      if (isNaN(d.getTime())) {
        resolve(null);
        return;
      }
      resolve(d.toISOString().substring(0, 10));
    });
    req.on("error", function () {
      resolve(null);
    });
    req.end();
  });
}

/** Title-case a language slug: "french" -> "French", "brazilian_pt" -> "Brazilian Pt". */
function titleCaseLang(slug) {
  return slug
    .split(/[_\s-]+/)
    .map(function (w) {
      return w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    })
    .join(" ");
}

/**
 * Fetch the two-level translations index and each language's manifest.json.
 *
 * Layout (since the BASE/TCOAAR/... split):
 *   translations/mods.txt                      -> "<MOD>_translations" dirs
 *   translations/<MOD>_translations/langs.txt  -> language dirs for that MOD
 *   translations/<MOD>_translations/<lang>/manifest.json + icon.png
 *
 * Each translation is keyed "translation_<MOD>_<lang>" and carries a "mod"
 * field (the MOD code: BASE, TCOAAR, ...) identifying the context it overlays.
 * MOD=BASE applies to the plain base game; any other MOD applies on top of the
 * overhaul mod whose mods.json key equals that MOD code. Existing entries for
 * other mod types are left untouched.
 */
async function syncTranslations(modsData) {
  console.log("[translations] Fetching " + TRANSLATIONS_MODS_URL);
  var modsTxt = await httpGetText(TRANSLATIONS_MODS_URL);
  if (!modsTxt) {
    console.warn("[translations] Failed to fetch mods.txt");
    return 0;
  }
  var modDirs = modsTxt
    .split(/\r?\n/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return /_translations$/.test(s) && !/^[._#]/.test(s);
    });

  if (modDirs.length === 0) {
    console.warn("[translations] mods.txt lists no <MOD>_translations dirs");
    return 0;
  }

  // Discover every (MOD, lang) pair first so we can prune in one pass.
  var pairs = []; // { mod, lang, dir, key, baseUrl }
  for (var d = 0; d < modDirs.length; d++) {
    var dir = modDirs[d];
    var mod = dir.replace(/_translations$/, "");
    var langsUrl = TRANSLATIONS_BASE + "/" + dir + "/langs.txt";
    console.log("[translations] " + mod + ": fetching " + langsUrl);
    var langsTxt = await httpGetText(langsUrl);
    if (!langsTxt) {
      console.warn("[translations] " + mod + ": langs.txt unreachable");
      continue;
    }
    var langs = langsTxt
      .split(/\r?\n/)
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length > 0 && !/^[._#]/.test(s);
      });
    for (var li = 0; li < langs.length; li++) {
      var lang = langs[li];
      pairs.push({
        mod: mod,
        lang: lang,
        dir: dir,
        key: "translation_" + mod + "_" + lang,
        baseUrl: TRANSLATIONS_BASE + "/" + dir + "/" + lang,
      });
    }
  }

  if (pairs.length === 0) {
    console.warn("[translations] no languages discovered");
    return 0;
  }

  // Prune stale translation entries that no longer appear in the listing.
  var wantKeys = {};
  for (var w = 0; w < pairs.length; w++) wantKeys[pairs[w].key] = true;
  var existingKeys = Object.keys(modsData);
  for (var k = 0; k < existingKeys.length; k++) {
    var ekey = existingKeys[k];
    var eentry = modsData[ekey];
    if (
      ekey.indexOf("translation_") === 0 &&
      eentry &&
      eentry.type === "translation" &&
      !wantKeys[ekey]
    ) {
      console.log("[translations] Removing stale entry: " + ekey);
      delete modsData[ekey];
    }
  }

  var count = 0;
  for (var j = 0; j < pairs.length; j++) {
    var p = pairs[j];
    var manifestUrl = p.baseUrl + "/manifest.json";

    console.log(
      "[translations] " + p.mod + "/" + p.lang + ": fetching manifest",
    );
    var manifestText = await httpGetText(manifestUrl);
    if (!manifestText) {
      console.warn("[translations] " + p.key + ": manifest.json unreachable");
      continue;
    }
    var manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      console.warn("[translations] " + p.key + ": invalid manifest.json");
      continue;
    }
    var files = Array.isArray(manifest.files) ? manifest.files.slice() : [];
    if (files.length === 0) {
      console.warn("[translations] " + p.key + ": manifest has no files");
      continue;
    }

    var lastUpdate = await httpHeadLastModified(manifestUrl);

    var existing = modsData[p.key] || {};
    var displayName = manifest.name || existing.name || titleCaseLang(p.lang);
    // Preserve a curated description already in mods.json (e.g. the endonym
    // "한국어" / "日本語") over whatever the remote manifest supplies: the
    // remote default is a generic "<Lang> translation" string that would
    // clobber hand-picked values on every regeneration.
    var description =
      existing.description ||
      manifest.description ||
      titleCaseLang(p.lang) + " translation";
    // The author seeds hand-curated in mods.json (per translator) win over the
    // remote manifest so a regeneration never clobbers them.
    var author = existing.author || manifest.author || TRANSLATION_AUTHOR;

    // Pick the dialogue source file actually shipped in the manifest. The
    // flat-root translators use dialogue.csv / dialogue.txt; the overhaul
    // translations (TCOAAR/TCOAAJ) instead ship a CLD .loc under
    // "languages/<lang>/dialogue.loc". lang-shim's extractModLangData parses
    // all of these. .loc/.csv/.txt are detected here; prefer this entry's own
    // language folder over a bundled english fallback.
    var langFile = null;
    if (files.indexOf("dialogue.csv") >= 0) langFile = "dialogue.csv";
    else if (files.indexOf("dialogue.txt") >= 0) langFile = "dialogue.txt";
    else {
      var preferredLoc = "languages/" + p.lang + "/dialogue.loc";
      if (files.indexOf(preferredLoc) >= 0) {
        langFile = preferredLoc;
      } else {
        var locs = files.filter(function (f) {
          return /^languages\/[^/]+\/dialogue\.(loc|pld)$/i.test(f);
        });
        var nonEng = locs.filter(function (f) {
          return !/\/english\//i.test(f);
        });
        langFile = nonEng[0] || locs[0] || null;
      }
    }
    if (!langFile) {
      console.warn(
        "[translations] " +
          p.key +
          ": no dialogue file in manifest; text will not translate",
      );
    }

    modsData[p.key] = {
      name: displayName,
      // Preserve the curated manual field at a stable position (right after
      // name). JSON.stringify omits it when undefined. Appending it at the end
      // instead would let a user's top-placed addedDate become a duplicate key
      // that JSON.parse silently drops on the next run.
      addedDate: existing.addedDate,
      icon: p.baseUrl + "/icon.png",
      author: author,
      lastUpdate: existing.lastUpdate || lastUpdate || "",
      path: p.baseUrl,
      type: "translation",
      mod: p.mod,
      description: description,
      langFile: langFile,
      version: manifest.version || existing.lastUpdate || lastUpdate || "",
      files: files,
    };

    console.log(
      "[translations] " +
        p.key +
        ": " +
        files.length +
        " files" +
        (lastUpdate ? " (" + lastUpdate + ")" : ""),
    );
    count++;
  }

  return count;
}

/**
 * Pick a representative icon path (relative to <folder>/www) for an overhaul
 * mod from its file list. Overhaul mods advertise themselves with a title
 * image; fall back to a conventional icon, then the first image present.
 */
function pickExtrasIconRel(files) {
  var titles = files.filter(function (f) {
    return /^img\/titles1\//i.test(f) && /\.(png|jpg|jpeg)$/i.test(f);
  });
  if (titles.length) return titles[0];
  if (files.indexOf("img/icon.png") >= 0) return "img/icon.png";
  var anyImg = files.filter(function (f) {
    return /^img\/.*\.(png|jpg|jpeg)$/i.test(f);
  });
  return anyImg.length ? anyImg[0] : "";
}

/** Detect an overhaul mod's dialogue source file from its file list, if any. */
function detectExtrasLangFile(files) {
  for (var i = 0; i < files.length; i++) {
    if (/^languages\/[^/]+\/dialogue\.(loc|pld|csv|txt)$/i.test(files[i])) {
      return files[i];
    }
  }
  return null;
}

/**
 * Fetch the extras index (mods.txt) and emit an overhaul mod entry for each
 * listed folder. Files are walked from the local working copy under
 * mods/<folder>/www; the entry's path/icon point at the remote host so the
 * client fetches assets from extras.tcoaal.app at install time.
 *
 * Entries are keyed by folder name and typed "overhaul": identical client
 * semantics to local overhauls, differing only in remote asset delivery.
 */
async function syncExtraMods(modsData) {
  console.log("[extras] Fetching " + EXTRAS_MODS_URL);
  var modsTxt = await httpGetText(EXTRAS_MODS_URL);
  if (!modsTxt) {
    console.warn("[extras] Failed to fetch mods.txt");
    return 0;
  }
  var folders = modsTxt
    .split(/\r?\n/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0 && !/^#/.test(s);
    });

  if (folders.length === 0) {
    console.warn("[extras] mods.txt is empty");
    return 0;
  }

  // Prune stale extras entries (remote path under EXTRAS_BASE) no longer
  // listed in mods.txt.
  var want = {};
  for (var i = 0; i < folders.length; i++) want[folders[i]] = true;
  var existingKeys = Object.keys(modsData);
  for (var k = 0; k < existingKeys.length; k++) {
    var ek = existingKeys[k];
    var ee = modsData[ek];
    if (
      ee &&
      typeof ee.path === "string" &&
      ee.path.indexOf(EXTRAS_BASE + "/") === 0 &&
      !want[ek]
    ) {
      console.log("[extras] Removing stale entry: " + ek);
      delete modsData[ek];
    }
  }

  var count = 0;
  for (var j = 0; j < folders.length; j++) {
    var folder = folders[j];
    var modId = folder;
    var baseUrl = EXTRAS_BASE + "/" + folder + "/www";
    var localWww = path.join(MODS_DIR, folder, "www");

    // A folder holding one .tcoaalmod instead of a www/ tree is a packaged
    // extras mod: the host serves the file as it is (extras-host copies every
    // top-level folder of cal-mods/extras), so the entry names it rather than
    // listing files. Read from a local copy under mods/<folder>/ like the
    // www/ layout is; without one, the last-known entry is kept.
    if (!fs.existsSync(localWww)) {
      var localPkg = findPackageFile(path.join(MODS_DIR, folder));
      var knownPkg = modsData[modId] && modsData[modId].package;
      if (localPkg || knownPkg) {
        if (
          await applyExtrasPackage(
            modsData,
            folder,
            localPkg ? path.join(MODS_DIR, folder, localPkg) : null,
          )
        ) {
          count++;
        }
        continue;
      }
    }

    var files = walkDir(localWww, "");
    var existing = modsData[modId] || {};
    if (files.length === 0) {
      if (existing.files && existing.files.length) {
        // No local working copy this run: keep the last-known file list so a
        // CI machine without the extras checkout doesn't wipe the manifest.
        console.warn(
          "[extras] " +
            folder +
            ": no local mods/" +
            folder +
            "/www; keeping existing " +
            existing.files.length +
            " file(s)",
        );
        files = existing.files.slice();
      } else {
        console.warn(
          "[extras] " +
            folder +
            ": no local mods/" +
            folder +
            "/www and no existing file list; skipping",
        );
        continue;
      }
    }

    var iconRel = pickExtrasIconRel(files);
    var icon = existing.icon || (iconRel ? baseUrl + "/" + iconRel : "");
    var langFile =
      existing.langFile || detectExtrasLangFile(files) || undefined;
    // Detect from the local working copy when present; otherwise keep the
    // last-known value so a CI run without the extras checkout doesn't drop it.
    var drmType =
      (fs.existsSync(localWww) ? detectDrmType(localWww) : undefined) ||
      existing.drmType;

    var lastUpdate = existing.lastUpdate;
    if (!lastUpdate && iconRel) {
      lastUpdate = await httpHeadLastModified(baseUrl + "/" + iconRel);
    }

    modsData[modId] = {
      name: existing.name || folder,
      // Curated manual field kept at a stable position (see translations
      // rebuild above); omitted by JSON.stringify when undefined.
      addedDate: existing.addedDate,
      icon: icon,
      author: existing.author || "",
      lastUpdate: lastUpdate || "",
      path: baseUrl,
      type: "overhaul",
      description: existing.description || "",
      version: existing.version || lastUpdate || "",
      files: files,
    };
    if (langFile) modsData[modId].langFile = langFile;
    if (drmType) modsData[modId].drmType = drmType;
    if (existing.before) modsData[modId].before = existing.before;

    console.log(
      "[extras] " +
        folder +
        ": " +
        files.length +
        " files" +
        (drmType ? " [drm:" + drmType + "]" : ""),
    );
    count++;
  }

  return count;
}

/**
 * Write the catalog entry of a packaged extras mod (<EXTRAS_BASE>/<folder>/
 * <name>.tcoaalmod) from the package's own mod.json. Curated fields already in
 * mods.json (name, author, description, langFile, addedDate, icon, before)
 * are kept.
 * The icon is <folder>/icon.png on the host, which extras-host's deploy
 * extracts out of the package. `pkgFile` null keeps the existing entry (a run
 * without a local copy). Returns whether an entry was written or kept.
 */
async function applyExtrasPackage(modsData, folder, pkgFile) {
  var existing = modsData[folder] || {};
  if (!pkgFile) {
    console.warn(
      "[extras] " + folder + ": no local mods/" + folder +
        "/*.tcoaalmod; keeping the existing entry",
    );
    return !!existing.package;
  }
  var info;
  try {
    info = await readPackageInfo(pkgFile);
  } catch (e) {
    console.warn("[extras] " + folder + ": cannot read " + pkgFile + ": " + e.message);
    return false;
  }
  var m = info.manifest;
  var base = EXTRAS_BASE + "/" + folder;
  var version = String(m.version || "");
  var today = new Date().toISOString().substring(0, 10);
  modsData[folder] = {
    name: existing.name || m.name || folder,
    addedDate: existing.addedDate || today,
    icon: existing.icon || (info.icon ? base + "/icon.png" : ""),
    author: existing.author || m.author || "",
    lastUpdate:
      existing.version === version && existing.lastUpdate
        ? existing.lastUpdate
        : today,
    path: base,
    type: "overhaul",
    description: existing.description || m.description || "",
    version: version,
    package: base + "/" + path.basename(pkgFile),
  };
  var lang = existing.langFile || pkgLibs().ModInstall.detectLangFile(info.rels);
  if (lang) modsData[folder].langFile = lang;
  if (existing.before) modsData[folder].before = existing.before;
  console.log(
    "[extras] " + folder + ": package " + path.basename(pkgFile) +
      " (v" + version + ", " + info.rels.length + " files)",
  );
  return true;
}

/**
 * Reorder modsData so remote extras overhaul mods sit immediately after the
 * local (built-in + bundled) mods and before the translation mods. JSON object
 * key order is insertion order, and both getModList() (client) and the Mods UI
 * render in that order, so this controls where extras mods appear in the list.
 */
function reorderModsData(modsData) {
  var base = [];
  var extras = [];
  var translations = [];
  var keys = Object.keys(modsData);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var entry = modsData[key];
    var type = entry && entry.type;
    var p = entry && entry.path;
    if (type === "translation" || key.indexOf("translation_") === 0) {
      translations.push(key);
    } else if (typeof p === "string" && p.indexOf(EXTRAS_BASE + "/") === 0) {
      extras.push(key);
    } else {
      base.push(key);
    }
  }
  var order = placeBefore(modsData, base.concat(extras, translations));
  var ordered = {};
  order.forEach(function (key) {
    ordered[key] = modsData[key];
  });
  return ordered;
}

/**
 * Honour a curated `before: "<key>"` field: that entry is moved to sit right
 * in front of the named one. It is how an extras mod is placed among the local
 * overhauls, which the grouping above would otherwise always put after them.
 * A `before` naming a key that is not in the catalog leaves the entry where
 * the grouping put it.
 */
function placeBefore(modsData, keys) {
  var out = keys.slice();
  keys.forEach(function (key) {
    var target = modsData[key] && modsData[key].before;
    if (typeof target !== "string" || target === key) return;
    if (out.indexOf(target) === -1) return;
    out.splice(out.indexOf(key), 1);
    out.splice(out.indexOf(target), 0, key);
  });
  return out;
}

/** Fetch author and last update date from a GitHub repo. */
async function fetchGithubMeta(repoUrl) {
  var gh = parseGithubUrl(repoUrl);
  if (!gh) return null;
  var base = "/repos/" + gh.owner + "/" + gh.repo;

  // Get repo info for the owner
  var repo = await ghApiFetch(base);
  var author = repo && repo.owner ? repo.owner.login : null;

  // Get latest commit date
  var commits = await ghApiFetch(base + "/commits?per_page=1");
  var lastUpdate = null;
  if (commits && commits.length > 0) {
    var d =
      commits[0].commit &&
      commits[0].commit.committer &&
      commits[0].commit.committer.date;
    if (d) lastUpdate = d.substring(0, 10);
  }

  return { author: author, lastUpdate: lastUpdate };
}

async function main() {
  var iconsAt = process.argv.indexOf("--package-icons");
  if (iconsAt !== -1) {
    var dir = process.argv[iconsAt + 1];
    if (!dir) {
      console.error("Usage: --package-icons <mods dir>");
      process.exit(2);
    }
    await extractPackageIcons(path.resolve(dir));
    return;
  }

  // Read existing mods.json
  var modsData;
  try {
    modsData = JSON.parse(fs.readFileSync(MODS_JSON, "utf8"));
  } catch (e) {
    console.error("Cannot read mods.json:", e.message);
    process.exit(1);
  }

  // Sync remotely-hosted mods (translations + extras overhauls) before walking
  // local mod dirs.
  var translationCount = await syncTranslations(modsData);
  if (translationCount > 0) {
    console.log(
      "[translations] Updated " + translationCount + " translation entry(ies)",
    );
  }

  var extrasCount = await syncExtraMods(modsData);
  if (extrasCount > 0) {
    console.log("[extras] Updated " + extrasCount + " extras mod entry(ies)");
  }

  discoverPackagedMods(modsData);

  var count = 0;
  var keys = Object.keys(modsData);
  for (var i = 0; i < keys.length; i++) {
    var modId = keys[i];
    var entry = modsData[modId];
    // Remote-hosted mods (translations + extras overhauls) are synced above;
    // skip the local walk/author/DRM logic for anything with an absolute URL
    // path so it isn't treated as a missing local mod and blanked out.
    if (entry && (entry.type === "translation" || isRemotePath(entry.path))) {
      count++;
      continue;
    }
    var modPath = entry.path || "mods/" + modId;
    var modDir = path.join(ROOT, modPath);
    var wwwDir = path.join(modDir, "www");
    var isBuiltin = modId.charAt(0) === "_";

    // Ensure name, author, description always exist (default to empty)
    if (!entry.name) entry.name = entry.name || "";
    if (!entry.author) entry.author = entry.author || "";
    if (!entry.description) entry.description = entry.description || "";

    // Built-in mods: prefix type, default author
    if (isBuiltin) {
      var baseType = (entry.type || "plugin").replace(/^built-in\s+/i, "");
      entry.type = "built-in " + baseType;
      if (!entry.author) entry.author = "kidev";
    }

    // External mods with a repo: fetch metadata from GitHub.
    // Author and description are never overwritten once set (casing may
    // differ from GitHub). lastUpdate is always refreshed.
    if (!isBuiltin && entry.repo) {
      console.log("[github] Fetching metadata for " + modId + "...");
      var meta = await fetchGithubMeta(entry.repo);
      if (meta) {
        if (!entry.author && meta.author) entry.author = meta.author;
        if (meta.lastUpdate) entry.lastUpdate = meta.lastUpdate;
        console.log(
          "  author: " +
            (entry.author || "(none)") +
            ", lastUpdate: " +
            (meta.lastUpdate || "(unchanged)"),
        );
      }
    }

    if (!fs.existsSync(wwwDir) || !fs.statSync(wwwDir).isDirectory()) {
      var pkgName = findPackageFile(modDir);
      if (!pkgName) {
        console.log("[skip] " + modId + ": no www/ directory or .tcoaalmod");
        continue;
      }
      try {
        var res = await applyPackageEntry(modId, entry, modDir, pkgName);
        console.log(
          "[package] " + modId + ": " + pkgName + " (v" + entry.version + ", " +
            res.files + " files, " + res.variants + " base build(s))",
        );
        count++;
      } catch (e) {
        console.warn("[package] " + modId + ": cannot read " + pkgName + ": " + e.message);
      }
      continue;
    }

    var files = walkDir(wwwDir, "");
    var version = getModVersion(modDir);
    var drmType = isBuiltin ? undefined : detectDrmType(wwwDir);

    entry.version = version;
    entry.files = files;
    if (drmType) entry.drmType = drmType;

    console.log(
      "[manifest] " +
        modId +
        ": " +
        files.length +
        " files" +
        (version ? " (v" + version + ")" : "") +
        (drmType ? " [drm:" + drmType + "]" : ""),
    );
    count++;
  }

  // Place extras overhaul mods right after the local overhauls and before the
  // translations, regardless of when their keys were inserted above.
  modsData = reorderModsData(modsData);

  fs.writeFileSync(MODS_JSON, JSON.stringify(modsData, null, 2) + "\n");

  if (count === 0) {
    console.log("No mods with www/ directories found.");
  } else {
    console.log("Updated mods.json with " + count + " manifest(s).");
  }
}

main().catch(function (e) {
  console.error("Fatal:", e);
  process.exit(1);
});

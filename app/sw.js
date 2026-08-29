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
 * TCOAAL Service Worker
 *
 * Intercepts game asset requests and serves them from IndexedDB, applying
 * the same TCOAAL decryption that server.js performs server-side.
 *
 * Flow for a request to "data/System.json":
 *   1. Try IDB key "data/System.json"                  -> not found (hashed filename)
 *   2. hashPath("data/System.json")                   -> "data/be1a37535e921f91"
 *   3. Try IDB key "data/be1a37535e921f91"     -> found
 *   4. dekit(buffer, "data/be1a37535e921f91")  -> plain JSON
 *   5. Respond with Content-Type: application/json
 *
 * Flow for "js/rpg_core.js":
 *   1. Try IDB key "js/rpg_core.js" -> found (plain file)
 *   2. Respond with Content-Type: application/javascript
 *
 * When IDB has no entry (SW installed but no files loaded, or server.js
 * handles the request), falls through to the network.
 */

"use strict";

importScripts("/js/libs/tcoaal-codec.js");

// dekit() call sites throughout this file pass whatever getAsset()/getAssetCI()
// handed back from IndexedDB, which for base-game assets is a raw ArrayBuffer
// (see loader.html's getBuffer()), not a Uint8Array. TcoaalCodec.dekit expects
// an indexable, .subarray()-capable view, so normalize here rather than at
// every call site.
function dekit(bytes, hashedRelPath) {
  return self.TcoaalCodec.dekit(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    hashedRelPath,
  );
}

// Constants

const DB_NAME = "tcoaal";
const DB_VERSION = 1;
const STORE_NAME = "assets";

// Protocol version. The page reads its own EXPECTED_SW_VERSION constant
// (defined in app/index.html) and auto-recovers if the controlling SW
// replies with a lower number, or doesn't reply at all (older SWs predate
// the "getVersion" handler). Bump BOTH this constant and EXPECTED_SW_VERSION
// together whenever shipping a SW change that needs existing users to drop
// their old installation: e.g. a fix to the fetch handler or a new IDB
// schema. Pure additive features (new message types the page can feature-
// detect) do not need a bump.
const SW_VERSION = 16;

// App-shell cache. Bump the version to invalidate previously cached shells
// on the next SW activation (e.g. when shipping a breaking change to one of
// the infra files). Game assets live in IndexedDB, NOT here.
const SHELL_CACHE = "tcoaal-shell-v1";

// Mod-asset cache: holds files fetched from /mods/{id}/www/{rel} for mods
// that the user has only BROWSED in the menu (not yet installed). Mainly
// icons. Once a mod is installed, its files live in IDB under "mod:{id}:..."
// and we serve from there directly. This cache exists to make the Mods
// menu fully functional offline after a single online viewing pass.
const MOD_ASSET_CACHE = "tcoaal-mod-assets-v1";

// The shell is everything required to boot the player when the network is
// unreachable. Game files are not listed: those are imported into IDB by the
// user via loader.html and served by serveFromIDB() below.
//
// sw.js itself is intentionally NOT in this list: the browser owns SW
// updates and must always see a fresh sw.js to install new code.
const APP_SHELL = [
  "/",
  "/index.html",
  "/loader.html",
  "/notice.html",
  // The notice page renders this at runtime, so the shell needs both halves
  // for the page to work offline. NOTICE.md lives at the repo root, not under
  // app/; the deploy workflow copies it into the site (see deploy-web.yml).
  "/NOTICE.md",
  "/lock.html",
  "/lock.json",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/img/icon-192.png",
  "/img/icon-512.png",
  "/img/icon-maskable-512.png",
  "/img/bg.webp",
  "/img/bg-android.webp",
  "/img/mods.png",
  "/img/achievements.png",
  "/img/achievement-locked.jpg",
  "/img/achievement-unlocked.jpg",
  "/img/help.png",
  "/img/en.png",
  "/img/loading.png",
  "/img/tcoaal-steam-header.jpg",
  "/js/libs/pako_inflate.min.js",
  "/js/libs/browser-shim.js",
  "/js/libs/lang-format.js",
  "/js/libs/lang-shim.js",
  "/js/libs/achievements-shim.js",
  "/mods.json",
  "/expected-files.json",
  // app/create.html: the (unlisted, robots-disallowed) mod-packaging tool
  // and the libs it loads. See app/create.html and CLAUDE.md.
  "/create.html",
  // The default mod icon create.html offers, and the CodeMirror build its
  // theme editors run on. Both are fetched by the page at runtime, so the
  // shell needs them for the tool to work offline.
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

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  // cache.add() per file (vs addAll) so one 404 or transient failure doesn't
  // abort the whole install: partial shells still buy the user offline boot.
  // cache: "reload" forces a fresh network fetch, bypassing the HTTP cache,
  // so we never persist a stale GitHub Pages copy into the SW cache.
  await Promise.all(
    APP_SHELL.map((url) =>
      cache
        .add(new Request(url, { cache: "reload" }))
        .catch((e) =>
          console.warn("[sw] precache failed for", url, e && e.message),
        ),
    ),
  );
}

// Built-in plugin mods. These ship with the app under /mods/_*/www/ and are
// never "installed" through the menu (Scene_Mods toggles them directly), so
// their files are not written to IDB by installMod(). Without precaching,
// an offline user who has never enabled them sees them in the menu but
// can't activate them: serveModAsset would hit the network and fail.
//
// We mirror the files listed in mods.json for each built-in entry. Keep
// this list in sync with mods.json when adding/removing built-in mods.
// Paths are routed through serveModAsset on fetch, which falls back to
// MOD_ASSET_CACHE when the network is unreachable.
const BUILTIN_MOD_ASSETS = [
  "/mods/_mouseControl/www/img/icon.png",
  "/mods/_mouseControl/www/js/plugins/MouseControl.js",
  "/mods/_virtualController/www/img/icon.png",
  "/mods/_virtualController/www/js/plugins/VirtualController.js",
  "/mods/_unlockAll/www/img/icon.png",
  "/mods/_unlockAll/www/js/plugins/UnlockAll.js",
  "/mods/_AnalogMove/www/img/icon.png",
  "/mods/_AnalogMove/www/js/plugins/SAN_AnalogMove.js",
  "/mods/_MessageBacklog/www/img/icon.png",
  "/mods/_MessageBacklog/www/js/plugins/YEP_X_MessageBacklog.js",
];

async function precacheBuiltinMods() {
  const cache = await caches.open(MOD_ASSET_CACHE);
  await Promise.all(
    BUILTIN_MOD_ASSETS.map((url) =>
      cache
        .add(new Request(url, { cache: "reload" }))
        .catch((e) =>
          console.warn("[sw] builtin precache failed for", url, e && e.message),
        ),
    ),
  );
}

// Local overhaul-mod thumbnails. Unlike the built-in plugins above, the
// same-origin overhaul mods (TCOAAR, TCOAAJ, TCOAALili, TLCOAAA, TDOAAL, ...)
// are git submodules whose icons are NOT precached. An offline user who only
// reaches the title screen online and opens the Mods menu later (offline) has
// never fetched those icons, so serveModAsset's network step fails and the
// menu shows the default sprite. Precache every same-origin mod icon listed
// in mods.json into MOD_ASSET_CACHE so the thumbnails survive an offline
// session, mirroring the built-in precache. Cross-origin icons (extras.
// tcoaal.app / translations.tcoaal.app) are skipped: the SW only intercepts
// same-origin requests, so those load via the browser's own HTTP cache.
async function precacheModIcons() {
  let data = null;
  try {
    const resp = await fetch(new Request("/mods.json", { cache: "reload" }));
    if (!resp || !resp.ok) return;
    data = await resp.json();
  } catch {
    return;
  }
  if (!data || typeof data !== "object") return;
  let cache = null;
  try {
    cache = await caches.open(MOD_ASSET_CACHE);
  } catch {
    return;
  }
  const seen = new Set();
  const tasks = [];
  for (const key of Object.keys(data)) {
    const entry = data[key];
    const icon = entry && entry.icon;
    // Same-origin local mod icons only: "mods/{id}/www/{rel}". The regex also
    // rejects absolute (http(s)://) and leading-slash paths.
    if (typeof icon !== "string" || !/^mods\/[^/]+\/www\//.test(icon)) continue;
    const reqUrl = "/" + icon;
    if (seen.has(reqUrl)) continue;
    seen.add(reqUrl);
    tasks.push(
      cache
        .add(new Request(reqUrl, { cache: "reload" }))
        .catch((e) =>
          console.warn(
            "[sw] mod icon precache failed for",
            reqUrl,
            e && e.message,
          ),
        ),
    );
  }
  await Promise.all(tasks);
}

async function cleanupOldShellCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(
        (n) =>
          (n.startsWith("tcoaal-shell-") && n !== SHELL_CACHE) ||
          (n.startsWith("tcoaal-mod-assets-") && n !== MOD_ASSET_CACHE),
      )
      .map((n) => caches.delete(n)),
  );
}

/**
 * Serve a request for a /mods/{id}/www/{rel} asset.
 *
 *   1. If the mod is already installed, the file lives in IDB under
 *      "mod:{id}:{rel}": serve from there (no network, instant).
 *   2. Otherwise, network-first into MOD_ASSET_CACHE so the second visit
 *      and any offline visit thereafter find the file cached.
 *   3. On total failure, fall through to a plain fetch() so the browser
 *      surfaces its own error.
 *
 * `preferNetwork` (set for Mods-menu thumbnails, which carry a "?fresh="
 * marker) inverts step 1: the network copy wins so an updated mod's icon
 * shows without an uninstall/reinstall. The installed IDB copy and the
 * mod-asset cache still serve as offline fallbacks.
 */
async function serveModAsset(logicalPath, request, preferNetwork) {
  const m = logicalPath.match(/^mods\/([^/]+)\/www\/(.+)$/);
  if (!m) return fetch(request);
  const modId = m[1];
  const relPath = m[2];

  let db = null;
  try {
    db = await openDB();
  } catch {}

  // Resolve the installed IDB copy on demand. dekit is a no-op when the
  // TCOAAL header isn't present, so this is safe for plain PNGs/JSON shipped
  // by mod authors and still correct for overhaul mods that ship encrypted
  // assets.
  async function fromIdb() {
    if (!db) return null;
    const value = await getAsset(db, "mod:" + modId + ":" + relPath);
    if (value === null) return null;
    const buf =
      value instanceof ArrayBuffer
        ? value
        : value && value.buffer instanceof ArrayBuffer
          ? value.buffer
          : value;
    const decrypted = dekit(buf, relPath);
    return new Response(decrypted, {
      status: 200,
      headers: { "Content-Type": mimeFor(relPath) },
    });
  }

  if (!preferNetwork) {
    const idbResp = await fromIdb();
    if (idbResp) return idbResp;
  }

  let cache = null;
  try {
    cache = await caches.open(MOD_ASSET_CACHE);
  } catch {}

  try {
    const fresh = await fetch(request, { cache: "no-store" });
    if (fresh && fresh.ok && cache) {
      const clone = fresh.clone();
      cache.put(request, clone).catch(() => {});
    }
    return fresh;
  } catch (_) {
    if (cache) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
    }
    // Offline: a thumbnail skipped the IDB-first read above, so fall back to
    // the installed copy now rather than failing the request.
    if (preferNetwork) {
      const idbResp = await fromIdb();
      if (idbResp) return idbResp;
    }
    return fetch(request);
  }
}

/**
 * Resolve a logical asset path against the BASE game only (no active-mod /
 * translation overlay). Mirrors the base-game branch of serveFromIDB:
 * direct (CI) -> extension-stripped (CI) -> hashed -> hashed+ext. Returns a
 * Response on hit, or null. Used by the per-mod Mods-menu icon route, whose
 * fallback must always be the unmodified game file.
 */
async function resolveBaseAsset(db, logicalPath) {
  const directCI = await getAssetCI(db, logicalPath);
  if (directCI !== null) {
    return new Response(dekit(directCI.value, directCI.actualKey), {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }
  const noExt = logicalPath.replace(/\.[^./]+$/, "");
  if (noExt !== logicalPath) {
    const strippedCI = await getAssetCI(db, noExt);
    if (strippedCI !== null) {
      return new Response(dekit(strippedCI.value, strippedCI.actualKey), {
        status: 200,
        headers: { "Content-Type": mimeFor(logicalPath) },
      });
    }
  }
  const hashed = await hashPath(logicalPath);
  const enc = await getAsset(db, hashed);
  if (enc !== null) {
    return new Response(dekit(enc, hashed), {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }
  const extMatch = logicalPath.match(/\.[^./]+$/);
  if (extMatch) {
    const he = await getAsset(db, hashed + extMatch[0]);
    if (he !== null) {
      return new Response(dekit(he, hashed), {
        status: 200,
        headers: { "Content-Type": mimeFor(logicalPath) },
      });
    }
  }
  return null;
}

/**
 * Serve a created/imported mod's Mods-menu icon: /__mod-icon__/{tag}/{rel}.
 *
 * The Mods menu shows a created mod's icon BEFORE it is enabled, so the
 * normal active-mod resolution (serveFromIDB) can't be used: the mod isn't
 * the active overlay. This route resolves the file for one specific mod tag
 * regardless of active state -> the mod's own copy if it ships/modifies the
 * file, otherwise the base game's version (the requested default).
 */
async function serveModMenuIcon(tag, logicalPath, request) {
  let db;
  try {
    db = await openDB();
  } catch {
    return fetch(request);
  }
  if (!db) return fetch(request);
  try {
    const own = await tryModOverlay(db, tag, logicalPath);
    if (own) return own;
  } catch {}
  try {
    const base = await resolveBaseAsset(db, logicalPath);
    if (base) return base;
  } catch {}
  return fetch(request);
}

// Menu icons we add on top of the base game (the Achievements, Mods and Help
// title-menu entries). A themed overhaul that re-skins the main menu can ship
// its own versions under www/img/system/<name>.png so our additions stay on
// theme. When such a mod is active and the engine requests one of our bundled
// icons, serveModIconOverride() resolves the mod's replacement instead.
const APP_ICON_MOD_OVERRIDES = {
  "img/achievements.png": "img/system/achievements.png",
  "img/mods.png": "img/system/mods.png",
  "img/help.png": "img/system/help.png",
};

// IDB-backed durable copies of critical shell JSON. SHELL_CACHE is keyed by
// SW_VERSION/SHELL_CACHE name and is wiped whenever cleanupOldShellCaches()
// runs, so a SW version bump while the user is offline (or a fresh install
// with precache failing) leaves the shell empty. These files are required
// for the mod system to function (sync XHR in lang-shim) and for the
// healthcheck in index.html, so we persist them to IDB on every successful
// network fetch and serve from IDB when both network and SHELL_CACHE miss.
// IDB lives in the shared "assets" store and survives SW updates.
const SHELL_IDB_FALLBACK_KEYS = {
  "mods.json": "__shell:mods.json__",
  "expected-files.json": "__shell:expected-files.json__",
};

async function persistShellJSONToIDB(idbKey, response) {
  try {
    const text = await response.clone().text();
    if (!text) return;
    const db = await openDB();
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
        tx.objectStore(STORE_NAME).put(text, idbKey);
      } catch (_) {
        resolve();
      }
    });
  } catch (_) {}
}

async function readShellJSONFromIDB(idbKey) {
  try {
    const db = await openDB();
    const value = await getAsset(db, idbKey);
    if (typeof value === "string" && value.length > 0) {
      return new Response(value, {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  } catch (_) {}
  return null;
}

/**
 * Network-first, cache-fallback strategy for app-shell files.
 *
 * When online: hit the network with cache:"no-store" so users always get the
 * latest infra after a deploy, then write the response into SHELL_CACHE so a
 * future offline boot can find it.
 *
 * When offline: serve the cached copy. If nothing is cached we fall through
 * to a final fetch() that will reject: the same failure mode users had
 * before this strategy was added.
 *
 * `cacheKey` lets us normalise "/" and "/index.html" to a single cache entry
 * so a boot from the bare origin still finds the cached index.
 *
 * `idbFallbackKey` enables a durable IDB-backed fallback for files that must
 * survive SHELL_CACHE invalidation (mods.json, expected-files.json). When set,
 * a successful network fetch also persists the body to IDB, and a cache miss
 * after a network failure falls back to the IDB copy before giving up.
 */
async function networkFirstWithShellFallback(
  request,
  cacheKey,
  idbFallbackKey,
) {
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    if (fresh && fresh.ok) {
      const clone = fresh.clone();
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.put(cacheKey || request, clone))
        .catch(() => {});
      if (idbFallbackKey) {
        persistShellJSONToIDB(idbFallbackKey, fresh);
      }
    }
    return fresh;
  } catch (_) {
    const cache = await caches.open(SHELL_CACHE);
    // ignoreSearch: "/?offline=off" should still match cached "/".
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (cacheKey ? await cache.match(cacheKey, { ignoreSearch: true }) : null);
    if (cached) return cached;
    if (idbFallbackKey) {
      const idbResponse = await readShellJSONFromIDB(idbFallbackKey);
      if (idbResponse) return idbResponse;
    }
    // Last resort: let the browser surface its own network error. This
    // preserves the previous behaviour for files we never had a chance to
    // cache (e.g. user went offline before the first successful visit).
    return fetch(request);
  }
}

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".loc": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function mimeFor(filePath) {
  const m = filePath.match(/\.[^./\\]+$/);
  return (
    MIME_MAP[(m && m[0].toLowerCase()) || ""] || "application/octet-stream"
  );
}

// IndexedDB  single shared connection, lazy-opened

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = (e) => {
      _db = e.target.result;
      // Release this long-lived connection the moment another context (the
      // loader's clear-data flow) requests a deleteDatabase. Without this the
      // SW's open handle blocks the delete indefinitely: unregister() doesn't
      // stop a running SW, so the delete only completes once the page unloads
      // (a manual refresh), leaving the "Storage busy" error and ~700MB still
      // occupied until then. Mirrors the loader's own openDB/onversionchange.
      _db.onversionchange = () => {
        try {
          _db.close();
        } catch (e) {}
        _db = null;
      };
      resolve(_db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function getAsset(db, key) {
  return new Promise((resolve) => {
    const req = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

/**
 * Case-insensitive IDB lookup cache.
 * Maps lowercase IDB key -> actual IDB key for directories already scanned.
 * Populated lazily per directory prefix on first case-insensitive miss.
 */
const _ciCache = new Map();
const _ciScannedDirs = new Set();

/**
 * Scan all IDB keys under a directory prefix and populate the CI cache.
 * E.g. prefix "audio/se/" scans all keys starting with "audio/se/".
 * Also handles mod-prefixed keys like "mod:id:audio/se/".
 */
function _ciScanDir(db, dirPrefix) {
  if (_ciScannedDirs.has(dirPrefix)) return Promise.resolve();
  _ciScannedDirs.add(dirPrefix);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const range = IDBKeyRange.bound(
        dirPrefix,
        dirPrefix + "\uffff",
        false,
        false,
      );
      const req = tx.objectStore(STORE_NAME).openKeyCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          _ciCache.set(cursor.key.toLowerCase(), cursor.key);
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Case-insensitive asset lookup. Falls back to scanning the key's directory
 * in IDB when the exact-case lookup returns null.
 */
async function getAssetCI(db, key) {
  // Try exact match first (fast path)
  const exact = await getAsset(db, key);
  if (exact !== null) return { value: exact, actualKey: key };

  // Determine the directory prefix to scan
  const lastSlash = key.lastIndexOf("/");
  const dirPrefix = lastSlash >= 0 ? key.substring(0, lastSlash + 1) : "";

  // Scan the directory if not yet cached
  await _ciScanDir(db, dirPrefix);

  // Look up by lowercase key
  const actualKey = _ciCache.get(key.toLowerCase());
  if (actualKey && actualKey !== key) {
    const val = await getAsset(db, actualKey);
    if (val !== null) return { value: val, actualKey };
  }

  return null;
}

/**
 * Serve one of our bundled menu icons from the active mod's img/system/
 * override when it ships one. Returns a Response when a themed replacement is
 * found, or null so the caller falls back to the app-shell icon. Mirrors the
 * active-mod lookup in serveFromIDB (case-insensitive direct key, dekit no-op
 * for plain PNGs, correct decrypt for TCOAAL-encrypted assets).
 */
async function serveModIconOverride(logicalPath) {
  const modRel = APP_ICON_MOD_OVERRIDES[logicalPath];
  if (!modRel) return null;
  let db;
  try {
    db = await openDB();
  } catch {
    return null;
  }
  await ensureActiveModLoaded(db);
  await ensureActiveLangLoaded(db);
  // Active language overlay wins over the overhaul, mirroring asset priority.
  for (const overlayId of [_activeLang, _activeMod]) {
    if (!overlayId) continue;
    const modPrefix = "mod:" + overlayId + ":";
    const hit = await getAssetCI(db, modPrefix + modRel);
    if (hit === null) continue;
    const keyForDecrypt = hit.actualKey.substring(modPrefix.length);
    const decrypted = dekit(hit.value, keyForDecrypt);
    return new Response(decrypted, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }
  return null;
}

const DRM_CACHE_KEY = "__drm_cache__";

/** Persist a built DRM Uint8Array to IDB so new SW instances can reuse it. */
function saveDrmToIdb(db, bytes) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(bytes.buffer, DRM_CACHE_KEY);
    req.onsuccess = resolve;
    req.onerror = resolve; // fail silently: cache is best-effort
  });
}

/** Retrieve a previously persisted DRM payload from IDB. */
function loadDrmFromIdb(db) {
  return new Promise((resolve) => {
    const req = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(DRM_CACHE_KEY);
    req.onsuccess = () => {
      const val = req.result;
      if (!val) {
        resolve(null);
        return;
      }
      resolve(val instanceof ArrayBuffer ? new Uint8Array(val) : val);
    };
    req.onerror = () => resolve(null);
  });
}

// Crypto: browser-compatible port of server.js helpers

/**
 * Compute the hashed storage path for a logical game-asset path.
 * Mirrors server.js hashPath() exactly, using WebCrypto instead of Node.js crypto.
 *
 * @param {string} logicalPath  e.g. "data/System.json"
 * @returns {Promise<string>}   e.g. "data/be1a37535e921f91"
 */
async function hashPath(logicalPath) {
  const parts = logicalPath.split(/[/\\]/);
  const fname = parts[parts.length - 1];

  const encoded = new TextEncoder().encode(parts.join("/"));
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  let h = hex.substring(0, 16);
  if (fname.toUpperCase().includes("[BUST]")) h += "[BUST]";
  if (fname.startsWith("!")) h = "!" + h;
  parts[parts.length - 1] = h;
  return parts.join("/");
}

// Pre-remaster ("old build") on-the-fly decoders.
//
// Episode 1 / Episode 2 builds are stored in IDB EXACTLY as the user imported
// them, never decoded at rest, and decoded here, per request, the same way
// the remaster's dekit() decodes remaster assets on the fly. Two container
// formats plus the language ".loc" wrapper, all mirrored byte-for-byte from
// loader.html (which mirrors tools/build-tomb-mod.js, verified against the real
// depots). See serveOldBuildAsset() for how a logical request is resolved to
// the stored container.

const K9A_LOC_SIG = "00000NEMLEI00000"; // 16-byte CLD (.loc) header
const XORENCODE_HEADER = 17; // Episode 1 XORENCODE fixed header length

// Rolling-XOR mask seed for a ".k9a"/XORENCODE file: derived from the basename
// WITHOUT its extension (e.g. "Map001"), and -- unlike the remaster header
// format -- WITHOUT the +1 dekit() applies.
function k9aSeed(baseNoExt) {
  let m = 0;
  const s = baseNoExt.toUpperCase();
  for (let i = 0; i < s.length; i++) m = (m << 1) ^ s.charCodeAt(i);
  return m & 0xff;
}

// Decode a ".k9a" container. Returns { ext, bytes }: `ext` is the real
// extension recorded (unencrypted) in the header ("json"/"png"/"ogg"/...).
function decodeK9a(arrayBuffer, baseNoExt) {
  const buf = new Uint8Array(arrayBuffer);
  const extLen = buf[0];
  const ext = new TextDecoder("latin1").decode(buf.subarray(1, 1 + extLen));
  let keyByte = buf[1 + extLen];
  const payload = buf.subarray(1 + extLen + 1);
  let mask = k9aSeed(baseNoExt);
  if (keyByte === 0) keyByte = payload.length;
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    if (i < keyByte) {
      const b = payload[i];
      out[i] = b ^ mask;
      mask = ((mask << 1) ^ b) & 0xff;
    } else {
      out[i] = payload[i];
    }
  }
  return { ext: ext || "", bytes: out };
}

// Decrypt an XORENCODE-encrypted asset: strip the 17-byte header, then run the
// same rolling XOR (keyByte = header's last byte; 0 = whole payload).
function decodeXorEncode(arrayBuffer, baseNoExt) {
  const buf = new Uint8Array(arrayBuffer);
  if (buf.length <= XORENCODE_HEADER) return buf;
  let keyByte = buf[XORENCODE_HEADER - 1];
  const payload = buf.subarray(XORENCODE_HEADER);
  let mask = k9aSeed(baseNoExt);
  if (keyByte === 0) keyByte = payload.length;
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    if (i < keyByte) {
      const b = payload[i];
      out[i] = b ^ mask;
      mask = ((mask << 1) ^ b) & 0xff;
    } else {
      out[i] = payload[i];
    }
  }
  return out;
}

// True when `bytes` already begin with the real magic for `ext` (i.e. the file
// is plain, not encrypted). Unknown extensions are treated as plain.
function assetMagicOk(bytes, ext) {
  const e = (ext || "").toLowerCase();
  if (e === "png")
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  if (e === "jpg" || e === "jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (e === "webp")
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  if (e === "ogg")
    return (
      bytes[0] === 0x4f &&
      bytes[1] === 0x67 &&
      bytes[2] === 0x67 &&
      bytes[3] === 0x53
    );
  if (e === "m4a")
    return (
      bytes.length > 11 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    );
  if (e === "json") {
    for (let i = 0; i < bytes.length && i < 64; i++) {
      const c = bytes[i];
      if (
        c === 0x20 ||
        c === 0x09 ||
        c === 0x0a ||
        c === 0x0d ||
        c === 0xef ||
        c === 0xbb ||
        c === 0xbf
      )
        continue;
      return c === 0x7b || c === 0x5b; // '{' or '['
    }
    return false;
  }
  return true; // unknown extension: assume plain
}

// Parse a NEMLEI-wrapped (or already-plain-JSON) CLD ".loc" buffer to its JSON
// text. Mirrors loader.html parseLocText() / build-tomb-mod.js parseLoc().
function parseLocText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const sig = new TextDecoder("latin1").decode(
    bytes.subarray(0, K9A_LOC_SIG.length),
  );
  if (bytes.length >= K9A_LOC_SIG.length + 4 && sig === K9A_LOC_SIG) {
    const off = K9A_LOC_SIG.length;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(off, true);
    return new TextDecoder("utf-8").decode(
      bytes.subarray(off + 4, off + 4 + len),
    );
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Serve a logical asset for an old build, decoding on the fly from whatever the
 * user imported. Returns a Response on hit, or null to fall through.
 *
 * Resolution (deterministic; the storage KEY encodes the format):
 *   A. "<stem>.k9a" present  -> decodeK9a (Episode 1 & 2 container).
 *   B. "<logical>" present   -> plain if its magic matches, else decodeXorEncode
 *                               (Episode 1 assets shipped only as XORENCODE).
 *
 * Existing pre-remaster installs (imported before this change) hold already-
 * decoded PLAIN files under logical names; those are served by serveFromIDB's
 * direct-path step (1) before this resolver is ever reached, so this only runs
 * for the new, stored-as-imported layout.
 */
async function serveOldBuildAsset(db, logicalPath) {
  const extMatch = logicalPath.match(/\.([^./]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";
  const stem = extMatch ? logicalPath.replace(/\.[^./]+$/, "") : logicalPath;
  const baseNoExt = stem.split("/").pop();

  // A. ".k9a" container.
  const k9a = await getAssetCI(db, stem + ".k9a");
  if (k9a !== null) {
    const dec = decodeK9a(k9a.value, baseNoExt);
    const useExt = ext || dec.ext || "";
    const name = useExt ? stem + "." + useExt : stem;
    return new Response(dec.bytes, {
      status: 200,
      headers: { "Content-Type": mimeFor(name) },
    });
  }

  // B. Logical name, possibly XORENCODE-encrypted.
  const direct = await getAssetCI(db, logicalPath);
  if (direct !== null) {
    const bytes = new Uint8Array(direct.value);
    if (assetMagicOk(bytes, ext)) {
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": mimeFor(logicalPath) },
      });
    }
    const dec = decodeXorEncode(direct.value, baseNoExt);
    return new Response(dec, {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }

  return null;
}

/**
 * Load an old build's language data (its languages/<lang>/dialogue.loc) by the
 * import-time pointer "__old_cld_path__", parsed to a plain JSON string. Returns
 * the string, or null. On-the-fly equivalent of the removed "__lang_data__"
 * cache for pre-remaster builds.
 */
async function loadOldCldJson(db) {
  let cldPath = null;
  try {
    cldPath = await getAsset(db, "__old_cld_path__");
  } catch {}
  if (!cldPath || typeof cldPath !== "string") return null;
  const raw = await getAsset(db, cldPath);
  if (raw === null) return null;
  try {
    const text = parseLocText(raw);
    JSON.parse(text); // validate
    return text;
  } catch {
    return null;
  }
}

// Language data merging for mod support

/**
 * Merge base and mod language data objects into a CLD that satisfies every
 * known Lang.isValid variant.
 *
 * Different DRM payloads across mods require different newData() shapes:
 *   - Base zlib DRM: { langName, langInfo, fontFace, fontSize, fontFile,
 *                       imgFiles, sysLabel, sysMenus, labelLUT, linesLUT }
 *   - TCOAALili DRM: { langName, langInfo, fontFace, fontSize,
 *                       sysLabel, sysMenus, labelLUT, linesLUT, imageLUT }
 *
 * isValid checks `key in data` for every newData key plus type parity, so the
 * merged output must include the UNION of both shapes. Extra fields are
 * harmless (isValid iterates its own template, not the input). Missing fields
 * cause loadCLD to throw, which makes Lang.select hit the "Default language
 * missing" crash path with ConfigManager.language = ''.
 */
function mergeLangData(base, mod) {
  const result = Object.assign({}, base || {});

  // Dict fields present in any DRM variant. Base entries stay as fallbacks,
  // mod entries win on the same key.
  const dictFields = [
    "labelLUT",
    "linesLUT",
    "sysMenus",
    "sysLabel",
    "imgFiles", // base zlib DRM
    "imageLUT", // TCOAALili-style DRM
  ];
  for (const f of dictFields) {
    result[f] = Object.assign(
      {},
      (base && base[f]) || {},
      (mod && mod[f]) || {},
    );
  }

  if (mod) {
    // NOTE: langVers is intentionally excluded. The DRM uses langVers as a
    // version/signature of the base CLD; a mod CLD claiming a different
    // version breaks loadCLD's validation. Keep the base's langVers.
    const scalars = [
      "langName",
      "langInfo",
      "fontFace",
      "fontSize",
      "fontFile",
    ];
    for (const s of scalars) {
      if (mod[s] !== undefined && mod[s] !== null && mod[s] !== "") {
        result[s] = mod[s];
      }
    }
  }

  // Guarantee every required scalar is present so isValid's `key in data` and
  // typeof checks pass even when base is null or partially populated. These
  // defaults match newData()'s zero values across both DRM variants.
  if (typeof result.langName !== "string" || !result.langName.trim()) {
    result.langName = "English";
  }
  if (!Array.isArray(result.langInfo) || result.langInfo.length < 3) {
    result.langInfo = ["", "", ""];
  }
  if (typeof result.fontFace !== "string" || !result.fontFace.trim()) {
    result.fontFace = "GameFont";
  }
  if (typeof result.fontSize !== "number" || result.fontSize < 1) {
    result.fontSize = 28;
  }
  if (!("fontFile" in result)) result.fontFile = null;

  return result;
}

/**
 * Resolve one translatable dict field (labelLUT / linesLUT / sysMenus /
 * sysLabel) for the "overhaul + its translation" case, where the original
 * game's translation backs the lines the mod translation doesn't cover.
 *
 * A self-contained overhaul (e.g. Side Dishes) ships a FULL CLD: every original
 * game line is present in English under its original key, alongside the mod's
 * own added/changed lines. A plain layered merge would therefore let the
 * overhaul's English reassert itself over the base-game translation for lines
 * the overhaul never actually touched. So resolve per key, highest priority
 * first:
 *   1. mod translation (modTrans): the mod author's text (new + chosen base).
 *   2. overhaul, but ONLY where it changed the base line (overhaul != baseEng):
 *      the mod rewrote that line, so its English stays (until modTrans covers).
 *   3. base-game translation (baseTrans): the original line, this language.
 *   4. overhaul-only / base English: untranslated fallback.
 * An overhaul line equal to the base line is treated as "unchanged" so the
 * base translation applies; a changed or brand-new overhaul line is not
 * mistranslated by the original line's translation.
 */
function resolveTranslatedLUT(baseEng, baseTrans, overhaul, modTrans) {
  baseEng = baseEng || {};
  baseTrans = baseTrans || {};
  overhaul = overhaul || {};
  modTrans = modTrans || {};
  const out = {};
  const keys = new Set();
  for (const src of [baseEng, baseTrans, overhaul, modTrans]) {
    for (const k in src) keys.add(k);
  }
  for (const k of keys) {
    if (k in modTrans) {
      out[k] = modTrans[k];
      continue;
    }
    const inOverhaul = k in overhaul;
    const inBase = k in baseEng;
    if (
      inOverhaul &&
      inBase &&
      JSON.stringify(overhaul[k]) !== JSON.stringify(baseEng[k])
    ) {
      out[k] = overhaul[k]; // overhaul rewrote this base line -> keep its text
    } else if (k in baseTrans) {
      out[k] = baseTrans[k]; // unchanged base line -> base-game translation
    } else if (inOverhaul) {
      out[k] = overhaul[k]; // overhaul-only line, no translation available
    } else if (inBase) {
      out[k] = baseEng[k];
    }
  }
  return out;
}

/**
 * Attempt to load and parse the base game CLD from IDB.
 * Tries pre-extracted cache first, then encrypted CLD.
 */
async function loadBaseCLD(db) {
  const LANG_CACHE_KEY = "__lang_data__";
  const CLD_KEY = "data/9c7050ae76645487";

  // 1. Pre-extracted plain JSON
  const cached = await getAsset(db, LANG_CACHE_KEY);
  if (cached !== null && typeof cached === "string") {
    try {
      return JSON.parse(cached);
    } catch {}
  }

  // 2. Encrypted CLD file (remaster), decrypted on the fly.
  const cldRaw = await getAsset(db, CLD_KEY);
  if (cldRaw !== null) {
    const decrypted = dekit(cldRaw, CLD_KEY);
    const bytes = new Uint8Array(decrypted);
    const sig = new TextDecoder().decode(bytes.slice(0, 8));
    if (sig === "LANGDATA") {
      try {
        return JSON.parse(new TextDecoder().decode(bytes.slice(8)));
      } catch {}
    }
  }

  // 3. Old build (Episode 1/2): the .loc CLD, decoded on the fly.
  const oldJson = await loadOldCldJson(db);
  if (oldJson !== null) {
    try {
      return JSON.parse(oldJson);
    } catch {}
  }

  return null;
}

/**
 * Given the active translation id, derive the matching base-game translation
 * id used as a fallback when the active translation targets an overhaul mod.
 *
 * Translation ids are "translation_<MOD>_<lang>" (MOD is a mods.json key with
 * no underscore; <lang> is a dash-slug like "portuguese-brazil"). A translation
 * for an overhaul (MOD != "BASE") usually only covers the mod's own added text,
 * leaving the original game lines untranslated. The base game's own translation
 * for the SAME language ("translation_BASE_<lang>") supplies those, so it is
 * layered UNDER the overhaul (and under the mod translation). Returns null when
 * the active lang is itself a base translation or not a translation id.
 */
function baseFallbackLangId(activeLang) {
  if (!activeLang) return null;
  const m = /^translation_([^_]+)_(.+)$/.exec(activeLang);
  if (!m || m[1] === "BASE") return null;
  return "translation_BASE_" + m[2];
}

/**
 * Attempt to load mod-specific language data from IDB.
 * Checks dialogue.loc (TCOAAR-style plain JSON), then encrypted CLD.
 */
async function loadModLangData(db, modId) {
  const CLD_KEY = "data/9c7050ae76645487";

  // 0. Pre-extracted cache (set during mod installation by lang-shim.js)
  const cachedKey = "__mod_lang_data__:" + modId;
  const cachedJson = await getAsset(db, cachedKey);
  if (cachedJson !== null && typeof cachedJson === "string") {
    try {
      const parsed = JSON.parse(cachedJson);
      if (parsed && (parsed.linesLUT || parsed.labelLUT)) return parsed;
    } catch {}
  }

  // 1. Plain JSON dialogue file (e.g. TCOAAR's languages/english/dialogue.loc)
  const locKey = "mod:" + modId + ":languages/english/dialogue.loc";
  const locRaw = await getAsset(db, locKey);
  if (locRaw !== null) {
    try {
      const text =
        typeof locRaw === "string" ? locRaw : new TextDecoder().decode(locRaw);
      const parsed = JSON.parse(text.trim());
      if (parsed && (parsed.linesLUT || parsed.labelLUT)) return parsed;
    } catch (e) {
      console.warn("[sw] Failed to parse mod dialogue.loc:", e.message);
    }
  }

  // 2. Encrypted CLD (same format as base game)
  const modCldKey = "mod:" + modId + ":" + CLD_KEY;
  const modCldRaw = await getAsset(db, modCldKey);
  if (modCldRaw !== null) {
    const decrypted = dekit(modCldRaw, CLD_KEY);
    const bytes = new Uint8Array(decrypted);
    const sig = new TextDecoder().decode(bytes.slice(0, 8));
    if (sig === "LANGDATA") {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes.slice(8)));
        if (parsed && (parsed.linesLUT || parsed.labelLUT)) return parsed;
      } catch (e) {
        console.warn("[sw] Failed to parse mod CLD:", e.message);
      }
    }
  }

  console.warn("[sw] No language data found for mod:", modId);
  return null;
}

// DRM payload assembly (browser-only mode)

/**
 * Fragment function names in the order they are concatenated by the DRM injector.
 * Each lives in one of four plugin files; we read those files from IDB.
 */
const DRM_PLUGIN_FILES = [
  [
    "js/plugins/YEP_SaveEventLocations.js",
    ["_0xabd953_", "_0xb1c2fa_", "_0x32d8dd_"],
  ],
  ["js/plugins/YEP_RegionRestrictions.js", ["_0x82f7bc_", "_0x27f7fc_"]],
  ["js/plugins/GALV_RollCredits.js", ["_0x2f7cd8_", "_0x87159a_"]],
  ["js/plugins/NonCombatMenu.js", ["_0xf3e01e_"]],
];
const DRM_ORDER = [
  "_0xabd953_",
  "_0xb1c2fa_",
  "_0x82f7bc_",
  "_0x32d8dd_",
  "_0x2f7cd8_",
  "_0xf3e01e_",
  "_0x87159a_",
  "_0x27f7fc_",
];

/** Cache: Uint8Array of the decompressed DRM JS, or null. */
let _drmCache = null;
let _drmAttempted = false;

/**
 * Decompress a zlib-compressed ArrayBuffer using the Streams API.
 * Node.js zlib.inflateSync produces zlib-wrapped deflate (RFC 1950);
 * DecompressionStream('deflate') handles the same format.
 */
async function zlibInflate(compressedBuffer) {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(compressedBuffer);
  writer.close();

  const chunks = [];
  let total = 0;
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Build the DRM inject script from plugin files stored in IndexedDB.
 * Returns a Uint8Array of UTF-8 JS source, or null on failure.
 */
async function buildDrmScript(db) {
  const fragments = {};
  const decoder = new TextDecoder();

  for (const [logicalPath, fnNames] of DRM_PLUGIN_FILES) {
    // Try encrypted (hashed) path first, then plain path
    const hashed = await hashPath(logicalPath);
    let text = null;
    for (const key of [hashed, logicalPath]) {
      const raw = await getAsset(db, key);
      if (raw !== null) {
        const decrypted = key === hashed ? dekit(raw, hashed) : raw;
        text = decoder.decode(
          decrypted instanceof ArrayBuffer ? decrypted : decrypted,
        );
        break;
      }
    }
    if (text === null) return null;

    for (const fnName of fnNames) {
      const m = text.match(
        new RegExp(
          `function ${fnName}\\(\\)\\s*\\{\\s*return\\s*"([^"]+)"\\s*;\\s*\\}`,
        ),
      );
      if (!m) return null;
      fragments[fnName] = m[1];
    }
  }

  const assembled = DRM_ORDER.map((fn) => fragments[fn]).join("");

  // Base64-decode
  const b64 = atob(assembled);
  const compressed = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) compressed[i] = b64.charCodeAt(i);

  try {
    const raw = await zlibInflate(compressed.buffer);
    // Strip anti-debug traps: `debugger; return;` blocks that pause Chrome
    // when DevTools is open and return early from the initialisation function,
    // preventing the game from starting.
    const src = new TextDecoder().decode(raw);
    const cleaned = src.replace(/\bdebugger\s*;(\s*return\s*;)?/g, "/* dbg */");
    return new TextEncoder().encode(cleaned);
  } catch {
    return null;
  }
}

// Offline-cache kill switch.
//
// The shell cache is generally an improvement (offline boot, faster repeat
// visits) but it adds a new failure mode: a poisoned cache entry could keep
// serving a broken file even after a fix is deployed. The page can flip this
// off via postMessage({type:"setOfflineEnabled", enabled:false}): typically
// driven by the user visiting "/?offline=off" or running a console helper
// (see app/index.html). When disabled, the SW reverts to its pre-offline
// behaviour: no precache, no fallback, no cache writes; and we wipe whatever
// was already in SHELL_CACHE so nothing stale can leak through.
const OFFLINE_FLAG_KEY = "__offline_disabled__";
let _offlineDisabled = false;
let _offlineDisabledLoadPromise = null;

// Belt-and-suspenders revalidation throttle. The per-request network-first
// strategy refreshes files the current page loads; this complements it by
// re-fetching the entire APP_SHELL after a successful online boot so files
// the page didn't touch (loader.html, lock.html, bg.webp, ...) still pick
// up new deploys quickly. Five minutes is short enough to land hotfixes in
// one play session, long enough that mashed reloads don't refetch ~2 MB.
const SHELL_REVALIDATE_THROTTLE_MS = 5 * 60 * 1000;
let _lastShellRevalidateAt = 0;

function ensureOfflineFlagLoaded(db) {
  if (_offlineDisabledLoadPromise) return _offlineDisabledLoadPromise;
  _offlineDisabledLoadPromise = (async () => {
    try {
      const val = await getAsset(db, OFFLINE_FLAG_KEY);
      _offlineDisabled = val === true || val === 1 || val === "1";
    } catch {}
  })();
  return _offlineDisabledLoadPromise;
}

async function setOfflineDisabledPersist(disabled) {
  _offlineDisabled = !!disabled;
  _offlineDisabledLoadPromise = Promise.resolve();
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    if (_offlineDisabled) {
      tx.objectStore(STORE_NAME).put(true, OFFLINE_FLAG_KEY);
    } else {
      tx.objectStore(STORE_NAME).delete(OFFLINE_FLAG_KEY);
    }
  } catch {}
  if (_offlineDisabled) {
    // Wipe everything so a flipped-off kill switch immediately stops
    // serving cached infra files.
    try {
      await caches.delete(SHELL_CACHE);
    } catch {}
  }
}

// Lifecycle

self.addEventListener("install", (e) =>
  e.waitUntil(
    (async () => {
      // Best-effort, time-boxed: a failing or slow precache must never
      // block the SW update. If we let install reject, the browser
      // surfaces "unknown error fetching the script" and the previous SW
      // stays in place forever: a self-trapping bug. And if install takes
      // longer than the page's controllerchange wait (~3 s) the page boots
      // without a controller and game-asset requests 404 against the
      // static host. So we cap how long we'll wait for precache here and
      // let any remaining fetches finish in the background: pending
      // fetches extend SW lifetime past install on their own.
      try {
        const db = await openDB();
        await ensureOfflineFlagLoaded(db);
      } catch {}
      if (!_offlineDisabled) {
        // Run shell + built-in mod precache concurrently; the timeout caps
        // total install time so a slow network can't block the new SW.
        // Files that haven't landed by the timeout keep fetching in the
        // background (pending fetches extend SW lifetime past install).
        await Promise.race([
          Promise.all([
            precacheShell().catch((err) =>
              console.warn("[sw] precacheShell failed:", err && err.message),
            ),
            precacheBuiltinMods().catch((err) =>
              console.warn(
                "[sw] precacheBuiltinMods failed:",
                err && err.message,
              ),
            ),
            precacheModIcons().catch((err) =>
              console.warn("[sw] precacheModIcons failed:", err && err.message),
            ),
          ]),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      }
      try {
        await self.skipWaiting();
      } catch {}
    })(),
  ),
);

self.addEventListener("activate", (e) =>
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      cleanupOldShellCaches(),
      // Invalidate the DRM cache so it gets rebuilt with the new SW code.
      // This prevents stale DRM payloads from persisting across SW updates.
      openDB()
        .then((db) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).delete(DRM_CACHE_KEY);
        })
        .catch(() => {}),
    ]),
  ),
);

// Active mod tracking
//
// The main page communicates the active mod via postMessage. The value is
// also persisted in IDB (key '__active_mod__') so it survives SW restarts.

let _activeMod = null;
let _activeModLoadPromise = null;

// Active language (translation) overlay. Independent of _activeMod: a
// translation layers ON TOP of the active context (base game OR an overhaul
// mod). Value is a translation mod key ("translation_<MOD>_<lang>") or null
// (English / the context's original text). Persisted in IDB ('__active_lang__')
// so it survives SW restarts.
let _activeLang = null;
let _activeLangLoadPromise = null;

// Pre-remaster ("old build") hash->logical asset map. The old DRM payload runs
// in the browser and hashes some asset URLs the same way the remaster does
// (e.g. img/system/language.png -> img/system/<sha>), but old builds store
// assets under their LOGICAL names, so those hashed requests would 404. The
// loader records this map ('__oldhashmap__') at import for old builds only;
// remaster installs have no such key, so _oldHashMap stays null and the
// fallback below is inert. Value: { "<dir>/<sha>": "<dir>/<logical>.<ext>" }.
let _oldHashMap = null;
let _oldHashMapLoadPromise = null;

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  // Version handshake. The page sends this on boot and compares the reply
  // against its own EXPECTED_SW_VERSION constant. Old SW versions either
  // don't have this handler (no reply -> page treats as stale and recovers)
  // or reply with a lower SW_VERSION (page recovers explicitly). Replies
  // include shellCache for diagnostics.
  if (data.type === "getVersion") {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({
        ok: true,
        version: SW_VERSION,
        shellCache: SHELL_CACHE,
      });
    }
    return;
  }

  // Manual skipWaiting hook for the common PWA "new SW is waiting, take
  // over now" prompt. Install already calls skipWaiting on its own, so
  // this is just a backup channel.
  if (data.type === "skipWaiting") {
    try {
      self.skipWaiting();
    } catch {}
    return;
  }

  if (data.type === "setActiveMod") {
    _activeMod = data.id || null;
    // Mark as resolved so parallel fetches skip the IDB read.
    _activeModLoadPromise = Promise.resolve();
    // Persist to IDB
    openDB()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        if (_activeMod) {
          tx.objectStore(STORE_NAME).put(_activeMod, "__active_mod__");
        } else {
          tx.objectStore(STORE_NAME).delete("__active_mod__");
        }
      })
      .catch(() => {});
    return;
  }

  if (data.type === "setActiveLang") {
    _activeLang = data.id || null;
    _activeLangLoadPromise = Promise.resolve();
    openDB()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        if (_activeLang) {
          tx.objectStore(STORE_NAME).put(_activeLang, "__active_lang__");
        } else {
          tx.objectStore(STORE_NAME).delete("__active_lang__");
        }
      })
      .catch(() => {});
    return;
  }

  if (data.type === "setOfflineEnabled") {
    const disabled = data.enabled === false;
    const ack = setOfflineDisabledPersist(disabled).then(async () => {
      if (!disabled) {
        // Re-enabling: warm both shell + built-in mod caches so the next
        // offline boot works.
        try {
          await Promise.all([
            precacheShell(),
            precacheBuiltinMods(),
            precacheModIcons(),
          ]);
        } catch {}
      }
    });
    if (event.ports && event.ports[0]) {
      ack.then(() => event.ports[0].postMessage({ ok: true, disabled }));
    }
    return;
  }

  if (data.type === "clearShellCache") {
    const ack = caches.delete(SHELL_CACHE).catch(() => false);
    if (event.ports && event.ports[0]) {
      ack.then((ok) => event.ports[0].postMessage({ ok: !!ok }));
    }
    return;
  }

  if (data.type === "revalidateShell") {
    // Belt-and-suspenders refresh: the per-request network-first strategy
    // only refreshes files the current page actually loads. Files the page
    // never touches (e.g. loader.html if the user is on index.html) can
    // stay stale in the cache between SW updates. This message re-fetches
    // the full APP_SHELL with cache:"reload" so a bad deploy can't linger
    // for more than one online visit.
    //
    // Throttled to avoid wasting bandwidth on every navigation. The page
    // only sends this after a successful boot; the throttle keeps rapid
    // reloads from re-pulling ~2 MB of shell on each one.
    if (_offlineDisabled) return;
    const force = data.force === true;
    const now = Date.now();
    if (!force && now - _lastShellRevalidateAt < SHELL_REVALIDATE_THROTTLE_MS) {
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ ok: true, skipped: "throttled" });
      }
      return;
    }
    _lastShellRevalidateAt = now;
    const ack = Promise.all([
      precacheShell().catch(() => {}),
      precacheBuiltinMods().catch(() => {}),
      precacheModIcons().catch(() => {}),
    ]);
    if (event.ports && event.ports[0]) {
      ack.then(() => event.ports[0].postMessage({ ok: true }));
    }
    return;
  }

  if (data.type === "resetGameCaches") {
    // Sent by the loader after a physical base-game version swap (renaming
    // IDB keys between the plain namespace and gamever:{id}:). A still-
    // running SW instance is not guaranteed to restart across the loader's
    // navigation to index.html, so purely-derived per-version caches must
    // be dropped explicitly or a stale worker could serve mismatched-
    // version content (wrong DRM payload, wrong case-insensitive directory
    // hits from _ciCache).
    _ciCache.clear();
    _drmCache = null;
    _drmAttempted = false;
    const ack = openDB()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(DRM_CACHE_KEY);
      })
      .catch(() => {});
    if (event.ports && event.ports[0]) {
      ack.then(() => event.ports[0].postMessage({ ok: true }));
    }
    return;
  }
});

/**
 * Load the active mod from IDB (once, on first request).
 * Returns a shared promise so concurrent fetches all await the same read
 * and see the resolved _activeMod: without this, fetch B can see an
 * in-flight "loaded" flag but still read null, skipping mod lookups.
 */
function ensureActiveModLoaded(db) {
  if (_activeModLoadPromise) return _activeModLoadPromise;
  _activeModLoadPromise = (async () => {
    try {
      const val = await getAsset(db, "__active_mod__");
      if (val && typeof val === "string") _activeMod = val;
    } catch {}
  })();
  return _activeModLoadPromise;
}

/** Load the active language overlay from IDB (once, on first request). */
function ensureActiveLangLoaded(db) {
  if (_activeLangLoadPromise) return _activeLangLoadPromise;
  _activeLangLoadPromise = (async () => {
    try {
      const val = await getAsset(db, "__active_lang__");
      if (val && typeof val === "string") _activeLang = val;
    } catch {}
  })();
  return _activeLangLoadPromise;
}

/**
 * Load the old-build hash->logical asset map from IDB (once). Returns the map
 * object, or null when there is none (remaster installs) so the caller's
 * fallback is skipped entirely.
 */
function ensureOldHashMapLoaded(db) {
  if (_oldHashMapLoadPromise) return _oldHashMapLoadPromise;
  _oldHashMapLoadPromise = (async () => {
    try {
      const val = await getAsset(db, "__oldhashmap__");
      if (val && typeof val === "object") _oldHashMap = val;
    } catch {}
    return _oldHashMap;
  })();
  return _oldHashMapLoadPromise;
}

/**
 * Resolve a logical asset path from one overlay store (keys
 * "mod:<modId>:<rel>") used for both overhaul mods and translation overlays.
 * Returns a Response on hit, or null to fall through to the next overlay /
 * the base game. Mirrors the base game lookup chain:
 *   direct (CI) -> extension-stripped (CI) -> hashed -> hashed+ext -> media-guess.
 */
async function tryModOverlay(db, modId, logicalPath) {
  const modPrefix = "mod:" + modId + ":";

  // M1. Direct path (case-insensitive: mod files may have different casing
  //     than what the engine requests, e.g. Windows-authored mods).
  const modDirectCI = await getAssetCI(db, modPrefix + logicalPath);
  if (modDirectCI !== null) {
    const keyForDecrypt = modDirectCI.actualKey.substring(modPrefix.length);
    const decrypted = dekit(modDirectCI.value, keyForDecrypt);
    return new Response(decrypted, {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }

  // M2. Extension-stripped (case-insensitive).
  const modNoExt = logicalPath.replace(/\.[^./]+$/, "");
  if (modNoExt !== logicalPath) {
    const modStrippedCI = await getAssetCI(db, modPrefix + modNoExt);
    if (modStrippedCI !== null) {
      const keyForDecrypt = modStrippedCI.actualKey.substring(modPrefix.length);
      const decrypted = dekit(modStrippedCI.value, keyForDecrypt);
      return new Response(decrypted, {
        status: 200,
        headers: { "Content-Type": mimeFor(logicalPath) },
      });
    }
  }

  // M2b. WebP sibling (mods only). The engine always requests images with the
  //      base game's extension (img/pictures/picture25.png), but a mod may ship
  //      the lighter picture25.webp instead. When the .png/.jpg/.jpeg lookups
  //      above miss, retry the same path with a .webp extension: both the
  //      human-named (M1) and hashed+ext (M3b) layouts. Browsers decode by
  //      content, so serving these bytes under the requested URL is fine; we
  //      just declare the correct image/webp type. Base game is unaffected:
  //      this runs only inside the mod-overlay chain.
  if (/\.(png|jpe?g)$/i.test(logicalPath)) {
    const webpPath = logicalPath.replace(/\.[^./]+$/, ".webp");
    const webpHeaders = { "Content-Type": "image/webp" };

    // Human-named (mirrors M1).
    const modWebpCI = await getAssetCI(db, modPrefix + webpPath);
    if (modWebpCI !== null) {
      const keyForDecrypt = modWebpCI.actualKey.substring(modPrefix.length);
      const decrypted = dekit(modWebpCI.value, keyForDecrypt);
      return new Response(decrypted, { status: 200, headers: webpHeaders });
    }

    // Hashed name + .webp (mirrors M3b: hash the requested path, swap only the
    // trailing extension). Mod images aren't TCOAAL-encrypted, so dekit is a
    // no-op and the seed is immaterial: only the IDB key needs to match.
    const reqHashed = await hashPath(logicalPath);
    const modWebpHashed = await getAsset(db, modPrefix + reqHashed + ".webp");
    if (modWebpHashed !== null) {
      const decrypted = dekit(modWebpHashed, reqHashed);
      return new Response(decrypted, { status: 200, headers: webpHeaders });
    }
  }

  // M3. Hashed path.
  const modHashed = await hashPath(logicalPath);
  const modEncrypted = await getAsset(db, modPrefix + modHashed);
  if (modEncrypted !== null) {
    const decrypted = dekit(modEncrypted, modHashed);
    return new Response(decrypted, {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }

  // M3b. Hashed path preserving the logical extension. Translation mods ship
  //      files at "img/pictures/<hash>.png" rather than the base game's
  //      extension-less layout, so keys look like "mod:ID:img/pictures/<hash>.png".
  const extMatch = logicalPath.match(/\.[^./]+$/);
  if (extMatch) {
    const modHashedExt = await getAsset(
      db,
      modPrefix + modHashed + extMatch[0],
    );
    if (modHashedExt !== null) {
      const decrypted = dekit(modHashedExt, modHashed);
      return new Response(decrypted, {
        status: 200,
        headers: { "Content-Type": mimeFor(logicalPath) },
      });
    }
  }

  // M3c. Extension-less CANONICAL path -> hashed overlay. The engine/DRM
  //      resolves a logical name to its canonical form WITHOUT the extension
  //      before fetching: maps and the database load as "data/Map006",
  //      "data/System" (verified from the engine's XHRs), and media the same
  //      way. Append the conventional extension, hash THAT, and look up the
  //      hashed (TCOAAL-encrypted) overlay, mirroring serveFromIDB's own
  //      base-game extension-guess fallback (step 4b).
  //
  //      Without this, code/data edits in an imported mod NEVER apply: the
  //      engine asks for "data/Map006", M3 hashes "data/Map006" (not
  //      "data/Map006.json") so the key never matches, and the lookup falls
  //      through to the base file. (Image FILE swaps still worked via M4 below,
  //      which is why only data/code edits appeared to be ignored.)
  if (!extMatch) {
    const HASHED_EXT_GUESS = {
      data: [".json"],
      img: [".png", ".jpg"],
      audio: [".ogg", ".m4a"],
      movies: [".webm", ".mp4"],
    };
    const guessTopDir = logicalPath.split("/")[0];
    const guessExts = HASHED_EXT_GUESS[guessTopDir];
    if (guessExts) {
      for (const ext of guessExts) {
        const gHash = await hashPath(logicalPath + ext);
        const modHashedGuess = await getAsset(db, modPrefix + gHash);
        if (modHashedGuess !== null) {
          const decrypted = dekit(modHashedGuess, gHash);
          return new Response(decrypted, {
            status: 200,
            headers: { "Content-Type": mimeFor(logicalPath + ext) },
          });
        }
      }
    }
  }

  // M4. Pre-hashed extension-less media path override. When the base game's
  //     DRM has already resolved a logical path to its disk-hashed form (e.g.
  //     "img/pictures/057974b069d30654"), the engine requests it without an
  //     extension. Translation mods ship the replacement as the same hashed
  //     name with a real image extension (mod PNGs are not TCOAAL-encrypted).
  //     Scoped to media top-dirs only (img/audio/movies) to avoid interfering
  //     with data/ CLD lookups.
  if (!extMatch) {
    const MOD_EXT_GUESS = {
      img: [".png", ".jpg"],
      audio: [".ogg", ".m4a"],
      movies: [".webm", ".mp4"],
    };
    const modTopDir = logicalPath.split("/")[0];
    const modExts = MOD_EXT_GUESS[modTopDir];
    if (modExts) {
      for (const ext of modExts) {
        const modGuess = await getAsset(db, modPrefix + logicalPath + ext);
        if (modGuess !== null) {
          const decrypted = dekit(modGuess, logicalPath);
          return new Response(decrypted, {
            status: 200,
            headers: { "Content-Type": mimeFor(logicalPath + ext) },
          });
        }
      }
    }
  }

  return null;
}

// Fetch interception

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only intercept same-origin GET requests
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  // Decode percent-encoding so IDB key lookups match the stored paths.
  // url.pathname preserves encoding (e.g. %5B/%5D for [ ]) but files were
  // stored under their decoded on-disk names (e.g. img/faces/abc[BUST]).
  let logicalPath;
  try {
    logicalPath =
      decodeURIComponent(url.pathname.replace(/^\/+/, "")) || "index.html";
  } catch {
    logicalPath = url.pathname.replace(/^\/+/, "") || "index.html";
  }

  // sw.js: do NOT intercept. The browser performs SW update fetches with
  // service-workers mode "none", but in practice some browsers still route
  // them through the active SW, and a response served via respondWith() can
  // be flagged as "fetched through SW": which the SW update algorithm then
  // rejects with "An unknown error occurred when fetching the script",
  // bricking all future updates. Letting the request bypass the SW
  // entirely means update fetches go straight to the network, which is what
  // the spec wants anyway. The browser has its own freshness check (max 24h
  // by spec, often shorter) so the file stays current independently of HTTP
  // cache headers.
  if (logicalPath === "sw.js") return;

  // api/*: the counter Worker (POST api/dl/{modId} to count an install, GET
  // api/dl for every count -- see trackModInstall in lang-shim.js; POST
  // api/achv/{mask} and GET api/achv for the achievement stats -- see
  // reportUnlocks in achievements-shim.js).
  // Do NOT intercept: these are live network calls to a Worker route on this
  // same origin, and serving them from here would only waste a hashed-path IDB
  // lookup before falling through to the network anyway. They stay out of
  // APP_SHELL too: counting an install offline is meaningless, and the menu
  // caches the counts it last saw under __install_counts__ instead.
  if (logicalPath.indexOf("api/") === 0) return;

  // "Now Loading" image: the engine always requests the canonical
  // img/system/Loading.png (Graphics.setLoadingImage in rpg_managers.js),
  // which would normally resolve to the hashed+encrypted base-game asset.
  // Always swap in our bundled themed loading.png instead, served from the
  // precached app shell so it works offline and never flashes the original.
  if (logicalPath === "img/system/Loading.png") {
    event.respondWith(
      (async () => {
        const bundled = new Request("/img/loading.png");
        const cached = await caches.match(bundled);
        if (cached) return cached;
        try {
          return await fetch(bundled, { cache: "force-cache" });
        } catch {
          return fetch(event.request);
        }
      })(),
    );
    return;
  }

  if (
    logicalPath === "loader.html" ||
    logicalPath === "index.html" ||
    logicalPath === "migrate.html" ||
    logicalPath === "lock.html" ||
    logicalPath === "lock.json" ||
    logicalPath === "test.html" ||
    logicalPath === "manifest.webmanifest" ||
    logicalPath === "js/libs/pako_inflate.min.js" ||
    logicalPath === "js/libs/browser-shim.js" ||
    logicalPath === "js/libs/lang-format.js" ||
    logicalPath === "js/libs/lang-shim.js" ||
    logicalPath === "js/libs/achievements-shim.js" ||
    logicalPath === "mods.json" ||
    logicalPath === "expected-files.json" ||
    logicalPath === "favicon.ico" ||
    logicalPath === "img/icon-192.png" ||
    logicalPath === "img/icon-512.png" ||
    logicalPath === "img/icon-maskable-512.png" ||
    logicalPath === "img/mods.png" ||
    logicalPath === "img/bg.webp" ||
    logicalPath === "img/bg-android.webp" ||
    logicalPath === "img/achievements.png" ||
    logicalPath === "img/achievement-locked.jpg" ||
    logicalPath === "img/achievement-unlocked.jpg" ||
    logicalPath === "img/help.png" ||
    logicalPath === "img/en.png" ||
    logicalPath === "img/loading.png" ||
    logicalPath === "img/tcoaal-steam-header.jpg" ||
    logicalPath === "create.html" ||
    logicalPath === "favicon.png" ||
    logicalPath === "js/libs/codemirror.js" ||
    logicalPath === "js/libs/codemirror.css" ||
    logicalPath === "js/libs/tcoaal-codec.js" ||
    logicalPath === "js/libs/json-diff.js" ||
    logicalPath === "js/libs/mod-package.js" ||
    logicalPath === "js/libs/mod-diff-worker.js" ||
    logicalPath === "js/libs/pe-resources.js" ||
    logicalPath === "js/libs/icns.js" ||
    logicalPath === "js/libs/stub-stamp.js"
  ) {
    // Normalise "/" -> "/index.html" for cache lookups so a boot from the
    // bare origin finds the same cached entry the SW pre-populated.
    const cacheKey =
      logicalPath === "index.html" ? new Request("/") : event.request;
    const idbFallbackKey = SHELL_IDB_FALLBACK_KEYS[logicalPath] || null;
    event.respondWith(
      (async () => {
        // Active-mod themed override for our menu icons (achievements/mods/
        // help): a mod shipping img/system/<name>.png keeps the added title
        // entries on-theme. No-op (returns null) for every other shell path.
        const iconOverride = await serveModIconOverride(logicalPath);
        if (iconOverride) return iconOverride;

        // Lazy-load the kill switch so the first request after a SW restart
        // gets the right behaviour. Falls back to "enabled" if IDB is down.
        try {
          const db = await openDB();
          await ensureOfflineFlagLoaded(db);
        } catch {}
        if (_offlineDisabled) {
          return fetch(event.request, { cache: "no-store" }).catch(() =>
            fetch(event.request),
          );
        }
        return networkFirstWithShellFallback(
          event.request,
          cacheKey,
          idbFallbackKey,
        );
      })(),
    );
    return;
  }

  // Per-mod Mods-menu icon: /__mod-icon__/{tag}/{rel}. Resolves a created
  // mod's own copy of {rel} (e.g. img/titles1/Book.png), or the base game's
  // version when the mod doesn't ship it, independent of which mod is active.
  if (logicalPath.indexOf("__mod-icon__/") === 0) {
    const mi = logicalPath.match(/^__mod-icon__\/([^/]+)\/(.+)$/);
    if (mi) {
      event.respondWith(serveModMenuIcon(mi[1], mi[2], event.request));
      return;
    }
  }

  // Mod-asset paths: /mods/{id}/www/{rel}. Handled by a dedicated strategy
  // (IDB for installed mods, MOD_ASSET_CACHE for already-browsed ones, then
  // network) so the Mods menu's icons survive an offline session.
  if (/^mods\/[^/]+\/www\//.test(logicalPath)) {
    // Thumbnails tagged "?fresh=" prefer the network so an updated mod's icon
    // appears without the user having to uninstall/reinstall it.
    const preferNetwork = url.searchParams.has("fresh");
    event.respondWith(serveModAsset(logicalPath, event.request, preferNetwork));
    return;
  }

  event.respondWith(serveFromIDB(logicalPath, event.request));
});

async function serveFromIDB(logicalPath, request) {
  let db;
  try {
    db = await openDB();
  } catch {
    return fetch(request);
  }

  // Ensure we know the active mod + language (loads once from IDB).
  await ensureActiveModLoaded(db);
  await ensureActiveLangLoaded(db);

  // 0a. Language data: serve the CLD as plain JSON.
  //     Layered merge, lowest first: base CLD -> base-game translation (the
  //     fallback for an overhaul translation) -> overhaul mod lang data ->
  //     active-language (translation) lang data. The translation thus wins
  //     over the overhaul's own text, which wins over the base game.
  //     When the active translation targets an overhaul, the base game's
  //     translation for the same language sits just above the (English) base
  //     CLD so the original game lines the mod translation doesn't cover fall
  //     back to that language instead of English. It sits BELOW the overhaul so
  //     any base line the overhaul rewrote is not mistranslated by the original
  //     line's translation.
  //     When neither overlay supplies lang data: serve the base CLD directly.
  if (logicalPath === "lang-data.json") {
    const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

    const overhaulData = _activeMod
      ? await loadModLangData(db, _activeMod)
      : null;
    const langData = _activeLang
      ? await loadModLangData(db, _activeLang)
      : null;
    const baseFallbackId = baseFallbackLangId(_activeLang);
    const baseTransData = baseFallbackId
      ? await loadModLangData(db, baseFallbackId)
      : null;

    if (overhaulData || langData || baseTransData) {
      const baseCLD = await loadBaseCLD(db);
      // Structural merge first (lowest -> highest): base -> base translation ->
      // overhaul -> mod translation. This settles every non-text field (scalars,
      // required-field defaults, imgFiles/imageLUT) with the usual mod-wins
      // priority. The translatable text dicts it produces are corrected below.
      let result = baseCLD;
      if (baseTransData) {
        result = result ? mergeLangData(result, baseTransData) : baseTransData;
      }
      // Overhaul mods (TCOAAR etc.) ship complete language data; plugin mods
      // may override only specific entries. Either way merge over the base so
      // required CLD fields are always present.
      if (overhaulData) {
        result = result ? mergeLangData(result, overhaulData) : overhaulData;
      }
      if (langData) {
        result = result ? mergeLangData(result, langData) : langData;
      }
      // When a base-game translation backs an overhaul translation, recompute
      // the text dicts diff-aware: a self-contained overhaul ships the original
      // game's English under its original keys, which the plain merge above let
      // override the base translation. resolveTranslatedLUT keeps the overhaul's
      // text only for lines it actually changed, so untouched original lines
      // fall back to the base-game translation instead of English.
      if (result && baseTransData) {
        for (const f of ["labelLUT", "linesLUT", "sysMenus", "sysLabel"]) {
          result[f] = resolveTranslatedLUT(
            baseCLD && baseCLD[f],
            baseTransData && baseTransData[f],
            overhaulData && overhaulData[f],
            langData && langData[f],
          );
        }
      }
      // Font belongs to the chosen language: an overhaul that hardcodes its own
      // fontFace/fontFile/fontSize in its CLD would otherwise clobber the
      // base-translation font (e.g. a Cyrillic/CJK face the original game lacks)
      // when the mod translation itself ships none. Reassert the translation
      // chain's font scalars last (mod translation wins over base translation).
      if (result && (baseTransData || langData)) {
        for (const src of [baseTransData, langData]) {
          if (!src) continue;
          for (const s of ["fontFace", "fontFile", "fontSize"]) {
            if (src[s] !== undefined && src[s] !== null && src[s] !== "") {
              result[s] = src[s];
            }
          }
        }
      }
      if (result) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: jsonHeaders,
        });
      }
      // No base + no overlay data: fall through to base CLD path below.
    }

    // Serve base CLD (no mod, or mod without its own lang data)
    {
      const LANG_CACHE_KEY = "__lang_data__";
      const CLD_KEY = "data/9c7050ae76645487";

      const cached = await getAsset(db, LANG_CACHE_KEY);
      if (cached !== null && typeof cached === "string") {
        return new Response(cached, { status: 200, headers: jsonHeaders });
      }

      const cldRaw = await getAsset(db, CLD_KEY);
      if (cldRaw !== null) {
        const decrypted = dekit(cldRaw, CLD_KEY);
        const bytes = new Uint8Array(decrypted);
        const sig = new TextDecoder().decode(bytes.slice(0, 8));
        if (sig === "LANGDATA") {
          return new Response(bytes.slice(8), {
            status: 200,
            headers: jsonHeaders,
          });
        }
      }

      // Old build: the .loc CLD, parsed on the fly.
      const oldJson = await loadOldCldJson(db);
      if (oldJson !== null) {
        return new Response(oldJson, { status: 200, headers: jsonHeaders });
      }
    }

    console.warn(
      "[sw] lang-data.json: no data found, falling through to network",
    );
    return fetch(request);
  }

  // 0c. Synthetic DRM inject: assembled from plugin fragments in IDB.
  if (logicalPath === "js/drm-inject.js") {
    if (!_drmAttempted) {
      _drmAttempted = true;
      // Try a fresh build from the plugin fragment functions in IDB.
      const fresh = await buildDrmScript(db).catch(() => null);
      if (fresh) {
        _drmCache = fresh;
        // Persist to IDB so new SW instances (after reg.update()) can
        // fall back to this cache instead of returning 404.
        saveDrmToIdb(db, fresh).catch(() => {});
      } else {
        // Fresh build failed (e.g. new SW instance with empty in-memory
        // cache). Try the IDB-persisted payload from a previous build.
        _drmCache = await loadDrmFromIdb(db).catch(() => null);
      }
    }
    if (_drmCache) {
      return new Response(_drmCache, {
        status: 200,
        headers: { "Content-Type": "application/javascript; charset=utf-8" },
      });
    }
    // Fall through to network (server.js may serve it)
    return fetch(request);
  }

  // M. Overlay priority. Overlays sit above the base game, highest first:
  //      1. the active language (translation): "mod:<translation>:..."
  //      2. the active overhaul mod             : "mod:<modId>:..."
  //      3. the base-game translation fallback  : "mod:translation_BASE_<lang>:"
  //    A translation thus wins over the overhaul it sits on, which wins over
  //    the base game. When the active translation targets an overhaul, the base
  //    game's translation for the same language fills assets (translated
  //    parallaxes, its language font) for the original game content the overhaul
  //    leaves untouched -- below the overhaul so the overhaul's own assets win.
  //    tryModOverlay mirrors the base game lookup chain.
  for (const overlayId of [
    _activeLang,
    _activeMod,
    baseFallbackLangId(_activeLang),
  ]) {
    if (!overlayId) continue;
    const overlayResp = await tryModOverlay(db, overlayId, logicalPath);
    if (overlayResp) return overlayResp;
  }

  // 1. Direct path (case-insensitive): engine JS, fonts, CSS, HTML, and any
  //    plain file the user stored under its original name. Also handles
  //    extension-less encrypted files (e.g. data/9c7050... the Lang data file)
  //    that are stored under their hashed disk name: dekit() is a no-op when
  //    the TCOAAL header is absent, so plain files are unaffected.
  const directCI = await getAssetCI(db, logicalPath);
  if (directCI !== null) {
    const decrypted = dekit(directCI.value, directCI.actualKey);
    return new Response(decrypted, {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }

  // 1.5 Old build (Episode 1/2): assets are stored as imported (".k9a" /
  //     XORENCODE), so a direct logical request misses step 1 and is decoded on
  //     the fly here. Gated on the import-time hash map existing, which only old
  //     builds have, so remaster installs skip this entirely. Older installs
  //     imported as already-decoded plain files were served by step 1 above.
  const oldMapEarly = await ensureOldHashMapLoaded(db);
  if (oldMapEarly) {
    const oldResp = await serveOldBuildAsset(db, logicalPath);
    if (oldResp) return oldResp;
  }

  // 2. Extension-stripped lookup (case-insensitive).
  //    Plugins compute SHA-256 client-side and append the extension before
  //    fetching ("91b682859f543183.png"). Files in IDB are stored without
  //    extension ("91b682859f543183"). Strip and decrypt.
  const noExt = logicalPath.replace(/\.[^./]+$/, "");
  if (noExt !== logicalPath) {
    const strippedCI = await getAssetCI(db, noExt);
    if (strippedCI !== null) {
      const decrypted = dekit(strippedCI.value, strippedCI.actualKey);
      return new Response(decrypted, {
        status: 200,
        headers: { "Content-Type": mimeFor(logicalPath) },
      });
    }
  }

  // 3. Canonical-path fallback: hash the full logical path.
  //    Catches any engine request not yet rewritten by plugins.
  const hashedPath = await hashPath(logicalPath);
  const encrypted = await getAsset(db, hashedPath);
  if (encrypted !== null) {
    const decrypted = dekit(encrypted, hashedPath);
    return new Response(decrypted, {
      status: 200,
      headers: { "Content-Type": mimeFor(logicalPath) },
    });
  }

  // 4. Extension-guessed fallback: the DRM payload requests extension-less
  //    logical paths (e.g. "data/Actors" instead of "data/Actors.json").
  //    Try appending common extensions and look the file up two ways: under
  //    its plain logical name (a decrypted game dump stores "data/Actors.json"
  //    directly; dekit() no-ops on plain content) and under its hashed name
  //    (an encrypted install).
  if (!logicalPath.match(/\.[a-z0-9]+$/i)) {
    const GUESS = {
      data: [".json"],
      img: [".png", ".jpg"],
      audio: [".ogg", ".m4a"],
      movies: [".webm"],
    };
    const topDir = logicalPath.split("/")[0];
    const exts = GUESS[topDir];
    if (exts) {
      for (const ext of exts) {
        const withExt = logicalPath + ext;

        // 4a. Plain logical file (decrypted dump).
        const directExt = await getAssetCI(db, withExt);
        if (directExt !== null) {
          return new Response(dekit(directExt.value, directExt.actualKey), {
            status: 200,
            headers: { "Content-Type": mimeFor(withExt) },
          });
        }

        // 4b. Hashed + encrypted form.
        const gHash = await hashPath(withExt);
        const gAsset = await getAsset(db, gHash);
        if (gAsset !== null) {
          const decrypted = dekit(gAsset, gHash);
          return new Response(decrypted, {
            status: 200,
            headers: { "Content-Type": mimeFor(withExt) },
          });
        }
      }
    }
  }

  // 4.5 Old-build hashed-name fallback. The pre-remaster DRM payload hashes
  //     some asset URLs (e.g. img/system/language.png -> img/system/<sha>.png)
  //     even though old builds store assets under logical names, so resolve the
  //     hash back to the logical file via the import-time map. Gated on the map
  //     existing (only old builds have it), so remaster installs are unaffected.
  const oldMap = await ensureOldHashMapLoaded(db);
  if (oldMap) {
    const logical = oldMap[noExt] || oldMap[logicalPath];
    if (logical) {
      // Decode on the fly from the stored container (.k9a / XORENCODE). Older
      // installs holding already-decoded plain files resolve through the same
      // helper's plain-serve branch.
      const oldResp = await serveOldBuildAsset(db, logical);
      if (oldResp) return oldResp;
    }
  }

  // 5. Not in IDB: fall through to network (server.js or static host).
  return fetch(request);
}

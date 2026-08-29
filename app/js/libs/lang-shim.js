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
 * Mod system and browser save persistence for The Coffin of Andy and Leyley.
 *
 * The DRM payload (decompressed by browser-shim.js via pako) provides all
 * game logic: Lang, Hint, Options, ConfigManager, command101, menu icons, etc.
 *
 * This file provides ONLY:
 *   - IndexedDB-backed save persistence (mirrors localStorage writes)
 *   - Mod system (install/uninstall/activate from mods.json)
 *   - Scene_Mods / Window_ModList / Window_ModConfirm UI
 *   - "Mods" title screen button (inserted after payload's menu)
 *   - Save isolation per mod (StorageManager key prefix)
 *   - Plugin-type mod loading
 *
 * Patches are deferred to Scene_Boot.start so all plugins (including the
 * DRM payload) are already loaded.
 */
(function () {
  "use strict";

  // Translator-format parsers and their schema version live in the shared,
  // dependency-free lang-format.js (loaded before this script via GAME_SCRIPTS,
  // and independently by the index.html bootstrap so a parser bump can apply on
  // the reconnecting launch itself). Alias them here so the rest of the mod
  // system keeps calling them by their original names. Bump LANG_PARSE_VERSION
  // in lang-format.js, not here.
  var LANG_FORMAT = (typeof window !== "undefined" && window.LangFormat) || {};
  var LANG_PARSE_VERSION = LANG_FORMAT.LANG_PARSE_VERSION || 1;
  var parseDialogueCsv = LANG_FORMAT.parseDialogueCsv;
  var parseDialogueTxt = LANG_FORMAT.parseDialogueTxt;

  // Plugin loader hardening (iOS Safari mobile fix)
  //
  // Stock PluginManager.loadScript appends <script async=false src=...> for
  // each plugin. On iOS Safari mobile, dynamically-inserted async=false
  // scripts going through the Service Worker can intermittently abort with a
  // DOMException(AbortError). The script's onerror fires, the URL lands in
  // PluginManager._errorUrls, and SceneManager.initialize() throws "Failed
  // to load: <url>". The user sees only stack frames in the console because
  // Safari's Error.stack format omits the message.
  //
  // Two fixes:
  //   1. Pre-fetch every plugin source via fetch() in parallel, then inject
  //      them as inline <script> tags in the original order. Inline scripts
  //      cannot abort mid-load and execute synchronously when appended, so
  //      ordering is preserved without relying on async=false semantics.
  //   2. window.__pluginsLoaded is exposed as a Promise so the bootstrap can
  //      hold off on the boot sentinel until every plugin has executed.
  //   3. checkErrors logs and clears _errorUrls instead of throwing. Stock
  //      RPG Maker treats any failed plugin as fatal, but on the browser
  //      build a user's imported www/ may legitimately omit a plugin that
  //      plugins.js still lists (game version drift, regional builds, etc.).
  //      Critical failures (DRM fragments, AudioStreaming) surface their
  //      own errors downstream, so swallowing the throw here only affects
  //      truly optional plugins.
  if (
    typeof PluginManager !== "undefined" &&
    typeof window.__pluginsLoaded === "undefined"
  ) {
    PluginManager.checkErrors = function () {
      if (this._errorUrls && this._errorUrls.length) {
        console.error(
          "[PluginManager] " +
            this._errorUrls.length +
            " plugin(s) failed to load (continuing without them):\n  " +
            this._errorUrls.join("\n  "),
        );
        this._errorUrls = [];
      }
    };

    PluginManager.onError = function (e) {
      var url = (e && e.target && e.target._url) || "<unknown>";
      console.error("[PluginManager] Script load error:", url);
      this._errorUrls.push(url);
    };

    PluginManager.setup = function (plugins) {
      var self = this;
      var queue = [];
      plugins.forEach(function (plugin) {
        if (plugin.status && self._scripts.indexOf(plugin.name) < 0) {
          self.setParameters(plugin.name, plugin.parameters);
          self._scripts.push(plugin.name);
          var url = self._path + plugin.name + ".js";
          queue.push({
            url: url,
            text: null,
            error: null,
            promise: fetch(url, {
              credentials: "same-origin",
              cache: "no-cache",
            })
              .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.text();
              })
              .then(
                function (text) {
                  return { text: text, error: null };
                },
                function (err) {
                  return { text: null, error: err };
                },
              ),
          });
        }
      });

      window.__pluginsLoaded = Promise.all(
        queue.map(function (q) {
          return q.promise;
        }),
      ).then(function (results) {
        results.forEach(function (r, i) {
          var item = queue[i];
          if (r.error) {
            console.error(
              "[PluginManager] Failed to fetch " + item.url + ":",
              r.error.message || r.error,
            );
            self._errorUrls.push(item.url);
            return;
          }
          try {
            var script = document.createElement("script");
            script.type = "text/javascript";
            script.text = r.text + "\n//# sourceURL=" + item.url + "\n";
            document.head.appendChild(script);
          } catch (ex) {
            console.error(
              "[PluginManager] Failed to execute " + item.url + ":",
              ex,
            );
            self._errorUrls.push(item.url);
          }
        });
      });
    };
  }

  // IndexedDB save persistence
  // localStorage is the primary (synchronous) store. Writes are mirrored
  // to IndexedDB asynchronously. On page load, if localStorage is empty
  // but IDB has saves, they are restored before the game boots.

  var SAVE_DB_NAME = "tcoaal-saves";
  var SAVE_DB_VERSION = 1;
  var SAVE_STORE = "saves";
  var _saveDb = null;
  var _savesRestored = false;
  // Promise mirror of _savesRestored. The DRM payload wraps SceneManager.run
  // to call DataManager.init() synchronously BEFORE the scene loop starts:
  // earlier than Scene_Boot.isReady can gate. DataManager.init reads
  // localStorage to enumerate auto*.rpgsave entries and rebuilds the
  // globalInfo autoSaves dict; if the mod-scoped keys haven't been restored
  // from IDB yet (e.g. after LS eviction), the dict is wiped. The bootstrap
  // (index.html) awaits this promise before calling SceneManager.run so the
  // restore window closes before DataManager.init runs. Stock browsers that
  // never evict the keys are unaffected (the promise still resolves once
  // the cursor scan completes, just with nothing to copy back).
  var _resolveSavesReady = null;
  var _savesReadyPromise = new Promise(function (resolve) {
    _resolveSavesReady = resolve;
  });
  function markSavesRestored() {
    if (_savesRestored) return;
    _savesRestored = true;
    if (_resolveSavesReady) _resolveSavesReady();
  }
  window.__langShimSavesReady = _savesReadyPromise;

  /* RPG Maker save keys we care about (with optional mod prefix + backup suffix). */
  function isSaveKey(key) {
    var bare = key;
    var scope = getActiveSaveScope();
    if (scope && key.indexOf(scope + ":") === 0) {
      bare = key.substring(scope.length + 1);
    }
    // Strip backup suffix if present
    if (bare.length > 3 && bare.substring(bare.length - 3) === "bak") {
      bare = bare.substring(0, bare.length - 3);
    }
    return (
      bare === "RPG Global" ||
      bare === "RPG Config" ||
      bare === "RPG Settings" ||
      /^RPG File\d+$/.test(bare) ||
      /^RPG Auto\d+$/.test(bare)
    );
  }

  function openSaveDb(callback) {
    if (_saveDb) {
      callback(_saveDb);
      return;
    }
    try {
      var req = indexedDB.open(SAVE_DB_NAME, SAVE_DB_VERSION);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore(SAVE_STORE);
      };
      req.onsuccess = function (e) {
        _saveDb = e.target.result;
        callback(_saveDb);
      };
      req.onerror = function () {
        callback(null);
      };
    } catch (e) {
      callback(null);
    }
  }

  function idbSavePut(key, value) {
    openSaveDb(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(SAVE_STORE, "readwrite");
        tx.objectStore(SAVE_STORE).put(value, key);
      } catch (e) {}
    });
  }

  function idbSaveRemove(key) {
    openSaveDb(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(SAVE_STORE, "readwrite");
        tx.objectStore(SAVE_STORE).delete(key);
      } catch (e) {}
    });
  }

  // Intercept localStorage writes directly so ALL save-key writes are
  // mirrored to IDB, regardless of whether they go through StorageManager
  // or some other code path (e.g. the DRM payload capturing a reference
  // to the original saveToWebStorage before our patches are applied).
  var _origLSSetItem = Storage.prototype.setItem;
  var _origLSRemoveItem = Storage.prototype.removeItem;
  try {
    Storage.prototype.setItem = function (key, value) {
      _origLSSetItem.call(this, key, value);
      if (this === localStorage && isSaveKey(key)) {
        idbSavePut(key, value);
      }
    };

    Storage.prototype.removeItem = function (key) {
      _origLSRemoveItem.call(this, key);
      if (this === localStorage && isSaveKey(key)) {
        idbSaveRemove(key);
      }
    };
  } catch (e) {
    // Storage prototype not writable in some environments, fall back to
    // the StorageManager wrapper in applyPatches() as before.
  }

  // Restore saves from IDB to localStorage. Always check IDB and merge
  // any missing keys; individual save files can be lost even if RPG Global
  // survives (e.g. browser storage eviction, quota pressure).
  //
  // The translation-prefix save merge that used to run here has moved to
  // its own page (/migrate.html). index.html redirects to it on boot when
  // it spots any translation_*-prefixed save key, so by the time we reach
  // this routine all keys are in canonical (unprefixed or overhaul-prefixed)
  // form: nothing for this code to special-case.
  function restoreSavesFromIDB() {
    openSaveDb(function (db) {
      if (!db) {
        markSavesRestored();
        return;
      }
      try {
        var tx = db.transaction(SAVE_STORE, "readonly");
        var store = tx.objectStore(SAVE_STORE);
        var cursor = store.openCursor();
        var scope = getActiveSaveScope();
        var prefix = scope ? scope + ":" : "";
        cursor.onsuccess = function (e) {
          var c = e.target.result;
          if (c) {
            var key = c.key;
            var keyMatchesMod = prefix
              ? key.indexOf(prefix) === 0
              : key.indexOf(":") < 0 || !isSaveKey(key);
            if (keyMatchesMod && isSaveKey(key)) {
              if (localStorage.getItem(key) === null) {
                _origLSSetItem.call(localStorage, key, c.value);
              }
            }
            c.continue();
          } else {
            markSavesRestored();
          }
        };
        cursor.onerror = function () {
          markSavesRestored();
        };
      } catch (e) {
        markSavesRestored();
      }
    });
  }

  restoreSavesFromIDB();

  // Gate Scene_Boot.isReady on save restoration (early patch).
  // NOTE: The DRM payload may overwrite Scene_Boot.prototype.isReady after
  // this runs, so hookSceneBoot() re-applies the gate after all plugins load.
  if (typeof Scene_Boot !== "undefined") {
    var _orig_isReady = Scene_Boot.prototype.isReady;
    Scene_Boot.prototype.isReady = function () {
      return _savesRestored && _orig_isReady.call(this);
    };
  }

  // Mods data store

  var _modsData = null;
  var _modsLoaded = false;

  // Registry of mods the user imported via modding.html (keyed by content
  // tag, e.g. "wafda24joj"). Their files already live in IDB under
  // mod:{tag}:..., so they are merged into _modsData as already-installed
  // entries and surfaced in the Mods menu (enable / disable / uninstall).
  var IMPORTED_MODS_KEY = "__imported_mods__";
  var _importedMods = {};

  // IDB key the SW (and index.html's preloadModsData) write the latest
  // mods.json text to. Mirrored here so a successful sync XHR also tops
  // up the durable copy independently of whether the SW intercepted.
  var MODS_JSON_IDB_KEY = "__shell:mods.json__";

  // Assets DB access constants (shared 'tcoaal' IDB for game + mod files).
  // These MUST be assigned here, ABOVE the loadModsData()/loadImportedMods()
  // calls below, because both reach openAssetsDb() during the synchronous IIFE
  // run. If they were declared after those calls, `var` hoisting would leave
  // ASSETS_DB_NAME undefined at the first openAssetsDb(): indexedDB.open(
  // undefined) then opens a database named "undefined" and caches that wrong
  // connection in _assetsDb for the whole session, so every registry/save read
  // returns null and user-imported mods never show up in the Mods menu.
  var ASSETS_DB_NAME = "tcoaal";
  var ASSETS_DB_VERSION = 1;
  var ASSETS_STORE = "assets";
  var _assetsDb = null;

  // One-time cleanup: earlier builds called openAssetsDb() before ASSETS_DB_NAME
  // was assigned, which created a stray database literally named "undefined".
  // Drop it so it stops showing up in DevTools; a no-op when it isn't there.
  try {
    indexedDB.deleteDatabase("undefined");
  } catch (e) {}

  function persistModsJsonToIdb(text) {
    if (!text || typeof text !== "string") return;
    openAssetsDb(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(ASSETS_STORE, "readwrite");
        tx.objectStore(ASSETS_STORE).put(text, MODS_JSON_IDB_KEY);
      } catch (e) {}
    });
  }

  function loadModsData() {
    // index.html's preloadModsData runs before this script loads and
    // resolves /mods.json against the network or an IDB fallback. Using
    // that preloaded blob avoids depending on the SW intercepting a sync
    // XHR, which doesn't help on first-visit-before-claim boots and
    // breaks completely offline if the SW's IDB fallback is empty.
    try {
      var preloaded =
        typeof window !== "undefined" &&
        typeof window.__modsDataJson === "string"
          ? window.__modsDataJson
          : null;
      if (preloaded) {
        var parsedPre = JSON.parse(preloaded);
        if (parsedPre && Object.keys(parsedPre).length > 0) {
          _modsData = parsedPre;
          _modsLoaded = true;
          return;
        }
      }
    } catch (e) {}

    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", "/mods.json", false);
      xhr.send();
      if (xhr.status >= 200 && xhr.status < 400) {
        var parsed = JSON.parse(xhr.responseText);
        if (parsed && Object.keys(parsed).length > 0) {
          _modsData = parsed;
          _modsLoaded = true;
          // Mirror to IDB ourselves so the next offline boot finds it
          // even if the SW didn't intercept this XHR (no controller yet,
          // first visit before claim, etc.).
          persistModsJsonToIdb(xhr.responseText);
        }
      }
    } catch (e) {}
  }

  loadModsData();
  // Merge user-imported mods (async IDB read; resolves before the Mods menu can
  // be opened). Runs after the var declarations below are set at IIFE end.
  loadImportedMods();

  var MOD_TYPE_OVERHAUL = "overhaul";
  var MOD_TYPE_TRANSLATION = "translation";

  function isPluginType(type) {
    return type && type.indexOf("plugin") >= 0;
  }

  function isTranslationType(type) {
    return type === MOD_TYPE_TRANSLATION;
  }

  /**
   * Translation mods share overhaul semantics on the client: exactly one
   * active at a time, require reload when switched. The difference is how
   * files are fetched (remote URL vs local /mods/{id}/www/) and how dialogue
   * text is built (CSV -> LUT). They are explicitly NOT a separate save
   * scope: switching from French to English must not orphan French saves.
   */
  function isOverhaulLike(type) {
    return !isPluginType(type);
  }

  function isTranslationModId(id) {
    if (!id) return false;
    // Pattern-based detection comes first: any id with the "translation_"
    // prefix is treated as a translation mod even when _modsData isn't
    // available (e.g. /mods.json failed the sync XHR, or the entry was
    // added after the manifest was last generated). Without this fallback
    // a missing manifest demotes translations to overhaul-style scopes,
    // which makes persistSaveScope write _activeSaveScope =
    // "translation_<lang>" and the webStorageKey patch then prefixes
    // every save with translation_<lang>: silently re-creating the
    // exact keys /migrate.html was just used to remove.
    if (id.indexOf("translation_") === 0) return true;
    if (!_modsData) return false;
    var entry = _modsData[id];
    return !!(entry && isTranslationType(entry.type));
  }

  /**
   * Mod id whose key prefix isolates saves in localStorage/IDB.
   * Overhaul mods own a save scope; translation mods are transparent and
   * share the underlying scope (currently always the base game, since one
   * top-level mod is active at a time). Returns null when the active mod is
   * a translation OR no mod is active, in which case saves live under the
   * stock unprefixed RPG Maker keys.
   */
  function getActiveSaveScope() {
    return isTranslationModId(_activeMod) ? null : _activeMod;
  }

  /**
   * True when a non-translation overhaul mod is currently the active mod.
   * Used to gate mods (e.g. the Unlocker) that only make sense against the
   * stock dataset + translations and would corrupt or no-op against an
   * overhaul's rewritten saves / tag system.
   */
  function isNonTranslationOverhaulActive() {
    return !!_activeMod && !isTranslationModId(_activeMod);
  }

  /**
   * Look up a mod's manifest entry by key. Returns null if mods.json isn't
   * loaded or the key is unknown; callers must treat null as "no constraint
   * data available" rather than crashing.
   */
  function getModEntry(modKey) {
    if (!modKey || !_modsData) return null;
    return _modsData[modKey] || null;
  }

  // Default Mods-menu icon URL for a created/imported mod: the game's
  // img/titles1/Book.png, resolved per-mod by the service worker so a mod that
  // ships its own Book.png shows it, otherwise the base game's version. The SW
  // route (sw.js serveModMenuIcon) handles the mod-own-vs-base fallback.
  function importedModIconUrl(tag) {
    return "__mod-icon__/" + tag + "/img/titles1/Book.png";
  }

  /**
   * Scan __mod_meta__:* entries flagged imported:true. Used to self-heal the
   * Mods list: any created mod whose files+meta are in IDB but which the
   * __imported_mods__ registry doesn't list (a registry write that didn't
   * land, or an install from an older build) is still surfaced. Keyed by tag.
   */
  function scanImportedMeta(db, cb) {
    var out = {};
    try {
      var tx = db.transaction(ASSETS_STORE, "readonly");
      var store = tx.objectStore(ASSETS_STORE);
      var prefix = "__mod_meta__:";
      var range = IDBKeyRange.bound(prefix, prefix + "\uffff");
      var cur = store.openCursor(range);
      cur.onsuccess = function (e) {
        var c = e.target.result;
        if (c) {
          try {
            var meta =
              typeof c.value === "string" ? JSON.parse(c.value) : c.value;
            if (meta && meta.imported) {
              out[String(c.key).substring(prefix.length)] = meta;
            }
          } catch (e2) {}
          c.continue();
        } else {
          cb(out);
        }
      };
      cur.onerror = function () {
        cb(out);
      };
    } catch (e) {
      cb(out);
    }
  }

  /**
   * Merge user-imported mods (modding.html, key __imported_mods__) into
   * _modsData as already-installed overhaul entries, so they show up in the
   * Mods menu. Their files are already in IDB under mod:{tag}:..., so there is
   * no remote path/file-list to fetch (path:"" / files:[]). Async (IDB), but it
   * resolves long before the player can open the Mods menu; harmless if empty.
   * The __mod_meta__ scan self-heals entries missing from the registry, and
   * every imported mod defaults to the Book.png Mods-menu icon.
   */
  function loadImportedMods(cb) {
    openAssetsDb(function (db) {
      if (!db) {
        if (cb) cb();
        return;
      }
      getAssetMain(db, IMPORTED_MODS_KEY, function (raw) {
        var reg = {};
        try {
          var parsed = raw
            ? typeof raw === "string"
              ? JSON.parse(raw)
              : raw
            : null;
          if (parsed && typeof parsed === "object") reg = parsed;
        } catch (e) {}
        scanImportedMeta(db, function (metaMap) {
          // Backfill any imported mod present in IDB but absent from the
          // registry, reconstructing display metadata from __mod_meta__.
          Object.keys(metaMap).forEach(function (tag) {
            if (reg[tag]) return;
            var meta = metaMap[tag] || {};
            reg[tag] = {
              name: meta.name || tag,
              author: meta.author || "",
              version: meta.version || "",
              description: meta.description || "",
              baseLabel: meta.baseLabel || "",
              type: meta.type || MOD_TYPE_OVERHAUL,
              imported: true,
              addedDate: meta.addedDate || meta.date || "",
            };
          });
          _importedMods = reg;
          if (!_modsData) _modsData = {};
          Object.keys(reg).forEach(function (tag) {
            var m = reg[tag] || {};
            _modsData[tag] = {
              name: m.name || tag,
              author: m.author || "",
              version: m.version || "",
              description: m.description || "",
              type: m.type || MOD_TYPE_OVERHAUL,
              icon: m.icon || importedModIconUrl(tag),
              imported: true,
              addedDate: m.addedDate || "",
              path: "", // already in IDB; nothing to fetch
              files: [],
            };
          });
          if (cb) cb();
        });
      });
    });
  }

  /**
   * Whether a mod's manifest opts it into "base-game-only" semantics:
   * activation is allowed when no mod or a translation is active, and
   * forbidden when a non-translation overhaul is active. Currently set on
   * the Unlocker (_unlockAll) since its injected globalInfo tags target
   * the stock TCOAAL ending/gallery system.
   */
  function modRequiresBaseGame(modOrKey) {
    var entry = typeof modOrKey === "string" ? getModEntry(modOrKey) : modOrKey;
    return !!(entry && entry.requiresBaseGame);
  }

  /**
   * True when the mod is currently activatable. Base-game-only mods become
   * unavailable while a non-translation overhaul is active; all other mods
   * are always available. Used by the Mods UI to draw an "Unavailable"
   * badge in place of "Disabled", and by onModOk to refuse activation.
   */
  function isModAvailable(modOrKey) {
    if (!modRequiresBaseGame(modOrKey)) return true;
    return !isNonTranslationOverhaulActive();
  }

  /** True when path is an absolute URL (translation mods host files remotely). */
  function isRemotePath(path) {
    return typeof path === "string" && /^https?:\/\//i.test(path);
  }

  function getModList() {
    var list = [];
    if (_modsData) {
      var keys = Object.keys(_modsData);
      for (var i = 0; i < keys.length; i++) {
        var entry = _modsData[keys[i]];
        // Translations are no longer surfaced in the Mods menu; they have
        // their own Language menu (driven by getContextTranslations).
        if (entry && isTranslationType(entry.type)) continue;
        list.push({
          key: keys[i],
          name: entry.name || keys[i],
          icon: entry.icon || "",
          author: entry.author || "Unknown",
          lastUpdate: entry.lastUpdate || entry.last_update || "",
          addedDate: entry.addedDate || "",
          repo: entry.repo || entry.github || "",
          path: entry.path || "mods/" + keys[i],
          type: entry.type || MOD_TYPE_OVERHAUL,
          description: entry.description || "",
          requiresBaseGame: !!entry.requiresBaseGame,
        });
      }
    }
    return list;
  }

  // Ordered row models for Window_ModList: every plugin mod first, then the
  // overhaul mods. The two groups get a divider drawn between them
  // (Window_ModList.drawItem), mirroring the framed split the
  // active overhaul/translation already gets in its own pin window above the
  // list. The active overhaul/translation is hoisted into that pin, so it is
  // filtered out of the list here.
  function buildModListRows() {
    var am = getActiveMod();
    var all = getModList().filter(function (m) {
      return !(am && m.key === am && !isPluginType(m.type));
    });
    var plugins = [];
    var overhauls = [];
    for (var i = 0; i < all.length; i++) {
      if (isPluginType(all[i].type)) plugins.push(all[i]);
      else overhauls.push(all[i]);
    }
    return plugins.concat(overhauls);
  }

  // Credits scene additions
  //
  // The Credits screen is GALV_RollCredits' Scene_Credits, fed by data/
  // Credits.txt: blocks delimited by <block:...> / </block>, each one a page,
  // with \c[2] coloured section headers. The text differs per game version and
  // per overhaul (each ships its own Credits.txt), so rather than edit any one
  // file we wrap Galv.CRED.createCreds and rework the blocks at parse time.
  // This applies uniformly to the base game, every overhaul, and any future
  // version:
  //   - the first page keeps the game's own credits (moved up), then gains a
  //     "Browser launcher / kidev" credit and a "Mods" section;
  //   - a new "Translations" page lists the translation authors;
  //   - the "Version / links" preamble is moved off the first page and merged
  //     into the final (RPG Maker EULA) page.

  // Distinct author names, splitting multi-name fields ("A, B") and
  // de-duplicating so a contributor appears once. `wantTranslations` selects
  // the translation entries (their own Language menu) vs the mods (getModList's
  // overhauls + plugins). Registry order.
  function collectModAuthors(wantTranslations) {
    var out = [];
    if (!_modsData) return out;
    var seen = {};
    var keys = Object.keys(_modsData);
    for (var i = 0; i < keys.length; i++) {
      var entry = _modsData[keys[i]];
      if (!entry || !entry.author) continue;
      if (!!isTranslationType(entry.type) !== !!wantTranslations) continue;
      var parts = String(entry.author).split(",");
      for (var j = 0; j < parts.length; j++) {
        var name = parts[j].trim();
        if (!name || Object.prototype.hasOwnProperty.call(seen, name)) continue;
        seen[name] = true;
        out.push(name);
      }
    }
    return out;
  }

  // Comma-separate names (no comma after the last), wrapping to multiple lines
  // since drawTextEx does no word wrap, to keep the centred block on-screen.
  function wrapNames(names, maxChars) {
    var lines = [];
    var cur = "";
    for (var i = 0; i < names.length; i++) {
      var piece = names[i] + (i < names.length - 1 ? "," : "");
      if (cur === "") cur = piece;
      else if ((cur + " " + piece).length > maxChars) {
        lines.push(cur);
        cur = piece;
      } else cur += " " + piece;
    }
    if (cur) lines.push(cur);
    return lines.join("\n");
  }

  // Build a \c[2]-headed section, omitted entirely when there are no names.
  function authorSection(title, names) {
    if (!names.length) return "";
    return "\\c[2]" + title + "\n" + wrapNames(names, 46) + "\n";
  }

  // Rework the raw Credits.txt before Galv parses it. The first block's leading
  // preamble (everything before its first \c[ header, i.e. the "Version /
  // links" lines) is lifted onto a new last page; the kept credits shift up and
  // gain the launcher + Mods sections; a Translations page is inserted after
  // the first. New blocks reuse the first block's display params. Returns the
  // string untouched if the block format is unexpected.
  function buildCreditsString(string) {
    if (typeof string !== "string") return string;
    var openMatch = string.match(/<block:[^>\n]*>/i);
    var endTag = "</block>";
    if (!openMatch) return string;
    var openTag = openMatch[0];
    var openEnd = openMatch.index + openTag.length;
    var firstEnd = string.indexOf(endTag, openEnd);
    if (firstEnd < 0) return string;

    var before = string.slice(0, openMatch.index);
    var inner = string.slice(openEnd, firstEnd);
    var afterFirst = string.slice(firstEnd + endTag.length);

    // Split the first block at its first coloured header: the preamble before
    // it (Version / links) moves to the last page, the rest stays and shifts up.
    var preamble = "";
    var rest = inner;
    var hdr = inner.indexOf("\\c[");
    if (hdr >= 0) {
      preamble = inner.slice(0, hdr).replace(/^\s+|\s+$/g, "");
      rest = inner.slice(hdr);
    }
    rest = rest.replace(/\s+$/, "");

    // First page: kept credits (moved up) + launcher + Mods.
    var firstInner = "\n" + rest + "\n\n\\c[2]Browser launcher\nkidev\n";
    var modsSection = authorSection("Mods", collectModAuthors(false));
    if (modsSection) firstInner += "\n" + modsSection;
    firstInner += "\n";

    var out = before + openTag + firstInner + endTag;

    // Translations page (its own block).
    var transSection = authorSection("Translations", collectModAuthors(true));
    if (transSection) {
      out += "\n\n" + openTag + "\n" + transSection + "\n" + endTag;
    }

    // Original remaining blocks (music, sound, font, EULA, ...).
    out += afterFirst.replace(/\s+$/, "");

    // Merge the Version / links preamble into the last block (the EULA page)
    // rather than giving it its own page.
    if (preamble) {
      var lastEnd = out.lastIndexOf(endTag);
      if (lastEnd >= 0) {
        out =
          out.slice(0, lastEnd).replace(/\s+$/, "") +
          "\n\n" +
          preamble +
          "\n\n" +
          out.slice(lastEnd);
      }
    }
    return out + "\n";
  }

  function installCreditsHook() {
    if (
      typeof Galv === "undefined" ||
      !Galv.CRED ||
      typeof Galv.CRED.createCreds !== "function"
    )
      return false;
    if (Galv.CRED._launcherCreditsHooked) return true;
    var orig = Galv.CRED.createCreds;
    Galv.CRED.createCreds = function (string) {
      try {
        string = buildCreditsString(string);
      } catch (e) {}
      return orig.call(this, string);
    };

    // Input behaviour: a left click or Enter should never close the credits,
    // only skip the current page to the next. The stock handler uses
    // TouchInput.isPressed() (true every frame the button is held), so one
    // click skips many pages at once and can run off the end and exit. Use
    // isTriggered() so each click / Enter advances exactly one page; only the
    // cancel button (Escape) or a right click (TouchInput.isCancelled) leaves.
    // (MouseControl's click-outside-to-cancel is also disabled for this scene
    // so a left click here advances rather than synthesizing an Escape.)
    if (
      typeof Scene_Credits !== "undefined" &&
      Scene_Credits.prototype &&
      !Scene_Credits.prototype._launcherInputPatched
    ) {
      Scene_Credits.prototype.updateInput = function () {
        if (Input.isTriggered("cancel") || TouchInput.isCancelled()) {
          this.endScene();
        } else if (Input.isTriggered("ok") || TouchInput.isTriggered()) {
          if (this._blocks && this._blocks[this._blockId]) {
            this._blocks[this._blockId]._timer = 0;
          }
        }
      };
      Scene_Credits.prototype._launcherInputPatched = true;
    }

    Galv.CRED._launcherCreditsHooked = true;
    return true;
  }

  // GALV_RollCredits is registered by PluginManager.setup (main.js), which runs
  // after this shim, so Galv.CRED.createCreds usually isn't defined yet. Poll
  // briefly until the plugin has installed it, then wrap it.
  if (!installCreditsHook()) {
    var _creditsHookTries = 0;
    var _creditsHookTimer = setInterval(function () {
      if (installCreditsHook() || ++_creditsHookTries > 200) {
        clearInterval(_creditsHookTimer);
      }
    }, 50);
  }

  // Assets DB access (shared 'tcoaal' IDB for game + mod files).
  // NOTE: the constants ASSETS_DB_NAME / ASSETS_DB_VERSION / ASSETS_STORE and
  // _assetsDb are declared near the top of the IIFE (before loadModsData /
  // loadImportedMods run), NOT here. They MUST be assigned before the first
  // openAssetsDb() call: otherwise `var` hoisting leaves ASSETS_DB_NAME
  // undefined at that call, indexedDB.open(undefined) opens a database literally
  // named "undefined", and that wrong connection gets cached in _assetsDb for
  // the whole session (every read returns null -> imported mods never appear).

  function openAssetsDb(callback) {
    if (_assetsDb) {
      callback(_assetsDb);
      return;
    }
    try {
      var req = indexedDB.open(ASSETS_DB_NAME, ASSETS_DB_VERSION);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore(ASSETS_STORE);
      };
      req.onsuccess = function (e) {
        _assetsDb = e.target.result;
        callback(_assetsDb);
      };
      req.onerror = function () {
        callback(null);
      };
    } catch (e) {
      callback(null);
    }
  }

  function putAsset(db, key, value, callback) {
    try {
      var tx = db.transaction(ASSETS_STORE, "readwrite");
      var req = tx.objectStore(ASSETS_STORE).put(value, key);
      req.onsuccess = function () {
        if (callback) callback(null);
      };
      req.onerror = function () {
        if (callback) callback(req.error);
      };
    } catch (e) {
      if (callback) callback(e);
    }
  }

  function getAssetMain(db, key, callback) {
    try {
      var tx = db.transaction(ASSETS_STORE, "readonly");
      var req = tx.objectStore(ASSETS_STORE).get(key);
      req.onsuccess = function () {
        callback(req.result !== undefined ? req.result : null);
      };
      req.onerror = function () {
        callback(null);
      };
    } catch (e) {
      callback(null);
    }
  }

  function deleteAsset(db, key, callback) {
    try {
      var tx = db.transaction(ASSETS_STORE, "readwrite");
      var req = tx.objectStore(ASSETS_STORE).delete(key);
      req.onsuccess = function () {
        if (callback) callback();
      };
      req.onerror = function () {
        if (callback) callback();
      };
    } catch (e) {
      if (callback) callback();
    }
  }

  function deleteAssetsByPrefix(db, prefix, callback) {
    try {
      var tx = db.transaction(ASSETS_STORE, "readwrite");
      var store = tx.objectStore(ASSETS_STORE);
      var cur = store.openCursor();
      var count = 0;
      cur.onsuccess = function (e) {
        var c = e.target.result;
        if (c) {
          if (typeof c.key === "string" && c.key.indexOf(prefix) === 0) {
            store.delete(c.key);
            count++;
          }
          c.continue();
        } else {
          if (callback) callback(count);
        }
      };
      cur.onerror = function () {
        if (callback) callback(0);
      };
    } catch (e) {
      if (callback) callback(0);
    }
  }

  /**
   * Delete every `mod:{modId}:{relPath}` asset whose relPath is NOT in
   * `keepSet` (a plain object used as a set of current relPaths). Used after a
   * successful (re)install to purge files the mod no longer ships, e.g. a
   * translation that switched its dialogue source from dialogue.txt to
   * dialogue.csv would otherwise leave the stale .txt behind, which
   * extractModLangData could then re-parse into an outdated CLD cache.
   * Skips cleanup when the keep set is empty so a bad/partial file list can
   * never wipe a working install.
   */
  function deleteOrphanModFiles(db, modId, keepSet, callback) {
    var prefix = "mod:" + modId + ":";
    var hasKeep = false;
    for (var k in keepSet) {
      if (Object.prototype.hasOwnProperty.call(keepSet, k)) {
        hasKeep = true;
        break;
      }
    }
    if (!hasKeep) {
      if (callback) callback(0);
      return;
    }
    try {
      var tx = db.transaction(ASSETS_STORE, "readwrite");
      var store = tx.objectStore(ASSETS_STORE);
      var cur = store.openCursor();
      var count = 0;
      cur.onsuccess = function (e) {
        var c = e.target.result;
        if (c) {
          if (typeof c.key === "string" && c.key.indexOf(prefix) === 0) {
            var rel = c.key.substring(prefix.length);
            if (!keepSet[rel]) {
              store.delete(c.key);
              count++;
            }
          }
          c.continue();
        } else {
          if (callback) callback(count);
        }
      };
      cur.onerror = function () {
        if (callback) callback(0);
      };
    } catch (e) {
      if (callback) callback(0);
    }
  }

  // Active mod tracking (IDB + localStorage + SW postMessage)

  var _activeMod = null;
  try {
    _activeMod = localStorage.getItem("_activeMod") || null;
  } catch (e) {}

  // Active language (translation) overlay tracking. Independent of _activeMod:
  // a translation now layers ON TOP of the active context (base game OR an
  // overhaul mod) rather than being the active mod itself. Value is a
  // translation key ("translation_<MOD>_<lang>") or null (English / original).
  var _activeLang = null;
  try {
    _activeLang = localStorage.getItem("_activeLang") || null;
  } catch (e) {}

  // Legacy migration: pre-update builds stored a selected translation AS the
  // active mod ("_activeMod = translation_<lang>", flat base-only layout).
  // Convert it to the new active-language overlay so the user keeps their
  // language across this update. Translation saves were always unprefixed
  // (getActiveSaveScope() returns null for them), so no save migration is
  // needed: clearing _activeMod leaves the save keys untouched.
  if (_activeMod && _activeMod.indexOf("translation_") === 0) {
    var _legacyKey = _activeMod;
    var _legacyRest = _activeMod.substring("translation_".length);
    // New-format keys already carry an uppercase MOD segment ("BASE_french");
    // legacy flat keys are just the lowercase language ("french").
    _activeLang = /^[A-Z]+_/.test(_legacyRest)
      ? _activeMod
      : "translation_BASE_" + _legacyRest;
    _activeMod = null;
    try {
      localStorage.setItem("_activeLang", _activeLang);
      localStorage.removeItem("_activeMod");
    } catch (e) {}
    // Purge the orphaned old-key install (its files: potentially many MB of
    // translated images: are no longer referenced under the new key). Only
    // when the key actually changed (flat "translation_french" ->
    // "translation_BASE_french"); never when it was already new-format.
    if (_legacyKey !== _activeLang) {
      (function (oldKey) {
        openAssetsDb(function (db) {
          if (!db) return;
          deleteAssetsByPrefix(db, "mod:" + oldKey + ":");
          deleteAsset(db, "__mod_meta__:" + oldKey);
          deleteAsset(db, "__mod_lang_data__:" + oldKey);
        });
      })(_legacyKey);
    }
    // Reconcile the SW's durable state immediately so this boot doesn't briefly
    // apply the old translation-as-active-mod overlay (which would point at the
    // now-orphaned "mod:translation_<lang>:" files) before the ready handler's
    // postMessage flips it. The new "translation_BASE_<lang>" files live under
    // a different key and aren't installed yet, so this session shows the
    // original text; the background sync re-downloads them and the next launch
    // (or re-picking the language in the Language menu, which installs it on
    // the spot) restores it. Saves are untouched.
    (function (newLang) {
      openAssetsDb(function (db) {
        if (!db) return;
        deleteAsset(db, "__active_mod__");
        putAsset(db, "__active_lang__", newLang);
      });
    })(_activeLang);
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "setActiveMod",
        id: null,
      });
      navigator.serviceWorker.controller.postMessage({
        type: "setActiveLang",
        id: _activeLang,
      });
    }
  }

  /**
   * MOD code identifying the active translation context: "BASE" for the plain
   * base game (or when only a plugin is active), otherwise the active
   * overhaul's mods.json key (which must match a "<key>_translations" set on
   * the translations server). Translations are matched to a context by their
   * "mod" field.
   */
  function getActiveContextMod() {
    if (_activeMod) {
      var e = getModEntry(_activeMod);
      var t = e && e.type;
      if (t && !isTranslationType(t) && !isPluginType(t)) return _activeMod;
    }
    return "BASE";
  }

  /** Translations (from mods.json) that apply to the current context. */
  function getContextTranslations() {
    var out = [];
    if (!_modsData) return out;
    var ctx = getActiveContextMod();
    var keys = Object.keys(_modsData);
    for (var i = 0; i < keys.length; i++) {
      var e = _modsData[keys[i]];
      if (e && isTranslationType(e.type) && (e.mod || "BASE") === ctx) {
        out.push({
          key: keys[i],
          name: e.name || keys[i],
          icon: e.icon || "",
          author: e.author || "Unknown",
          description: e.description || "",
          path: e.path || "",
          version: e.version || "",
          lastUpdate: e.lastUpdate || "",
        });
      }
    }
    return out;
  }

  /**
   * Translations (from mods.json) that target a specific mod, keyed by the
   * mod's mods.json id ("BASE" for the plain base game). Used to draw the
   * informative flag row next to a mod's type tag in the Mods list.
   */
  function getModTranslations(modKey) {
    var out = [];
    if (!_modsData) return out;
    var keys = Object.keys(_modsData);
    for (var i = 0; i < keys.length; i++) {
      var e = _modsData[keys[i]];
      if (e && isTranslationType(e.type) && (e.mod || "BASE") === modKey) {
        out.push({ key: keys[i], icon: e.icon || "" });
      }
    }
    return out;
  }

  /** Whether the title screen should expose the Language menu entry. */
  function shouldShowLanguage() {
    return (
      getActiveContextMod() === "BASE" || getContextTranslations().length > 0
    );
  }

  function getActiveLang() {
    return _activeLang;
  }

  // Drop a selected language that no longer belongs to the current context
  // (e.g. the active overhaul changed under it). Validated every boot, before
  // the menu or any reload can act on a stale value. The SW is told to drop
  // it too so this boot's asset/lang-data lookups don't apply the wrong layer.
  if (_activeLang) {
    var _le = _modsData && _modsData[_activeLang];
    if (
      !_le ||
      !isTranslationType(_le.type) ||
      (_le.mod || "BASE") !== getActiveContextMod()
    ) {
      _activeLang = null;
      try {
        localStorage.removeItem("_activeLang");
      } catch (e) {}
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "setActiveLang",
          id: null,
        });
      }
      openAssetsDb(function (db) {
        if (db) deleteAsset(db, "__active_lang__");
      });
    }
  }

  /**
   * Set (or clear) the active language overlay across localStorage, IDB, and
   * the service worker, then invoke onDone. Mirrors setActiveMod. Callers
   * follow this with a page reload so the new overlay takes effect everywhere.
   */
  function setActiveLang(langId, onDone) {
    _activeLang = langId || null;
    try {
      if (langId) localStorage.setItem("_activeLang", langId);
      else localStorage.removeItem("_activeLang");
    } catch (e) {}
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "setActiveLang",
        id: langId || null,
      });
    }
    openAssetsDb(function (db) {
      if (!db) {
        if (onDone) onDone();
        return;
      }
      if (langId) {
        putAsset(db, "__active_lang__", langId, function () {
          if (onDone) onDone();
        });
      } else {
        deleteAsset(db, "__active_lang__", function () {
          if (onDone) onDone();
        });
      }
    });
  }

  // Mirror the computed save scope into localStorage so browser-shim's
  // modAwareKey (which the DRM uses for save fs reads/writes) can pick
  // the right prefix without needing access to the mods registry.
  // "" (empty string) is meaningful: it means "no scope, use bare key"
  // and is distinct from "key absent". Pre-update localStorage may only
  // have _activeMod set; browser-shim falls back to that until we
  // overwrite the scope key here.
  function persistSaveScope() {
    try {
      localStorage.setItem("_activeSaveScope", getActiveSaveScope() || "");
    } catch (e) {}
  }
  persistSaveScope();

  // The one-time translation-prefix save merge lives on its own page
  // (/migrate.html). index.html redirects to it before booting when it
  // sees any translation_*-prefixed save key, so by the time the game
  // boots LS/IDB already contain only canonical save keys.

  // Expose active mod's langFile path so browser-shim.js / Lang.search
  // can find language data at non-standard locations (e.g. data/dialogues).
  // Translation mods (dialogue.csv / dialogue.txt) are pre-parsed into
  // /lang-data.json at install time; the DRM only reads the base CLD path.
  // Exposing a bare filename like "dialogue.csv" would cause browser-shim's
  // isCLDPath substring match to misidentify DRM overlay probes
  // (languages/<lang>/dialogue.csv) as CLD reads, breaking language load.
  if (_activeMod && _modsData && _modsData[_activeMod]) {
    var _activeEntry = _modsData[_activeMod];
    if (_activeEntry.type !== MOD_TYPE_TRANSLATION) {
      window.__modLangFile = _activeEntry.langFile || null;
    }
  }

  // Patch webStorageKey EARLY (before DRM payload executes) so that
  // any DRM init code that reads/writes saves uses the correct mod prefix.
  // Without this, the DRM can capture the stock webStorageKey and operate
  // on unprefixed keys while our post-boot code uses prefixed keys.
  // Gate on getActiveSaveScope (not _activeMod) so translation mods: which
  // share the base game's save scope: leave the stock webStorageKey alone.
  if (getActiveSaveScope() && typeof StorageManager !== "undefined") {
    var _iife_orig_webStorageKey = StorageManager.webStorageKey;
    StorageManager.webStorageKey = function (savefileId) {
      var baseKey = _iife_orig_webStorageKey.call(this, savefileId);
      var scope = getActiveSaveScope();
      return scope ? scope + ":" + baseKey : baseKey;
    };
  }

  var _modStatus = {};

  function setActiveMod(modId, onDone) {
    _activeMod = modId;
    try {
      if (modId) localStorage.setItem("_activeMod", modId);
      else localStorage.removeItem("_activeMod");
    } catch (e) {}
    // Keep _activeSaveScope in sync so the DRM-side modAwareKey sees the
    // new translation-aware scope without waiting for a page reload.
    persistSaveScope();
    // Switching to a non-translation overhaul: any base-game-only plugins
    // (currently just the Unlocker) become invalid against the new dataset,
    // so we drop them from _activePlugins now. Per spec, we deliberately do
    // NOT remember they were enabled: returning to the base game leaves the
    // user to re-enable them explicitly. The page reload that follows
    // setActiveMod then boots without those plugins.
    if (modId && !isTranslationModId(modId)) {
      var changed = false;
      for (var _i = _activePlugins.length - 1; _i >= 0; _i--) {
        if (modRequiresBaseGame(_activePlugins[_i])) {
          _activePlugins.splice(_i, 1);
          changed = true;
        }
      }
      if (changed) {
        try {
          localStorage.setItem(
            "_activePlugins",
            JSON.stringify(_activePlugins),
          );
        } catch (e) {}
      }
    }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "setActiveMod",
        id: modId || null,
      });
    }
    // A selected language belongs to one context (the base game or a specific
    // overhaul). Switching the active overhaul (or returning to base) makes a
    // cross-context language invalid, so drop it here. The new context is just
    // the new modId (an overhaul) or "BASE" (modId is null): _activeMod is
    // never a translation/plugin in the current model.
    var newCtx = modId || "BASE";
    var langInvalid = false;
    if (_activeLang) {
      var le = getModEntry(_activeLang);
      if (!le || (le.mod || "BASE") !== newCtx) langInvalid = true;
    }
    if (langInvalid) {
      _activeLang = null;
      try {
        localStorage.removeItem("_activeLang");
      } catch (e) {}
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "setActiveLang",
          id: null,
        });
      }
    }
    openAssetsDb(function (db) {
      if (!db) {
        if (onDone) onDone();
        return;
      }
      function finish() {
        if (langInvalid) {
          deleteAsset(db, "__active_lang__", function () {
            if (onDone) onDone();
          });
        } else if (onDone) {
          onDone();
        }
      }
      if (modId) {
        putAsset(db, "__active_mod__", modId, finish);
      } else {
        deleteAsset(db, "__active_mod__", finish);
      }
    });
  }

  function getActiveMod() {
    return _activeMod;
  }

  // Active plugins (plugin-type mods)

  var _activePlugins = [];
  try {
    var raw = localStorage.getItem("_activePlugins");
    if (raw) _activePlugins = JSON.parse(raw);
  } catch (e) {}

  // Auto-enable mouse control mod on mobile/touch devices regardless of user choice
  var _isMobile =
    /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
  if (_isMobile && _activePlugins.indexOf("_mouseControl") < 0) {
    _activePlugins.push("_mouseControl");
    try {
      localStorage.setItem("_activePlugins", JSON.stringify(_activePlugins));
    } catch (e) {}
  }

  // Offline state shared across the module. Probed once at startup and every
  // 5s while Scene_Mods is open; cached so the badge is instant on scene entry.
  var _isAndroidApp = /TCOAALApp\//.test(navigator.userAgent);
  var _cachedOffline = false;

  // The Android app's WebView can't turn a blob: URL + <a download> click
  // into an actual download (no DownloadListener is registered, and blob:
  // URLs have no host for UrlPolicy to recognize as internal, so the click
  // is silently dropped as an unhandled external Intent). When the native
  // bridge is present (see ExportBridge.kt in android/), hand exported
  // files to it instead of the blob+anchor trick.
  function androidExportBridge() {
    return typeof window.AndroidExportBridge !== "undefined" &&
      typeof window.AndroidExportBridge.exportFile === "function"
      ? window.AndroidExportBridge
      : null;
  }

  // Uses TextEncoder rather than a plain btoa(str) so it's correct
  // regardless of the string's character range (save content happens to be
  // ASCII-only today (LZString's base64 alphabet), but this doesn't rely
  // on that staying true). Chunked to avoid blowing the call stack on
  // String.fromCharCode.apply for a large payload.
  function textToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var CHUNK = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function _probeOffline(cb) {
    // navigator.onLine === false is a reliable "definitely offline" on desktop;
    // Android WebView may return true even when offline, so we confirm with a
    // fetch probe there (mirrors loader.html's approach).
    if (navigator.onLine === false) {
      _cachedOffline = true;
      if (cb) cb(true);
      return;
    }
    if (!_isAndroidApp) {
      _cachedOffline = false;
      if (cb) cb(false);
      return;
    }
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var tid = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
    var opts = { method: "HEAD", cache: "no-store" };
    if (ctrl) opts.signal = ctrl.signal;
    fetch("/mods.json", opts)
      .then(function (r) {
        if (tid) clearTimeout(tid);
        _cachedOffline = !r.ok;
        if (cb) cb(_cachedOffline);
      })
      .catch(function () {
        if (tid) clearTimeout(tid);
        _cachedOffline = true;
        if (cb) cb(true);
      });
  }

  // "Seen updates" tracking for the NEW/UPDATED badge in the Mods menu.
  // Maps modKey -> the lastUpdate value the user has already laid their
  // cursor on. A mod is flagged until the user hovers/selects its row, at
  // which point we store its current lastUpdate so the badge clears and only
  // reappears the next time the build bumps lastUpdate.
  var _modSeenUpdates = {};
  try {
    var rawSeen = localStorage.getItem("_modSeenUpdates");
    if (rawSeen) _modSeenUpdates = JSON.parse(rawSeen) || {};
  } catch (e) {}

  function persistModSeen() {
    try {
      localStorage.setItem("_modSeenUpdates", JSON.stringify(_modSeenUpdates));
    } catch (e) {}
  }

  // Record a mod's current lastUpdate as seen. Returns true when the stored
  // value actually changed so the caller can refresh to drop a stale badge.
  // Mods without a lastUpdate are never recorded (they can't carry a badge).
  function markModSeen(mod) {
    if (!mod || !mod.key || !mod.lastUpdate) return false;
    if (_modSeenUpdates[mod.key] === mod.lastUpdate) return false;
    _modSeenUpdates[mod.key] = mod.lastUpdate;
    persistModSeen();
    return true;
  }

  var MOD_BADGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // ~1 month

  // Badge for a mod row: "NEW" (the user has never seen this mod), "UPDATED"
  // (seen before but lastUpdate has since changed), or "" (no badge). Only
  // mods that are "fresh" within the last month are ever flagged, so a mod the
  // user simply never hovered isn't badged forever and stale releases stay
  // quiet. Freshness is the more recent of two dates: lastUpdate (when the
  // mod's content last changed) and addedDate (when we first shipped the mod in
  // the player). The latter lets a mod with an old upstream release still
  // announce itself as NEW the moment it lands here. The NEW-vs-UPDATED split
  // still keys off lastUpdate alone (see markModSeen).
  function modBadge(mod) {
    if (!mod || !mod.lastUpdate) return "";
    var t = Math.max(
      Date.parse(mod.addedDate) || 0,
      Date.parse(mod.lastUpdate) || 0,
    );
    if (!t) return "";
    if (Date.now() - t > MOD_BADGE_MAX_AGE_MS) return "";
    if (!(mod.key in _modSeenUpdates)) return "NEW";
    if (_modSeenUpdates[mod.key] !== mod.lastUpdate) return "UPDATED";
    return "";
  }

  // Mod thumbnails must reflect the currently-deployed file even while the
  // mod is installed (its files are otherwise served from a stale IDB copy).
  // The "fresh" marker tells the service worker to fetch the icon from the
  // network (see sw.js serveModAsset), and also varies the in-engine bitmap
  // cache key so a reload after a deploy decodes the new icon.
  function modIconUrl(icon) {
    if (!icon) return icon;
    return icon + (icon.indexOf("?") < 0 ? "?" : "&") + "fresh=1";
  }

  // Image loader for NON-CRITICAL bitmaps that must NEVER escalate to the
  // engine's blocking "Loading error" dialog.
  //
  // Used for mod / language / flag thumbnails (remote extras.tcoaal.app
  // origins or app assets that may be absent offline) and the Continue
  // menu's map backgrounds (a save may reference a hash not present in IDB).
  // The stock ImageManager.loadNormalBitmap / Bitmap.load path routes a
  // failed load through ResourceHandler -> Graphics.printLoadingError() +
  // SceneManager.stop(), which is correct for game-critical assets but wrong
  // here: a missing one must silently fall back, not freeze the scene (the
  // symptom offline, where remote icons can never load). It also sidesteps
  // the DRM's Bitmap._requestImage override, which would rewrite the URL
  // through Crypto.resolveURL.
  //
  // The returned Bitmap stays width<=1 until the image decodes; on error it
  // goes to state 'error' and notifies listeners so the caller can redraw /
  // advance. Callers already guard on `isReady() && !isError() && width > 1`.
  function loadSafeBitmap(url) {
    var bitmap = Object.create(Bitmap.prototype);
    bitmap._defer = true;
    bitmap.initialize();
    bitmap._url = url;
    bitmap._loadingState = "requesting";
    var image = new Image();
    // Cross-origin thumbnails (extras.tcoaal.app) need CORS so the canvas /
    // WebGL texture isn't tainted when blt into a window's contents. The
    // remote host already serves these CORS-enabled (the DRM path XHRs them).
    try {
      if (new URL(url, location.href).origin !== location.origin) {
        image.crossOrigin = "anonymous";
      }
    } catch (e) {}
    image.addEventListener("load", function () {
      bitmap._image = image;
      bitmap._loadingState = "requestCompleted";
      try {
        bitmap.decode(); // -> 'loaded', builds the texture, fires listeners
      } catch (e) {
        bitmap._loadingState = "error";
        bitmap._callLoadListeners();
      }
    });
    image.addEventListener("error", function () {
      bitmap._loadingState = "error";
      bitmap._callLoadListeners();
    });
    image.src = url;
    return bitmap;
  }

  // Browser Fullscreen API helpers
  // Shared by the four-finger gesture, the Options "Fullscreen" toggle, and
  // the mobile launch button. iOS Safari on iPhone has no Fullscreen API for
  // arbitrary elements: these no-op there, which is fine (the PWA "Add to
  // Home Screen" path already covers that case). Function declarations so
  // they hoist to the top of this module IIFE regardless of call site.
  function _fsElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }
  function _fsSupported() {
    var de = typeof document !== "undefined" && document.documentElement;
    return !!(
      de &&
      (de.requestFullscreen ||
        de.webkitRequestFullscreen ||
        de.mozRequestFullScreen ||
        de.msRequestFullscreen)
    );
  }
  function _fsToggle() {
    if (_fsElement()) {
      var ex =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;
      if (!ex) return;
      try {
        var r = ex.call(document);
        if (r && typeof r.catch === "function") r.catch(function () {});
      } catch (e) {}
    } else {
      var de = document.documentElement;
      var rq =
        de.requestFullscreen ||
        de.webkitRequestFullscreen ||
        de.mozRequestFullScreen ||
        de.msRequestFullscreen;
      if (!rq) return;
      // The gesture that reached us (tap/click/key) is the user activation
      // the Fullscreen API requires; activation persists long enough for the
      // engine's polled input to call this on the next frame.
      try {
        var r2 = rq.call(de);
        if (r2 && typeof r2.catch === "function") r2.catch(function () {});
      } catch (e2) {}
    }
  }

  // Four-finger touch toggles fullscreen. The touchstart itself is the user
  // gesture required by the Fullscreen API. Bound in the capture phase so it
  // runs before TouchInput's document listener (added later via
  // SceneManager.initInput), and preventDefault is called only when the
  // gesture actually fires so 1-3 finger touches still reach the engine.
  document.addEventListener(
    "touchstart",
    function (e) {
      if (!e.touches || e.touches.length !== 4) return;
      try {
        e.preventDefault();
      } catch (_) {}
      _fsToggle();
    },
    { capture: true, passive: false },
  );

  // Mobile launch hint: a one-shot fullscreen button that fades in at the
  // top-right when the game first becomes interactive (Scene_Title), then
  // dismisses itself after 5s, on the first key/scene transition, or once
  // tapped. Mobile only: desktop users have F4 / the four-finger gesture is
  // irrelevant there, and auto-fullscreen on load is impossible (no gesture).
  // _fsBtnDismiss lets the Scene_Title command wrappers tear it down the
  // moment the player navigates ("enters a menu or does something else").
  var _fsBtnShown = false;
  var _fsBtnDismiss = null;

  function _dismissFsLaunchButton() {
    if (_fsBtnDismiss) _fsBtnDismiss();
  }

  function _showFsLaunchButton() {
    if (_fsBtnShown) return; // once per page load
    if (!_isMobile || !_fsSupported()) return;
    if (_fsElement()) return; // already fullscreen (e.g. launched as PWA)
    if (typeof document === "undefined" || !document.body) return;
    _fsBtnShown = true;

    var btn = document.createElement("button");
    btn.id = "__fs_launch_btn__";
    btn.type = "button";
    btn.setAttribute("aria-label", "Enter fullscreen");
    // Inline "expand to fullscreen" glyph (four corner arrows).
    btn.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3H5a2 2 0 0 0-2 2v3"/>' +
      '<path d="M16 3h3a2 2 0 0 1 2 2v3"/>' +
      '<path d="M8 21H5a2 2 0 0 1-2-2v-3"/>' +
      '<path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    var s = btn.style;
    s.position = "fixed";
    s.top = "14px";
    s.right = "14px";
    s.zIndex = "9990"; // above the canvas, below boot-splash/error overlays
    s.width = "44px";
    s.height = "44px";
    s.display = "flex";
    s.alignItems = "center";
    s.justifyContent = "center";
    s.padding = "0";
    s.margin = "0";
    s.border = "1px solid rgba(255,255,255,0.25)";
    s.borderRadius = "10px";
    s.background = "rgba(0,0,0,0.55)";
    s.color = "#e9e6da";
    s.cursor = "pointer";
    s.opacity = "0";
    s.transition = "opacity 0.3s ease";
    s.webkitTapHighlightColor = "transparent";
    s.touchAction = "manipulation";

    document.body.appendChild(btn);
    // Fade in on the next frame so the transition runs.
    requestAnimationFrame(function () {
      btn.style.opacity = "1";
    });

    var timer = null;
    function teardown() {
      if (!_fsBtnDismiss) return; // already torn down
      _fsBtnDismiss = null;
      if (timer) clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      btn.style.opacity = "0";
      setTimeout(function () {
        if (btn.parentNode) btn.parentNode.removeChild(btn);
      }, 350);
    }
    _fsBtnDismiss = teardown;

    function onKey() {
      teardown();
    }

    // Tapping the button is the gesture that enters fullscreen. Stop the
    // touch/click from leaking to the canvas / TouchInput / MouseControl
    // (overlay-gating: HTML overlays must swallow their own pointer events).
    function activate(e) {
      e.preventDefault();
      e.stopPropagation();
      _fsToggle();
      teardown();
    }
    btn.addEventListener("click", activate);
    btn.addEventListener(
      "touchstart",
      function (e) {
        e.stopPropagation();
      },
      { passive: false },
    );

    document.addEventListener("keydown", onKey, true);
    timer = setTimeout(teardown, 5000);
  }

  // Replace the stock _setupEventHandlers for two reasons:
  //   1. {passive: false} on the wheel listener: Chrome treats document-level
  //      wheel listeners as passive by default, blocking _onWheel's
  //      preventDefault() and spamming the console on every scroll.
  //   2. Indirect-lookup wrappers (instead of .bind(this)) so later plugin
  //      reassignment of TouchInput._onTouchStart / _onMouseDown / etc.
  //      takes effect on the live listeners. .bind() captures the function
  //      value at setup time, so plugins like MouseControl that reassign
  //      these methods afterwards have no effect on the stock listener,
  //      causing both the stock (immediate-trigger) and the plugin's
  //      (deferred-trigger) paths to fire on every touch.
  // This must run before SceneManager.initInput() (triggered on window.onload
  // via main.js), so it's patched eagerly here rather than in applyPatches
  // (which runs at Scene_Boot.start, too late).
  if (typeof TouchInput !== "undefined" && typeof Utils !== "undefined") {
    TouchInput._setupEventHandlers = function () {
      var isSupportPassive = Utils.isSupportPassiveEvent();
      var passiveFalse = isSupportPassive ? { passive: false } : false;
      var T = TouchInput;
      document.addEventListener("mousedown", function (e) {
        T._onMouseDown(e);
      });
      document.addEventListener("mousemove", function (e) {
        T._onMouseMove(e);
      });
      document.addEventListener("mouseup", function (e) {
        T._onMouseUp(e);
      });
      document.addEventListener(
        "wheel",
        function (e) {
          T._onWheel(e);
        },
        passiveFalse,
      );
      document.addEventListener(
        "touchstart",
        function (e) {
          T._onTouchStart(e);
        },
        passiveFalse,
      );
      document.addEventListener(
        "touchmove",
        function (e) {
          T._onTouchMove(e);
        },
        passiveFalse,
      );
      document.addEventListener("touchend", function (e) {
        T._onTouchEnd(e);
      });
      document.addEventListener("touchcancel", function (e) {
        T._onTouchCancel(e);
      });
      document.addEventListener("pointerdown", function (e) {
        T._onPointerDown(e);
      });
    };
  }

  function isPluginActive(modId) {
    return _activePlugins.indexOf(modId) >= 0;
  }

  function setPluginActive(modId, active) {
    var idx = _activePlugins.indexOf(modId);
    if (active && idx < 0) {
      _activePlugins.push(modId);
    } else if (!active && idx >= 0) {
      _activePlugins.splice(idx, 1);
    }
    try {
      localStorage.setItem("_activePlugins", JSON.stringify(_activePlugins));
    } catch (e) {}
  }

  function loadPluginMod(pluginId, callback) {
    var modEntry = _modsData && _modsData[pluginId];
    var allFiles = modEntry && modEntry.files;
    if (!allFiles) {
      if (callback) callback();
      return;
    }

    var jsFiles = [];
    for (var i = 0; i < allFiles.length; i++) {
      if (/^js\/plugins\/.*\.js$/i.test(allFiles[i])) {
        jsFiles.push(allFiles[i]);
      }
    }
    if (jsFiles.length === 0) {
      if (callback) callback();
      return;
    }

    var basePath = modEntry.path || "mods/" + pluginId;
    var remaining = jsFiles.length;

    function done() {
      remaining--;
      if (remaining <= 0 && callback) callback();
    }

    function execScript(text) {
      try {
        var script = document.createElement("script");
        script.type = "text/javascript";
        script.textContent = text;
        document.body.appendChild(script);
      } catch (ex) {
        console.warn("[lang-shim] Failed to exec plugin script:", ex);
      }
    }

    // Built-in plugins (path starts with "mods/_") are shipped with the app
    // and should always be fetched from the network so updates take effect
    // without requiring the user to erase and reinstall.
    var builtIn = basePath.indexOf("mods/_") === 0;

    for (var j = 0; j < jsFiles.length; j++) {
      (function (relPath) {
        var idbKey = "mod:" + pluginId + ":" + relPath;

        function fetchFromNetwork() {
          var url = "/" + basePath + "/www/" + relPath;
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 400) {
              execScript(xhr.responseText);
            }
            done();
          };
          xhr.onerror = function () {
            done();
          };
          xhr.send();
        }

        if (builtIn) {
          fetchFromNetwork();
          return;
        }

        openAssetsDb(function (db) {
          if (!db) {
            fetchFromNetwork();
            return;
          }
          getAssetMain(db, idbKey, function (data) {
            if (data) {
              var text =
                typeof data === "string"
                  ? data
                  : new TextDecoder().decode(
                      data instanceof ArrayBuffer ? new Uint8Array(data) : data,
                    );
              execScript(text);
              done();
            } else {
              fetchFromNetwork();
            }
          });
        });
      })(jsFiles[j]);
    }
  }

  function loadActivePlugins() {
    for (var i = 0; i < _activePlugins.length; i++) {
      var pid = _activePlugins[i];
      // Fail-safe: never inject a base-game-only plugin's script while a
      // non-translation overhaul owns the dataset. setActiveMod is supposed
      // to prune _activePlugins before reloading, but if the manifest grew
      // a new requiresBaseGame flag between sessions (or _modsData wasn't
      // available at the prior setActiveMod call) the stale entry survives.
      if (!isModAvailable(pid)) continue;
      loadPluginMod(pid);
    }
  }

  // Notify SW of active mod + language on page load
  if (navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(function () {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "setActiveMod",
          id: _activeMod || null,
        });
        navigator.serviceWorker.controller.postMessage({
          type: "setActiveLang",
          id: _activeLang || null,
        });
      }
    });
  }

  // Eagerly download the active context's translations so the Language menu
  // works fully offline and switching is instant. Installing an overhaul (or,
  // for the base game, the next online boot) pulls every file of every
  // language under "<MOD>_translations" into IDB via the normal installMod
  // path. This also catches users who installed mods before this update: the
  // next online launch fills in their context's missing translations.
  //
  // Runs in the background (sequential to avoid hammering the host) and is
  // idempotent: already-installed up-to-date languages are skipped.
  var _translationsSyncing = {};
  /**
   * Eagerly install every translation belonging to MOD code `ctxMod` (e.g.
   * "BASE", "TCOAAR") that isn't already installed and up to date. Background,
   * sequential, idempotent. `ctxMod` defaults to the active context.
   */
  function ensureTranslationsFor(ctxMod) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (!_modsData) return;
    ctxMod = ctxMod || getActiveContextMod();
    if (_translationsSyncing[ctxMod]) return;
    var keys = Object.keys(_modsData);
    var queue = [];
    for (var i = 0; i < keys.length; i++) {
      var e = _modsData[keys[i]];
      if (
        e &&
        isTranslationType(e.type) &&
        (e.mod || "BASE") === ctxMod &&
        e.files &&
        e.files.length > 0
      ) {
        queue.push(keys[i]);
      }
    }
    if (!queue.length) return;
    _translationsSyncing[ctxMod] = true;
    function next() {
      if (!queue.length) {
        _translationsSyncing[ctxMod] = false;
        return;
      }
      var key = queue.shift();
      var entry = _modsData[key];
      checkModInstalled(key, function (installed, meta) {
        var curVer = entry.version || "";
        var versionOk = !curVer || !meta || meta.version === curVer;
        // The .csv/.txt translator formats are parsed locally into the cached
        // CLD; if the parser has since improved (LANG_PARSE_VERSION bumped) the
        // download is fine but the cache is stale.
        var canReparse = /\.(csv|txt)$/i.test(entry.langFile || "");
        var parseStale =
          canReparse &&
          (!meta || (meta.langParseVersion || 0) < LANG_PARSE_VERSION);
        if (installed && versionOk && !parseStale) {
          next();
          return;
        }
        // Content is current but parsed by an older parser: re-parse the file
        // already in IDB instead of re-downloading the whole translation.
        if (installed && versionOk && parseStale) {
          reextractModLangData(key, function () {
            next();
          });
          return;
        }
        installMod(
          key,
          entry.path,
          function () {},
          function () {
            next();
          },
          function () {
            next();
          },
        );
      });
    }
    next();
  }

  /**
   * The base-game translation that backs an overhaul translation: ids are
   * "translation_<MOD>_<lang>" (MOD has no underscore, <lang> is a dash-slug).
   * A translation that targets an overhaul (MOD != "BASE") usually only covers
   * the mod's own text, so the base game's own translation for the SAME language
   * ("translation_BASE_<lang>") is layered underneath by the SW to translate the
   * original game lines. Returns null for a base translation or non-translation.
   * Mirrors baseFallbackLangId() in sw.js.
   */
  function baseFallbackLangId(langId) {
    if (!langId) return null;
    var m = /^translation_([^_]+)_(.+)$/.exec(langId);
    if (!m || m[1] === "BASE") return null;
    return "translation_BASE_" + m[2];
  }

  /**
   * Ensure the base-game translation that backs the given overhaul translation
   * is installed (so the SW's fallback layer has data). No-op when the language
   * has no base fallback, the entry is unavailable, it's already current, or
   * we're offline. Invokes done() either way.
   */
  function ensureBaseFallbackInstalled(langId, done) {
    done = done || function () {};
    var baseId = baseFallbackLangId(langId);
    if (!baseId) {
      done();
      return;
    }
    var entry = _modsData && _modsData[baseId];
    if (!entry || !entry.files || entry.files.length === 0) {
      done();
      return;
    }
    checkModInstalled(baseId, function (installed, meta) {
      var curVer = entry.version || "";
      var versionOk = !curVer || !meta || meta.version === curVer;
      // .csv/.txt formats are parsed locally into the cached CLD; a bumped
      // LANG_PARSE_VERSION means the file is current but the cache is stale.
      var canReparse = /\.(csv|txt)$/i.test(entry.langFile || "");
      var parseStale =
        canReparse &&
        (!meta || (meta.langParseVersion || 0) < LANG_PARSE_VERSION);
      if (installed && versionOk && !parseStale) {
        done();
        return;
      }
      if (installed && versionOk && parseStale) {
        reextractModLangData(baseId, function () {
          done();
        });
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        done();
        return;
      }
      installMod(
        baseId,
        entry.path,
        function () {},
        function () {
          done();
        },
        function () {
          done();
        },
      );
    });
  }

  /** Sync the active context's translations (base game + already-active mod). */
  function ensureContextTranslations() {
    ensureTranslationsFor(getActiveContextMod());
    // When an overhaul translation is active, also pull the matching base-game
    // translation so the SW can translate the original game lines it leaves
    // uncovered (instead of falling back to English).
    ensureBaseFallbackInstalled(_activeLang);
  }

  // Re-attempt the sync when connectivity returns (e.g. first launch was
  // offline, or the host was briefly unreachable).
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", function () {
      ensureContextTranslations();
    });
  }

  // Mod installation (same-origin fetch from /mods/{id}/)

  /**
   * After mod installation, extract language data from the mod's langFile
   * (if specified in mods.json) and cache as __mod_lang_data__:{modId}.
   * This lets the SW serve /lang-data.json for the mod without parsing at runtime.
   *
   * Accepted formats:
   *   - .loc / .json  plain JSON CLD (linesLUT/labelLUT/sysMenus/sysLabel)
   *   - CLD binary    "LANGDATA" + JSON
   *   - .csv          TCOAAL translator dialogue.csv (parsed to CLD schema)
   *   - .txt          TCOAAL translator dialogue.txt (parsed to CLD schema)
   */
  /**
   * The dialogue file to actually parse for a mod. Normally modEntry.langFile,
   * but if that path isn't among the files the mod ships (a mods.json drift we
   * have hit before: langFile left at "dialogue.txt" after files switched to
   * "dialogue.csv"), fall back to a dialogue.* that IS shipped, preferring
   * csv > txt > loc/pld. Keeps a stale langFile from silently loading an
   * orphaned/absent source.
   */
  function resolveEffectiveLangFile(modEntry) {
    var langFile = modEntry && modEntry.langFile;
    var files = (modEntry && modEntry.files) || [];
    if (langFile && files.indexOf(langFile) >= 0) return langFile;
    var prefs = [
      /(^|\/)dialogue\.csv$/i,
      /(^|\/)dialogue\.txt$/i,
      /(^|\/)dialogue\.(loc|pld)$/i,
    ];
    for (var p = 0; p < prefs.length; p++) {
      for (var i = 0; i < files.length; i++) {
        if (prefs[p].test(files[i])) return files[i];
      }
    }
    return langFile || null;
  }

  function extractModLangData(db, modId, modEntry, callback) {
    var langFile = resolveEffectiveLangFile(modEntry);
    if (!langFile) {
      callback();
      return;
    }

    var idbKey = "mod:" + modId + ":" + langFile;
    var tx = db.transaction(ASSETS_STORE, "readonly");
    var req = tx.objectStore(ASSETS_STORE).get(idbKey);
    req.onsuccess = function () {
      if (!req.result) {
        callback();
        return;
      }
      try {
        var raw = req.result;
        var text;
        if (typeof raw === "string") {
          text = raw;
        } else if (raw instanceof ArrayBuffer) {
          text = new TextDecoder().decode(raw);
        } else if (raw.buffer instanceof ArrayBuffer) {
          text = new TextDecoder().decode(raw);
        } else {
          callback();
          return;
        }

        var isCsv = /\.csv$/i.test(langFile);
        var isTxt = /\.txt$/i.test(langFile);
        var parsed;
        var json;
        if (isCsv) {
          parsed = parseDialogueCsv(text);
          json = JSON.stringify(parsed);
        } else if (isTxt) {
          parsed = parseDialogueTxt(text);
          json = JSON.stringify(parsed);
        } else {
          // Strip leading padding/prefix before JSON.
          // .loc files start with 20+ spaces before the JSON.
          // CLD files (e.g. data/dialogues) start with "LANGDATA{...".
          json = text.trim();
          var jsonStart = json.indexOf("{");
          if (jsonStart > 0) json = json.substring(jsonStart);
          parsed = JSON.parse(json);
        }
        if (parsed && (parsed.linesLUT || parsed.labelLUT || parsed.sysMenus)) {
          putAsset(db, "__mod_lang_data__:" + modId, json, function () {
            callback();
          });
          return;
        }
      } catch (e) {
        console.warn("[lang-shim] Failed to extract mod lang data:", e);
      }
      callback();
    };
    req.onerror = function () {
      callback();
    };
  }

  /**
   * Re-parse an already-installed translation's langFile (still in IDB from a
   * prior install) into the __mod_lang_data__ cache, without re-downloading.
   * Used when LANG_PARSE_VERSION bumps: the file content is unchanged but the
   * parser that produces the cached CLD has improved, so we just re-run it and
   * stamp the new langParseVersion. Works offline.
   */
  function reextractModLangData(modId, callback) {
    var modEntry = _modsData && _modsData[modId];
    if (!modEntry || !modEntry.langFile) {
      if (callback) callback();
      return;
    }
    openAssetsDb(function (db) {
      if (!db) {
        if (callback) callback();
        return;
      }
      extractModLangData(db, modId, modEntry, function () {
        getAssetMain(db, "__mod_meta__:" + modId, function (val) {
          var meta = {};
          try {
            if (val) meta = typeof val === "string" ? JSON.parse(val) : val;
          } catch (e) {
            meta = {};
          }
          meta.langParseVersion = LANG_PARSE_VERSION;
          putAsset(
            db,
            "__mod_meta__:" + modId,
            JSON.stringify(meta),
            function () {
              if (callback) callback();
            },
          );
        });
      });
    });
  }

  // Install counts shown in the Mods menu, keyed by mod id. null until the
  // first load resolves; the menu simply draws no count while it is null, so
  // a slow or failed fetch costs nothing but the label.
  var _installCounts = null;
  // Read exactly once per session. After a successful load the number is kept
  // live purely locally: trackModInstall does a +1 on the install it just
  // performed, so re-reading the API would only spend a request to redraw a
  // number we already track. These flags coalesce concurrent callers onto the
  // single fetch and make every later call (each Mods menu open) a no-op.
  var _installCountsLoaded = false;
  var _installCountsInFlight = false;
  var _installCountsWaiters = [];
  var INSTALL_COUNTS_KEY = "__install_counts__";
  // Mods this browser has already counted. Deliberately NOT cleared by
  // uninstallMod: surviving an uninstall is the whole point.
  var COUNTED_MODS_KEY = "_countedMods";

  /** Mod ids this browser has already counted an install for. */
  function countedMods() {
    try {
      var raw = localStorage.getItem(COUNTED_MODS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(list) === "[object Array]"
        ? list
        : [];
    } catch (e) {
      return [];
    }
  }

  function hasCountedInstall(modId) {
    return countedMods().indexOf(modId) >= 0;
  }

  function markCountedInstall(modId) {
    try {
      var list = countedMods();
      if (list.indexOf(modId) >= 0) return;
      list.push(modId);
      localStorage.setItem(COUNTED_MODS_KEY, JSON.stringify(list));
    } catch (e) {
      // Private mode / quota: worst case we count this mod again later.
    }
  }

  /** Undo markCountedInstall after a POST we saw fail. */
  function unmarkCountedInstall(modId) {
    try {
      var list = countedMods();
      var i = list.indexOf(modId);
      if (i < 0) return;
      list.splice(i, 1);
      localStorage.setItem(COUNTED_MODS_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  /**
   * Count one install of modId, at most once per browser. Fire-and-forget POST
   * to the counter Worker (worker/src/index.js), which validates the id,
   * rate-limits per IP and upserts one D1 row.
   *
   * Counting once per browser (rather than once per install) makes the number
   * "how many people run this" instead of "how many times a file moved", which
   * is what the Mods menu is really asking. For remote mods only the
   * `!installed` install action feeds this; built-in plugins ship with the app
   * and have no install step, so their FIRST ENABLE feeds it instead (see the
   * Scene_Mods built-in-plugin branch), the same way a translation is counted
   * at first activation. Switching overhauls never counts. What this de-dupes
   * is re-enabling, uninstall -> reinstall, and version updates.
   *
   * Trivially cheatable by clearing site data, which is fine: that is effort,
   * and these are popularity figures, not audited ones.
   *
   * Two different events feed this, because "install" means different things:
   *   - mods/plugins: the Mods menu install, which the user chose.
   *   - translations: FIRST ACTIVATION (Scene_Lang), not the download. Every
   *     translation for the active context is fetched automatically
   *     (ensureTranslationsFor / ensureContextTranslations), so a translation's
   *     download only proves the app ran online once, and counting it would
   *     report the same number for all 20 languages.
   *
   * Never call this from the automatic pulls themselves
   * (ensureTranslationsFor / ensureBaseFallbackInstalled).
   *
   * Best-effort by design: the install already succeeded by the time we get
   * here, so nothing this does may surface an error to the caller. keepalive
   * lets the POST outlive a scene change or reload.
   */
  function trackModInstall(modId) {
    try {
      if (!modId) return;
      if (typeof fetch !== "function") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }
      if (hasCountedInstall(modId)) return;
      // Mark BEFORE the POST resolves, and roll back only on a failure we
      // actually observe. Marking in .then() would never run on the language
      // path: activation calls location.reload() immediately, killing the page
      // before the response lands, so every re-activation would recount. The
      // POST itself still goes out (keepalive), so an unobserved outcome is
      // overwhelmingly a success: assume it, and correct only what we see.
      markCountedInstall(modId);
      // Reflect it locally so the row's count updates immediately (via the
      // refresh the install triggers) instead of waiting out the client memo
      // and the Worker's edge cache. Include a first-ever install (no row yet
      // -> 1): the user just performed it, so "1 install" on their own row is
      // truthful, not a lonely invention. Suppress only when counts never
      // loaded (_installCounts null), where a bare number would mislead.
      if (_installCounts) {
        var cur =
          typeof _installCounts[modId] === "number" ? _installCounts[modId] : 0;
        _installCounts[modId] = cur + 1;
      }
      fetch("/api/dl/" + encodeURIComponent(modId), {
        method: "POST",
        keepalive: true,
      })
        .then(function (res) {
          // Roll back ONLY on a response we actually received that says no
          // (403/429/5xx), so a later attempt can still count this user.
          // Silently never counting somebody is worse than a rare double count.
          if (res && res.ok) return;
          unmarkCountedInstall(modId);
          if (_installCounts && typeof _installCounts[modId] === "number") {
            _installCounts[modId]--;
          }
        })
        .catch(function () {
          // Deliberately NOT a rollback. A rejected fetch here does not mean
          // the POST failed: the language path reloads the page immediately,
          // which aborts this promise while `keepalive` still delivers the
          // request. Rolling back would then un-mark exactly the case the
          // pre-marking exists for, and every re-activation would recount.
        });
    } catch (e) {
      // Never let counting break an install that already worked.
    }
  }

  // One-time migration for users who adopted mods BEFORE install counting
  // existed: their active overhaul, enabled plugins, active language and any
  // downloaded (installed) mods were never counted. On the next few online
  // boots, count each once so the totals reflect the real installed base.
  //
  // Safe to run repeatedly: trackModInstall de-dupes per browser via
  // _countedMods, so anything already counted (including everything installed
  // AFTER this update) is an instant no-op. The tries cap only bounds the
  // background IDB scan and gives rate-limited (429) POSTs a couple of
  // retries -- a per-IP limiter can defer a user with many mods, and those
  // roll back in _countedMods, so a later boot picks them up. After the cap
  // we stop: these are popularity figures, and a rare off-by-one for a power
  // user with several overhauls is acceptable (see trackModInstall).
  var INSTALL_BACKFILL_KEY = "_countBackfillTries";
  var INSTALL_BACKFILL_MAX_TRIES = 3;

  function backfillInstallCounts() {
    // Offline: counting is meaningless and would waste a try. Retry next boot.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    var tries = 0;
    try {
      tries = parseInt(localStorage.getItem(INSTALL_BACKFILL_KEY) || "0", 10);
    } catch (e) {}
    if (!(tries >= 0)) tries = 0;
    if (tries >= INSTALL_BACKFILL_MAX_TRIES) return;

    // Active adoptions, known without touching IDB. getActiveMod() is the
    // active overhaul (null for base game); guard against a stray translation
    // id so a language is only ever counted via _activeLang below (as a
    // "user", matching the activation-not-download rule in trackModInstall).
    var am = getActiveMod();
    if (am && !isTranslationModId(am)) trackModInstall(am);
    for (var i = 0; i < _activePlugins.length; i++) {
      trackModInstall(_activePlugins[i]);
    }
    if (_activeLang) trackModInstall(_activeLang);

    // Downloaded-but-maybe-inactive overhauls/plugins. getModList() excludes
    // translations, so auto-fetched languages are never counted here -- only
    // the active one above. fetchAllModStatus fills _modStatus from IDB.
    fetchAllModStatus(function () {
      var mods = getModList();
      for (var j = 0; j < mods.length; j++) {
        var k = mods[j].key;
        if (_modStatus[k] && _modStatus[k].installed) trackModInstall(k);
      }
      // Only spend a try once we actually had the list to scan, so a boot
      // where _modsData was not ready yet doesn't burn an attempt (or worse,
      // permanently skip the installed set).
      if (mods.length > 0) {
        try {
          localStorage.setItem(INSTALL_BACKFILL_KEY, String(tries + 1));
        } catch (e) {}
      }
    });
  }

  /**
   * "1,204 installs", or "1,204 users" for a translation.
   *
   * The noun follows what was actually counted (see trackModInstall): a mod is
   * counted when the user installs it, but a translation's download is
   * automatic and meaningless, so it is counted at first activation instead.
   * "installs" would be a lie there (nobody chose to install it), while
   * "users" is exactly what an activation records.
   */
  function formatInstallCount(n, type) {
    var s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (isTranslationType(type)) return s + (n === 1 ? " user" : " users");
    return s + (n === 1 ? " install" : " installs");
  }

  /** The count to draw for a mod, or null when we have nothing to show. */
  function installCountFor(modId) {
    if (!_installCounts) return null;
    var n = _installCounts[modId];
    // Draw only a genuine, positive count. A row absent from the counts is
    // undefined; a POST rollback can drive an optimistic bump back down to 0.
    // Either way there is nothing worth showing, so fall back to no label
    // rather than "0 installs".
    return typeof n === "number" && n > 0 ? n : null;
  }

  /**
   * Load every mod's install count from the counter Worker ONCE per session,
   * falling back to the last set cached in IDB when offline or the Worker is
   * down. After a successful read the counts stay in memory and are kept live
   * by trackModInstall's local +1; callers (each Mods menu open) reuse them
   * with no further network. A failed load leaves _installCountsLoaded false so
   * a later call can retry (e.g. offline at boot, online by the first menu
   * open).
   *
   * done() runs whether or not anything was found: callers just redraw. When a
   * fetch is already in flight, done is queued and fired when it settles, so
   * two near-simultaneous callers (boot warm-load + menu open) still make a
   * single request.
   */
  function loadInstallCounts(done) {
    done = done || function () {};
    if (_installCountsLoaded) {
      done();
      return;
    }
    _installCountsWaiters.push(done);
    if (_installCountsInFlight) return;
    _installCountsInFlight = true;

    // Fire every queued caller's done() once, then clear the queue. `loaded`
    // records whether the network read actually succeeded: only then do we
    // stop reading for the rest of the session.
    var settle = function (loaded) {
      _installCountsInFlight = false;
      if (loaded) _installCountsLoaded = true;
      var waiters = _installCountsWaiters;
      _installCountsWaiters = [];
      for (var i = 0; i < waiters.length; i++) {
        try {
          waiters[i]();
        } catch (e) {}
      }
    };

    var fromCache = function (loaded) {
      openAssetsDb(function (db) {
        if (!db) {
          settle(loaded);
          return;
        }
        getAssetMain(db, INSTALL_COUNTS_KEY, function (raw) {
          if (raw) {
            try {
              _installCounts = JSON.parse(raw);
            } catch (e) {}
          }
          settle(loaded);
        });
      });
    };

    if (typeof fetch !== "function") {
      fromCache(false);
      return;
    }

    var ctrl =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    var tid = ctrl
      ? setTimeout(function () {
          ctrl.abort();
        }, 5000)
      : null;
    // no-store, not the browser default: the response is Cache-Control
    // max-age=60, but a stale empty {} from before D1 had any rows was being
    // served from the browser HTTP cache well past that (verified: a default
    // fetch returned {} while a no-store fetch returned live data -- the cached
    // entry keeps whatever headers an earlier Worker stored it under). Reading
    // it stale then writes {} back over the IDB fallback, so the menu shows no
    // counts. Bypass the browser cache entirely: Cloudflare's edge cache
    // (s-maxage) is what shields D1, and we read only once per session anyway.
    // This also self-heals users who cached the empty {}: the read skips it.
    var opts = { cache: "no-store" };
    if (ctrl) opts.signal = ctrl.signal;

    fetch("/api/dl", opts)
      .then(function (res) {
        if (tid) clearTimeout(tid);
        if (!res.ok) throw new Error(res.status);
        return res.json();
      })
      .then(function (data) {
        _installCounts = data || {};
        openAssetsDb(function (db) {
          if (db)
            putAsset(db, INSTALL_COUNTS_KEY, JSON.stringify(_installCounts));
          settle(true);
        });
      })
      .catch(function () {
        if (tid) clearTimeout(tid);
        // Offline, Worker down, or not deployed yet: show the last numbers we
        // saw rather than nothing, and stay "unloaded" so a later call retries.
        fromCache(false);
      });
  }

  function installMod(modId, basePath, onProgress, onDone, onError) {
    if (!basePath) {
      if (onError) onError("No mod path configured");
      return;
    }

    var modEntry = _modsData && _modsData[modId];
    var files = modEntry && modEntry.files;
    if (!files || files.length === 0) {
      if (onError) onError("No file list in mods.json for " + modId);
      return;
    }

    var version = (modEntry && modEntry.version) || "";
    var total = files.length;
    var stored = 0;
    var errors = 0;
    // Remote-hosted mods (translations) give an absolute URL as their path
    // and serve files directly under that URL. Local mods keep the www/ layout.
    var wwwBase = isRemotePath(basePath)
      ? basePath.replace(/\/$/, "") + "/"
      : "/" + basePath + "/www/";

    onProgress({ percent: 0, message: "Installing... 0%" });

    openAssetsDb(function (db) {
      if (!db) {
        if (onError) onError("Cannot open IndexedDB");
        return;
      }

      var BATCH_SIZE = 6;
      var queue = files.slice();

      function processBatch() {
        if (queue.length === 0 && stored + errors >= total) {
          if (stored === 0) {
            if (onError) onError("Check your connection");
            return;
          }
          var meta = JSON.stringify({
            version: version,
            date: new Date().toISOString().substring(0, 10),
            files: stored,
            langParseVersion: LANG_PARSE_VERSION,
          });
          putAsset(db, "__mod_meta__:" + modId, meta, function () {
            // Purge files this (re)install no longer ships so a stale source
            // (e.g. an old dialogue.txt after a switch to dialogue.csv) can't
            // be re-parsed into an outdated lang cache. Build the keep
            // set from the current file list.
            var keepSet = {};
            for (var ki = 0; ki < files.length; ki++) keepSet[files[ki]] = 1;
            deleteOrphanModFiles(db, modId, keepSet, function () {
              // Extract and cache mod lang data if langFile is specified
              extractModLangData(db, modId, modEntry, function () {
                onProgress({ percent: 100, message: "Installed!" });
                _modStatus[modId] = { installed: true, version: version };
                if (onDone) onDone({ version: version });
              });
            });
          });
          return;
        }

        var batch = queue.splice(0, BATCH_SIZE);
        var pending = batch.length;

        for (var i = 0; i < batch.length; i++) {
          (function (relPath) {
            var ctrl = new AbortController();
            var tid = setTimeout(function () { ctrl.abort(); }, 10000);
            fetch(wwwBase + relPath, { signal: ctrl.signal })
              .then(function (res) {
                clearTimeout(tid);
                if (!res.ok) throw new Error(res.status);
                return res.arrayBuffer();
              })
              .then(function (buf) {
                putAsset(
                  db,
                  "mod:" + modId + ":" + relPath,
                  buf,
                  function (putErr) {
                    if (putErr) {
                      console.warn(
                        "[lang-shim] IDB write failed for:",
                        relPath,
                        putErr,
                      );
                      errors++;
                    } else {
                      stored++;
                      var pct = Math.floor((stored / total) * 98);
                      if (stored % 20 === 0 || stored === total) {
                        onProgress({
                          percent: pct,
                          message: "Installing... " + pct + "%",
                        });
                      }
                    }
                    pending--;
                    if (pending <= 0) processBatch();
                  },
                );
              })
              .catch(function () {
                clearTimeout(tid);
                errors++;
                pending--;
                if (pending <= 0) processBatch();
              });
          })(batch[i]);
        }
      }

      processBatch();
    });
  }

  function uninstallMod(modId, callback) {
    openAssetsDb(function (db) {
      if (!db) {
        if (callback) callback("Cannot open IndexedDB");
        return;
      }
      deleteAssetsByPrefix(db, "mod:" + modId + ":", function (count) {
        deleteAsset(db, "__mod_meta__:" + modId, function () {
          delete _modStatus[modId];
          if (getActiveMod() === modId) setActiveMod(null);
          // If this was an imported (custom) mod, drop it from the registry too
          // so it no longer appears in the Mods menu. Its save scope ({tag}:)
          // is intentionally left intact, so a later re-import keeps the saves.
          if (_importedMods && _importedMods[modId]) {
            delete _importedMods[modId];
            if (_modsData) delete _modsData[modId];
            putAsset(
              db,
              IMPORTED_MODS_KEY,
              JSON.stringify(_importedMods),
              function () {
                if (callback) callback(null, count);
              },
            );
          } else if (callback) {
            callback(null, count);
          }
        });
      });
    });
  }

  // Update a mod's installed/commit fields WITHOUT discarding the object, so
  // any transient in-flight-download state on it (_downloading, _percent,
  // _percentShown, _progress, _error -- set by the install flow) survives a
  // status refresh. Rebuilding the object here was the bug behind a background
  // download reading as "Not installed" on re-entry to the Mods menu, which in
  // turn re-opened the install gate and let a second, racing download start.
  function setModInstalledState(modId, installed, commit) {
    var st = _modStatus[modId] || (_modStatus[modId] = {});
    st.installed = installed;
    st.commit = commit || "";
    return st;
  }

  function checkModInstalled(modId, callback) {
    openAssetsDb(function (db) {
      if (!db) {
        callback(false, null);
        return;
      }
      getAssetMain(db, "__mod_meta__:" + modId, function (val) {
        if (val) {
          try {
            var meta = typeof val === "string" ? JSON.parse(val) : val;
            setModInstalledState(modId, true, meta.commit || "");
            callback(true, meta);
          } catch (e) {
            setModInstalledState(modId, true, "");
            callback(true, null);
          }
        } else {
          setModInstalledState(modId, false, "");
          callback(false, null);
        }
      });
    });
  }

  function fetchAllModStatus(callback) {
    var mods = getModList();
    var remaining = mods.length;
    if (remaining === 0) {
      if (callback) callback();
      return;
    }
    for (var i = 0; i < mods.length; i++) {
      (function (mod) {
        checkModInstalled(mod.key, function () {
          remaining--;
          if (remaining <= 0 && callback) callback();
        });
      })(mods[i]);
    }
  }

  /** Default mod icon: sprite from img/characters/!Other1.png, row 7 col 9. */
  var _defaultModIconBmp = null;

  function getDefaultModIcon() {
    return _defaultModIconBmp;
  }

  function loadDefaultModIcon() {
    if (typeof ImageManager === "undefined") return;
    var sheet = ImageManager.loadCharacter("!Other1");
    _defaultModIconBmp = new Bitmap(1, 1);
    var icon = _defaultModIconBmp;
    sheet.addLoadListener(function () {
      var pw = Math.floor(sheet.width / 12);
      var ph = Math.floor(sheet.height / 8);
      var sx = 8 * pw;
      var sy = 6 * ph;
      icon.resize(pw, ph);
      icon.blt(sheet, sx, sy, pw, ph, 0, 0);
      icon._loadingState = "loaded";
      icon._callLoadListeners();
    });
  }

  // Deferred patching: applied at Scene_Boot.start so all plugins
  // (including DRM payload) are already loaded.

  var _patchesApplied = false;

  function applyPatches() {
    if (_patchesApplied) return;
    _patchesApplied = true;

    // Register extra keys in Input.keyMapper
    if (typeof Input !== "undefined") {
      Input.keyMapper[18] = "alt"; // Alt key
      Input.keyMapper[46] = "delete"; // Delete key
      Input.keyMapper[79] = "saveExport"; // O key
      Input.keyMapper[73] = "saveImport"; // I key
      Input.keyMapper[78] = "annotate"; // N key (edit save note)
      Input.keyMapper[80] = "saveExportGlobal"; // P key (Continue menu only)
    }

    // Mobile: enlarge command-window items so taps land easily.
    // Stock lineHeight is 36; bump to 54 (~1.5x) for ~54px touch targets,
    // above the 44pt iOS / 48dp Android minimums. Every Window_Command
    // subclass (TitleCommand, MenuCommand, Options, ChoiceList,
    // PartyCommand, ActorCommand, GameEnd, plus our SaveConfirm /
    // SaveInfo / ModConfirm) inherits this; itemRect / fittingHeight grow
    // proportionally, so layouts remain centered without further work.
    // Window_ModList sizes itself from a fixed maxVisibleItems and is
    // unaffected. Selectable lists (save slots, item/skill lists) keep
    // their stock sizing: they're already large enough to tap.
    if (_isMobile && typeof Window_Command !== "undefined") {
      Window_Command.prototype.lineHeight = function () {
        return 54;
      };
    }

    // Load default mod icon
    loadDefaultModIcon();

    if (typeof StorageManager !== "undefined") {
      // webStorageKey is already patched in the IIFE (before DRM) when an
      // overhaul scope is active at boot. Re-apply here when it wasn't, so
      // base-game / translation-mode boots are still able to switch to an
      // overhaul mid-session and have their saves correctly scoped.
      if (!getActiveSaveScope()) {
        var _orig_webStorageKey = StorageManager.webStorageKey;
        StorageManager.webStorageKey = function (savefileId) {
          var baseKey = _orig_webStorageKey.call(this, savefileId);
          var scope = getActiveSaveScope();
          return scope ? scope + ":" + baseKey : baseKey;
        };
      }

      var _orig_saveToWeb = StorageManager.saveToWebStorage;
      StorageManager.saveToWebStorage = function (savefileId, json) {
        _orig_saveToWeb.call(this, savefileId, json);
        var key = this.webStorageKey(savefileId);
        var data = LZString.compressToBase64(json);
        idbSavePut(key, data);
      };

      var _orig_removeWeb = StorageManager.removeWebStorage;
      StorageManager.removeWebStorage = function (savefileId) {
        _orig_removeWeb.call(this, savefileId);
        var key = this.webStorageKey(savefileId);
        idbSaveRemove(key);
      };

      var _orig_backup = StorageManager.backup;
      StorageManager.backup = function (savefileId) {
        _orig_backup.call(this, savefileId);
        if (!this.isLocalMode() && this.exists(savefileId)) {
          var key = this.webStorageKey(savefileId) + "bak";
          var data = localStorage.getItem(key);
          if (data) idbSavePut(key, data);
        }
      };
    }

    // Stock code accesses globalInfo[i].timestamp without checking
    // whether globalInfo[i] is defined. When the DRM overrides
    // isThisGameFile it can return true for slots whose global-info
    // entry was pruned, causing a TypeError.
    if (typeof DataManager !== "undefined") {
      DataManager.latestSavefileId = function () {
        var globalInfo = this.loadGlobalInfo();
        var savefileId = 1;
        var timestamp = 0;
        if (globalInfo) {
          for (var i = 1; i < globalInfo.length; i++) {
            if (
              globalInfo[i] &&
              this.isThisGameFile(i) &&
              globalInfo[i].timestamp > timestamp
            ) {
              timestamp = globalInfo[i].timestamp;
              savefileId = i;
            }
          }
        }
        return savefileId;
      };
    }

    // Save file management: export (E), import (I), delete (DEL)
    // Works on Scene_File (parent of Scene_Save and Scene_Load) so it
    // functions in both save and load screens, respecting mod key prefixes.
    if (
      typeof Scene_File !== "undefined" &&
      typeof StorageManager !== "undefined" &&
      typeof DataManager !== "undefined"
    ) {
      // Tag every new save payload with the save-scope mod id so cross-mod
      // imports can be rejected. Native desktop saves won't carry this tag;
      // absence is treated as "base game" with a filename-prefix fallback.
      // Translation mods deliberately do NOT contribute a tag: they share
      // the base game's save scope, so a save made under French and one
      // made under English must be freely interchangeable.
      // `_modId` lives alongside system/screen/etc. in the contents object.
      // `extractSaveContents` only reads known keys, so the extra field is
      // harmless on load (desktop included).
      if (DataManager.makeSaveContents) {
        var _orig_makeSaveContents = DataManager.makeSaveContents;
        DataManager.makeSaveContents = function () {
          var contents = _orig_makeSaveContents.call(this);
          contents._modId = getActiveSaveScope() || null;
          return contents;
        };
      }

      var _orig_sceneFileUpdate = Scene_File.prototype.update;
      Scene_File.prototype.update = function () {
        _orig_sceneFileUpdate.call(this);
        if (this._annotateOpen) return;
        if (!this._listWindow || !this._listWindow.active) return;
        if (this._saveConfirmWindow && this._saveConfirmWindow.visible) return;
        // DRM payload's Scene_File.prototype.savefileId() maps list index ->
        // real savefile id, accounting for autosaves displayed at the top
        // (positive = file slot, <=0 = autosave). Stock MV's savefileId
        // returns index+1, which matches the autosave-less layout. Either
        // way this gives the correct id for the highlighted row.
        var savefileId = this.savefileId();
        if (Input.isTriggered("saveExport")) {
          this._handleSaveExport(savefileId);
        } else if (Input.isTriggered("saveImport")) {
          this._handleSaveImport(savefileId);
        } else if (Input.isTriggered("annotate")) {
          this._handleAnnotate(savefileId);
        } else if (Input.isTriggered("delete")) {
          this._handleSaveDelete(savefileId);
        } else if (
          this instanceof Scene_Load &&
          Input.isTriggered("saveExportGlobal")
        ) {
          exportGlobalSave();
        }
      };

      // Draw key hints in the help window (centered when mouse control
      // is active so Back button can sit on the right, else right-aligned)
      var _orig_sceneFileStart = Scene_File.prototype.start;
      Scene_File.prototype.start = function () {
        _orig_sceneFileStart.call(this);
        this._fileHintRects = {};
        if (this._helpWindow) {
          var hw = this._helpWindow;
          var labels = [
            { text: "[O] Export", key: "saveExport" },
            { text: "[I] Import", key: "saveImport" },
            { text: "[N] Annotate", key: "annotate" },
            { text: "[Del] Delete", key: "delete" },
          ];
          // Continue menu only: prepend a screen-level shortcut to export
          // the active mod's (or base game's) global.rpgsave. Replaces the
          // old hidden Title-screen 'O' shortcut.
          if (this instanceof Scene_Load) {
            labels.unshift({
              text: "[P] Export global",
              key: "saveExportGlobal",
            });
          }
          var separator = "   ";
          var pad = hw.standardPadding();
          hw.contents.fontSize = 16;
          hw.contents.textColor = "#888888";
          // Measure total width
          var totalW = 0;
          for (var li = 0; li < labels.length; li++) {
            totalW += hw.contents.measureTextWidth(labels[li].text);
            if (li < labels.length - 1)
              totalW += hw.contents.measureTextWidth(separator);
          }
          var startX = Math.floor((hw.contentsWidth() - totalW) / 2);
          var hy = (hw.contentsHeight() - 20) / 2;
          var curX = startX;
          for (var lj = 0; lj < labels.length; lj++) {
            var lw = hw.contents.measureTextWidth(labels[lj].text);
            hw.contents.drawText(labels[lj].text, curX, hy, lw + 4, 20);
            // Store screen-space hit rect
            this._fileHintRects[labels[lj].key] = {
              x: hw.x + pad + curX,
              y: hw.y + pad + hy,
              w: lw + 4,
              h: 20,
            };
            curX += lw;
            if (lj < labels.length - 1)
              curX += hw.contents.measureTextWidth(separator);
          }
          hw.contents.fontSize = hw.standardFontSize();
          hw.resetTextColor();
        }
        // Continue / Load menu: hide the autosaves when at least one real
        // (file) save exists: scroll so the first file slot sits at the top
        // of the view. The autosaves stay reachable by scrolling up. With no
        // file saves the autosaves are the only loadable rows, so they're left
        // in view.
        if (this instanceof Scene_Load && this._listWindow) {
          var lwAuto = this._listWindow;
          var autoTop =
            typeof DataManager.autoSaveCount === "function"
              ? DataManager.autoSaveCount()
              : 0;
          if (autoTop > 0 && this._hasNonAutoSave()) {
            lwAuto.select(autoTop);
            if (typeof lwAuto.setTopRow === "function")
              lwAuto.setTopRow(autoTop);
          }
        }
      };

      // True when any positive (file) savefile slot holds data: i.e. there's
      // something other than an autosave to load. Used to decide whether the
      // Continue/Load list scrolls past the autosaves on open.
      Scene_File.prototype._hasNonAutoSave = function () {
        if (!this._listWindow || typeof DataManager.getSaveInfo !== "function")
          return false;
        var autoCount =
          typeof DataManager.autoSaveCount === "function"
            ? DataManager.autoSaveCount()
            : 0;
        var fileSlots = this._listWindow.maxItems() - autoCount;
        for (var id = 1; id <= fileSlots; id++) {
          if (DataManager.getSaveInfo(id)) return true;
        }
        return false;
      };

      // Long-press a save row (touch / mobile parity for the [N] Annotate
      // shortcut). Held ~0.5s without drift over the list. Two-stage, so a
      // single hold is unambiguous next to "tap = load/save":
      //   - hold a row that ISN'T highlighted -> just highlight it
      //   - hold the row that's ALREADY highlighted -> open the note editor
      // Either way the gesture is consumed: MouseControl checks `_lpFired`
      // on release and suppresses the tap trigger, so the hold never also
      // loads/saves the file.
      Scene_File.prototype._pointInListWindow = function (x, y) {
        var w = this._listWindow;
        if (!w) return false;
        return (
          x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height
        );
      };
      Scene_File.prototype._updateAnnotateLongPress = function () {
        // Long-press is the touch equivalent of the [N] key; desktop uses the
        // key (and a held mouse button should not annotate).
        if (!_isMobile) {
          this._lpFrames = 0;
          return;
        }
        if (
          this._annotateOpen ||
          !this._listWindow ||
          !this._listWindow.active ||
          (this._saveConfirmWindow && this._saveConfirmWindow.visible) ||
          (this._saveInfoWindow && this._saveInfoWindow.visible)
        ) {
          this._lpFrames = 0;
          return;
        }
        if (!TouchInput.isPressed()) {
          this._lpFrames = 0;
          return;
        }
        var x = TouchInput.x,
          y = TouchInput.y;
        if (!this._lpFrames) {
          this._lpX = x;
          this._lpY = y;
          this._lpFrames = 1;
          this._lpFired = false;
          return;
        }
        // Drift cancels: the user is scrolling, not long-pressing.
        if (Math.abs(x - this._lpX) > 16 || Math.abs(y - this._lpY) > 16) {
          this._lpFrames = 0;
          return;
        }
        this._lpFrames++;
        if (
          !this._lpFired &&
          this._lpFrames >= 30 &&
          this._pointInListWindow(x, y)
        ) {
          this._lpFired = true;
          var lw = this._listWindow;
          var hit = lw.hitTest(lw.canvasToLocalX(x), lw.canvasToLocalY(y));
          if (hit >= 0 && hit !== lw.index() && lw.isCursorMovable()) {
            // First stage: the held row isn't the highlighted one yet, so
            // move the cursor onto it. The release is suppressed (see
            // MouseControl), so this is a pure select -- a second hold on
            // the now-highlighted row opens the editor.
            lw.select(hit);
            SoundManager.playCursor();
          } else {
            // Held the already-highlighted row (or empty list space): edit
            // its note.
            this._handleAnnotate(this.savefileId());
          }
        }
      };

      // Click detection for hint labels in Scene_File
      var _orig_sceneFileUpdate2 = Scene_File.prototype.update;
      Scene_File.prototype.update = function () {
        _orig_sceneFileUpdate2.call(this);
        if (this._annotateOpen) {
          this._updateNoteEdit();
          return;
        }
        this._updateAnnotateLongPress();
        if (
          isPluginActive("_mouseControl") &&
          this._fileHintRects &&
          this._listWindow &&
          this._listWindow.active &&
          !(this._saveConfirmWindow && this._saveConfirmWindow.visible) &&
          TouchInput.isTriggered()
        ) {
          var tx = TouchInput.x;
          var ty = TouchInput.y;
          var savefileId = this.savefileId();
          var rects = this._fileHintRects;
          for (var rk in rects) {
            var r = rects[rk];
            if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
              if (rk === "saveExport") this._handleSaveExport(savefileId);
              else if (rk === "saveImport") this._handleSaveImport(savefileId);
              else if (rk === "annotate") this._handleAnnotate(savefileId);
              else if (rk === "delete") this._handleSaveDelete(savefileId);
              else if (rk === "saveExportGlobal") exportGlobalSave();
              break;
            }
          }
        }
      };

      // Resolve the savefile id (positive = file slot, <=0 = autosave) to
      // its on-disk path via the DRM's StorageManager.localFilePath, which
      // for autosaves looks up the filename by index into the autoSaves
      // dict (keyed insertion-order, matching Window_SavefileList.drawItem).
      // Returns null when no file backs the id (empty slot, or autosave
      // dict shorter than the visible row count).
      function savefilePath(savefileId) {
        if (typeof StorageManager.localFilePath !== "function") return null;
        try {
          var p = StorageManager.localFilePath(savefileId);
          return p || null;
        } catch (e) {
          return null;
        }
      }

      function savefileBasename(path) {
        if (!path) return "";
        var parts = String(path).split(/[\/\\]/);
        return parts[parts.length - 1] || "";
      }

      // Annotate: edit the free-form note shown next to the episode label,
      // inline on the save row itself (no popup). Pressing [N] drops a caret
      // onto the note line of the hovered row; the player types in place and
      // presses Enter to keep the note (Esc to discard). The note is display-
      // only metadata in its own localStorage key (via window.__saveDisplay),
      // never written into the save. Committing must NOT load the game: the
      // list window is deactivated and the Enter/Esc keydown is swallowed
      // before it can reach the engine's Input handler.
      Scene_File.prototype._handleAnnotate = function (savefileId) {
        if (this._annotateOpen) return;
        var path = savefilePath(savefileId);
        if (!path || !Utils.exists(path)) {
          SoundManager.playBuzzer();
          return;
        }
        var sd = window.__saveDisplay || {};
        var episode = sd.episodeFor ? sd.episodeFor(savefileId) : "Unknown";
        var current = sd.getNote ? sd.getNote(savefileId) : "";
        // The default note is a 17-char "YY/MM/DD HH:MM:SS" timestamp, which can
        // be wider than the row's display budget (sd.noteMax). Editing must not
        // be capped below what's already stored, so give the editor enough room
        // to show and reshape the full timestamp regardless of row width.
        var maxLen = Math.max(
          sd.noteMax ? sd.noteMax(episode) : 24,
          current.length,
          24,
        );

        var lw = this._listWindow;
        this._annotateOpen = true;
        if (lw) lw.deactivate();
        SoundManager.playOk();

        this._noteEdit = {
          id: savefileId,
          index: lw ? lw.index() : 0,
          text: current,
          caret: current.length,
          scroll: 0,
          blink: 0,
          maxLen: maxLen,
          touchGuard: 18,
        };
        if (lw) {
          lw._noteEdit = this._noteEdit;
          lw.redrawItem(this._noteEdit.index);
        }
        this._createNoteInput(current, maxLen);
      };

      // Hidden, focused <input> drives native text entry (typing, paste, IME,
      // mobile soft keyboard, selection); the row renders the text + caret
      // itself. Positioned over the row's note area so the mobile keyboard /
      // IME composition anchors there and taps on it move the caret.
      Scene_File.prototype._createNoteInput = function (value, maxLen) {
        var self = this;
        var input = document.createElement("input");
        input.type = "text";
        input.value = value;
        input.maxLength = maxLen;
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("spellcheck", "false");
        // Fully invisible (opacity:0) rather than transparent colours: the row
        // renders the text + caret itself, and opacity:0 also hides the input's
        // native selection highlight (which select() below would otherwise
        // paint as a blue block over the row). Still focusable/typeable.
        input.style.cssText =
          "position:fixed;z-index:100000;margin:0;padding:0;border:0;outline:none;" +
          "background:transparent;opacity:0;";
        document.body.appendChild(input);
        this._noteInputEl = input;
        this._positionNoteInput();
        this._noteResizeHandler = function () {
          self._positionNoteInput();
        };
        window.addEventListener("resize", this._noteResizeHandler);
        // Capture keydown at the document so the engine's Input handler (and
        // the list window's "ok"/"cancel") never see it. stopPropagation (not
        // preventDefault) lets native text editing proceed for normal keys.
        this._noteKeyHandler = function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            self._commitNote();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            self._cancelNote();
          } else {
            e.stopPropagation();
          }
        };
        document.addEventListener("keydown", this._noteKeyHandler, true);
        setTimeout(function () {
          try {
            input.focus();
            input.select();
          } catch (e) {}
        }, 30);
      };

      Scene_File.prototype._positionNoteInput = function () {
        var inp = this._noteInputEl;
        var ne = this._noteEdit;
        var lw = this._listWindow;
        if (!inp || !ne || !lw) return;
        var canvas =
          (typeof Graphics !== "undefined" && Graphics._canvas) ||
          document.querySelector("canvas");
        if (!canvas) return;
        var r = canvas.getBoundingClientRect();
        var gw = Graphics.width || canvas.width;
        var gh = Graphics.height || canvas.height;
        var sx = r.width / gw;
        var sy = r.height / gh;
        var rect = lw.itemRectForText
          ? lw.itemRectForText(ne.index)
          : lw.itemRect(ne.index);
        // Title/note line starts ~192px into the row in MV's drawContents.
        var gx = lw.x + lw.standardPadding() + rect.x + 192;
        var gy = lw.y + lw.standardPadding() + rect.y;
        var fw = Math.max(40, rect.width - 192);
        var fh = lw.lineHeight();
        var s = inp.style;
        s.left = r.left + gx * sx + "px";
        s.top = r.top + gy * sy + "px";
        s.width = fw * sx + "px";
        s.height = fh * sy + "px";
        s.fontSize = Math.max(8, Math.floor(fh * sy * 0.6)) + "px";
      };

      // Poll the hidden input each frame, mirror its value/caret into the edit
      // state, and repaint the row (text on change, caret on blink). A tap
      // outside the edited row commits (mobile has no Esc); the field itself
      // receives taps via the HTML input, so those don't reach TouchInput.
      Scene_File.prototype._updateNoteEdit = function () {
        var ne = this._noteEdit;
        var inp = this._noteInputEl;
        if (!ne || !inp) return;
        if (ne.touchGuard > 0) ne.touchGuard--;
        if (
          ne.touchGuard <= 0 &&
          typeof TouchInput !== "undefined" &&
          (TouchInput.isCancelled() || TouchInput.isTriggered())
        ) {
          if (TouchInput.isCancelled()) this._cancelNote();
          else this._commitNote();
          return;
        }
        var v = inp.value;
        if (v.length > ne.maxLen) {
          v = v.slice(0, ne.maxLen);
          inp.value = v;
        }
        var caret = inp.selectionStart;
        if (caret == null) caret = v.length;
        var lw = this._listWindow;
        if (v !== ne.text || caret !== ne.caret) {
          ne.text = v;
          ne.caret = caret;
          ne.blink = 0;
          if (lw) lw.redrawItem(ne.index);
        } else {
          ne.blink++;
          if (ne.blink % 30 === 0 && lw) lw.redrawItem(ne.index);
        }
      };

      Scene_File.prototype._commitNote = function () {
        if (!this._annotateOpen || !this._noteEdit) return;
        var ne = this._noteEdit;
        var sd = window.__saveDisplay || {};
        var val = (this._noteInputEl ? this._noteInputEl.value : ne.text)
          .replace(/\s+$/, "")
          .slice(0, ne.maxLen);
        if (sd.setNote) sd.setNote(ne.id, val);
        SoundManager.playSave();
        this._endNoteEdit();
      };

      Scene_File.prototype._cancelNote = function () {
        if (!this._annotateOpen || !this._noteEdit) return;
        this._endNoteEdit();
      };

      // Tear down the inline editor and hand focus back to the save list.
      // Reactivate next frame so the committing Enter/Esc/tap doesn't leak
      // into the now-active list window.
      Scene_File.prototype._endNoteEdit = function () {
        if (this._noteKeyHandler) {
          document.removeEventListener("keydown", this._noteKeyHandler, true);
          this._noteKeyHandler = null;
        }
        if (this._noteResizeHandler) {
          window.removeEventListener("resize", this._noteResizeHandler);
          this._noteResizeHandler = null;
        }
        if (this._noteInputEl && this._noteInputEl.parentNode) {
          this._noteInputEl.parentNode.removeChild(this._noteInputEl);
        }
        this._noteInputEl = null;
        this._noteEdit = null;
        var lw = this._listWindow;
        if (lw) {
          lw._noteEdit = null;
          lw.refresh();
        }
        var self = this;
        setTimeout(function () {
          self._annotateOpen = false;
          if (self._listWindow) self._listWindow.activate();
        }, 0);
      };

      // Export: download save data as .rpgsave file (native RPG Maker MV format:
      // LZString-compressed base64 of the JSON payload). Interchangeable with the
      // desktop game's save/fileN.rpgsave files.
      //
      // Works on both regular file slots and autosave rows: Utils.readFile
      // routes through the fs shim, which yields the raw compressed-base64
      // payload directly from localStorage for either flavor: no need to
      // decompress + recompress via StorageManager (which can't address
      // autosaves: webStorageKey assumes positive ids).
      Scene_File.prototype._handleSaveExport = function (savefileId) {
        var path = savefilePath(savefileId);
        if (!path || !Utils.exists(path)) {
          SoundManager.playBuzzer();
          return;
        }
        try {
          var rpgsave = Utils.readFile(path);
          if (!rpgsave) {
            SoundManager.playBuzzer();
            return;
          }
          // Filename prefix follows the save-scope mod, not the active mod:
          // translations share the base game's scope, so exported files keep
          // the bare `fileN.rpgsave` name and can be re-imported under any
          // (or no) translation without filename-based origin mismatches.
          var scope = getActiveSaveScope();
          var prefix = scope ? scope + "_" : "";
          // Use the disk filename so autosaves export as auto<ts>.rpgsave
          // (preserving the timestamp that identifies them) and regular
          // slots export as fileN.rpgsave.
          var base = savefileBasename(path) || "file" + savefileId + ".rpgsave";
          var filename = prefix + base;
          var bridge = androidExportBridge();
          if (bridge) {
            bridge.exportFile(
              textToBase64(rpgsave),
              filename,
              "application/octet-stream",
            );
          } else {
            var blob = new Blob([rpgsave], {
              type: "application/octet-stream",
            });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
          SoundManager.playSave();
        } catch (e) {
          console.error("[lang-shim] Save export failed:", e);
          SoundManager.playBuzzer();
        }
      };

      // Display name for a save origin (null = base game).
      function modDisplayName(modId) {
        if (!modId) return "the base game";
        var entry = _modsData && _modsData[modId];
        var name = entry && entry.name ? entry.name : modId;
        return "the '" + name + "' mod";
      }

      // Build savefile info from parsed contents without loading the save:
      // the imported slot can show character portraits and playtime
      // immediately, instead of "Unknown" until next reload.
      //
      // The portraits and playtime come from `$gameParty` and `$gameSystem`.
      // They are pulled from `contents` (rehydrated by JsonEx with their real
      // prototypes), so we briefly swap them into the globals, call
      // `DataManager.makeSavefileInfo`, and restore.
      //
      // We swap in the *full* set of save globals (map/player/screen/... in
      // addition to system/party/actors), not just the three makeSavefileInfo
      // reads in stock MV: overhaul DRMs extend makeSavefileInfo to pull
      // chapter/location data off other globals, and a single missing global
      // throws, falling back to a portrait-less "Unknown" slot until the next
      // reload. Restoring every swapped key in `finally` keeps the live game
      // state untouched.
      //
      // The DRM derives playtime from `_secondsPlayed`. Legacy saves only
      // have `_framesOnSave`; mirror the DRM's loadGame conversion so the
      // playtime renders correctly for both shapes.
      var SAVE_CONTENT_GLOBALS = {
        system: "$gameSystem",
        screen: "$gameScreen",
        timer: "$gameTimer",
        switches: "$gameSwitches",
        variables: "$gameVariables",
        selfSwitches: "$gameSelfSwitches",
        actors: "$gameActors",
        party: "$gameParty",
        map: "$gameMap",
        player: "$gamePlayer",
      };
      function makeInfoFromContents(contents) {
        if (
          !contents ||
          !contents.system ||
          !contents.party ||
          !contents.actors
        ) {
          return null;
        }
        if (typeof contents.system._secondsPlayed !== "number") {
          contents.system._secondsPlayed =
            (contents.system._framesOnSave || 0) / 60;
        }
        var saved = {};
        try {
          for (var key in SAVE_CONTENT_GLOBALS) {
            if (typeof contents[key] === "undefined") continue;
            var g = SAVE_CONTENT_GLOBALS[key];
            saved[g] = window[g];
            window[g] = contents[key];
          }
          return DataManager.makeSavefileInfo();
        } catch (e) {
          console.warn("[lang-shim] makeInfoFromContents failed:", e);
          return null;
        } finally {
          for (var rg in saved) window[rg] = saved[rg];
        }
      }

      // Extract the origin mod id from an imported save. Prefers the
      // payload tag; falls back to filename prefix against known mod keys.
      // Returns a mod id string or null (= base game / translation scope).
      // Translation mods are deliberately collapsed to null so a save
      // exported under e.g. "translation_french" loads cleanly under any
      // (or no) translation.
      function detectSaveOrigin(contents, filename) {
        if (contents && typeof contents._modId !== "undefined") {
          var id = contents._modId || null;
          return isTranslationModId(id) ? null : id;
        }
        if (filename && _modsData) {
          var keys = Object.keys(_modsData);
          for (var i = 0; i < keys.length; i++) {
            if (isTranslationType(_modsData[keys[i]].type)) continue;
            if (filename.indexOf(keys[i] + "_") === 0) return keys[i];
          }
        }
        return null;
      }

      // A global save (global.rpgsave) is the game's globalInfo array, not a
      // per-slot save object. Regular saves parse to an object; globals to an
      // array. Used to divert globals out of the slot-import path.
      function isGlobalSaveContents(contents) {
        return Array.isArray(contents);
      }

      // Merge an imported global save into the current one (active scope).
      //
      // globalInfo layout: [0] is a meta object (.tags = ending/gallery/star
      // unlocks, .autoSaves = autosave metadata, other keys = progression);
      // [1..n] are the per-slot savefile entries. The imported global lists
      // saves whose data is absent in this browser, so its save-slot list is
      // discarded: only progression is taken. The current [1..n] entries and
      // the current autosave metadata are preserved.
      //
      // Reads/writes raw via StorageManager (not DataManager.loadGlobalInfo /
      // saveGlobalInfo): the UnlockAll plugin wraps those and strips tags it
      // treats as injected, which would delete legitimately imported star tags.
      // Raw access bypasses it and is symmetric with exportGlobalSave.
      function applyGlobalSaveMerge(imp) {
        var cur = [];
        try {
          var curJson = StorageManager.load(0);
          if (curJson) cur = JsonEx.parse(curJson) || [];
        } catch (e) {
          cur = [];
        }
        if (!Array.isArray(cur)) cur = [];

        var merged = cur.slice(); // keep current [0..n] (save list + autosaves)
        var impSlot0 =
          imp && imp[0] && typeof imp[0] === "object" ? imp[0] : null;
        if (impSlot0) {
          var newSlot0 = {};
          for (var k in impSlot0) {
            if (Object.prototype.hasOwnProperty.call(impSlot0, k)) {
              newSlot0[k] = impSlot0[k];
            }
          }
          // Autosave metadata is save-list state, not progression: keep the
          // current one (imported autosaves reference files not present here).
          var curSlot0 =
            cur[0] && typeof cur[0] === "object" ? cur[0] : null;
          if (curSlot0 && typeof curSlot0.autoSaves !== "undefined") {
            newSlot0.autoSaves = curSlot0.autoSaves;
          } else {
            delete newSlot0.autoSaves;
          }
          merged[0] = newSlot0;
        }
        // Stock DataManager stores globalInfo with plain JSON.stringify and
        // reads it back with JSON.parse. JsonEx.stringify would wrap every
        // array/object as {"@c":N,"@a":[...]} metadata, which plain JSON.parse
        // leaves intact -- so globalInfo[0].tags would come back as an object,
        // and the DRM's globalTag() (tags.includes(...)) throws at the title
        // screen. Match the stock format exactly. (The read above still uses
        // JsonEx.parse so it can decode a store previously corrupted this way.)
        StorageManager.save(0, JSON.stringify(merged));
      }

      // Import: load one or more save files. Accepts:
      //   - .rpgsave (native RPG Maker MV: LZString base64 of the JSON payload)
      //   - .json    (legacy web export: { savefileId, info, data } wrapper)
      // Format is detected from content, not extension. Rejects imports
      // whose origin (base game vs mod) does not match the active context.
      //
      // Multi-file: the hovered slot is the starting cursor. The first
      // empty slot at or after that cursor receives the first file; each
      // subsequent file lands on the next empty slot beyond the previous
      // one. Occupied slots are NEVER overwritten: they are skipped.
      // Occupancy uses StorageManager.exists, not isThisGameFile: the
      // DRM-overridden isThisGameFile stays "true" after a delete until reload.
      Scene_File.prototype._handleSaveImport = function (savefileId) {
        var self = this;
        var input = document.createElement("input");
        input.type = "file";
        // No `accept` filter on purpose: Android maps each accept entry to a
        // MIME type and silently drops the ones it cannot resolve. ".json"
        // resolves to application/json but ".rpgsave" has no registered MIME
        // type, so the Android picker would restrict to JSON only and grey out
        // every .rpgsave file. Format is validated from file content below
        // (LZString/JSON detection + origin check), so no extension hint is
        // needed for correctness -- leaving accept unset keeps every save
        // selectable on all platforms.
        input.multiple = true;
        input.style.display = "none";
        input.addEventListener("change", function () {
          var files = input.files
            ? Array.prototype.slice.call(input.files)
            : [];
          if (files.length === 0) return;

          // Read all files in parallel so slot assignment runs in a single
          // synchronous pass: otherwise sequential async writes race on
          // the globalInfo blob and the second import overwrites the first.
          var readers = files.map(function (file) {
            return new Promise(function (resolve) {
              var r = new FileReader();
              r.onload = function (e) {
                resolve({
                  name: file.name || "",
                  raw: (e.target.result || "").toString().trim(),
                });
              };
              r.onerror = function () {
                resolve({ name: file.name || "", raw: null });
              };
              r.readAsText(file);
            });
          });

          Promise.all(readers).then(function (results) {
            var currentModId = getActiveSaveScope() || null;
            // Slots already taken in this batch: combined with
            // StorageManager.exists so we never overwrite anything.
            var batchTaken = {};
            var nextFreeSlot = function (start) {
              var s = Math.max(1, start | 0);
              while (StorageManager.exists(s) || batchTaken[s]) s++;
              return s;
            };

            var imported = 0;
            var failed = []; // bad/unreadable/non-save files
            var rejectedByOrigin = []; // name -> source mod label
            var globalCandidate = null; // last global save seen (latest wins)
            var cursor = savefileId;

            for (var i = 0; i < results.length; i++) {
              var r = results[i];
              if (!r.raw) {
                failed.push(r.name);
                continue;
              }
              var json = null;
              var importedInfo = null;
              try {
                if (r.raw.charAt(0) === "{") {
                  var parsed = JSON.parse(r.raw);
                  if (!parsed || !parsed.data) {
                    failed.push(r.name);
                    continue;
                  }
                  json = parsed.data;
                  importedInfo = parsed.info || null;
                } else {
                  json = LZString.decompressFromBase64(r.raw);
                }
                if (!json) {
                  failed.push(r.name);
                  continue;
                }
                var contents = JsonEx.parse(json);
                if (!contents) {
                  failed.push(r.name);
                  continue;
                }

                // Global save (globalInfo array): not a per-slot save. Divert
                // it to the replace-current-global prompt below instead of
                // writing it into a slot. Last one in the batch wins.
                if (isGlobalSaveContents(contents)) {
                  globalCandidate = { name: r.name, contents: contents };
                  continue;
                }

                var saveModId = detectSaveOrigin(contents, r.name);
                if (saveModId !== currentModId) {
                  rejectedByOrigin.push({
                    name: r.name,
                    src: modDisplayName(saveModId),
                  });
                  continue;
                }

                var slot = nextFreeSlot(cursor);
                StorageManager.save(slot, json);
                var globalInfo = DataManager.loadGlobalInfo() || [];
                if (importedInfo) {
                  importedInfo.timestamp = Date.now();
                  globalInfo[slot] = importedInfo;
                } else {
                  // Native .rpgsave has no info wrapper. Derive it from the
                  // parsed save data so the slot shows character / playtime
                  // immediately, instead of "Unknown" until next reload.
                  globalInfo[slot] = makeInfoFromContents(contents) || {
                    globalId: DataManager._globalId,
                    title: $dataSystem.gameTitle,
                    characters: [],
                    faces: [],
                    playtime: "00:00:00",
                    timestamp: Date.now(),
                  };
                }
                DataManager.saveGlobalInfo(globalInfo);
                batchTaken[slot] = true;
                cursor = slot + 1;
                imported++;
              } catch (ex) {
                console.error("[lang-shim] Save import failed for", r.name, ex);
                failed.push(r.name);
              }
            }

            if (imported > 0) {
              SoundManager.playLoad();
              self._listWindow.refresh();
            } else if (!globalCandidate) {
              // A global candidate provides its own feedback via the prompt
              // below (playSave on accept), so only buzz when nothing at all
              // was actionable.
              SoundManager.playBuzzer();
            }

            // Summary popup only when something needs explaining: a wrong-
            // origin file or an unreadable file. Silent on full success.
            // Built now, shown after the global prompt resolves (if any).
            var summaryLines = [];
            if (rejectedByOrigin.length > 0 || failed.length > 0) {
              if (imported > 0) {
                summaryLines.push("Imported " + imported + " save(s).");
              }
              if (rejectedByOrigin.length > 0) {
                // Group rejections by source so the message stays short
                // even when the user dropped a whole folder of mismatches.
                var bySrc = {};
                rejectedByOrigin.forEach(function (e) {
                  bySrc[e.src] = (bySrc[e.src] || 0) + 1;
                });
                Object.keys(bySrc).forEach(function (src) {
                  summaryLines.push(
                    "Skipped " + bySrc[src] + " save(s) from " + src + ".",
                  );
                });
                summaryLines.push("Switch context to import them.");
              }
              if (failed.length > 0) {
                summaryLines.push(
                  "Skipped " + failed.length + " unreadable file(s).",
                );
              }
            }
            var showSummary = function () {
              if (summaryLines.length > 0) self._showSaveInfoPopup(summaryLines);
            };

            // Global save: prompt to merge its progression into the current
            // global. The prompt shows first; its resolution chains into the
            // regular-import summary (if any).
            if (globalCandidate) {
              self._promptGlobalReplace(globalCandidate.contents, showSummary);
            } else {
              showSummary();
            }
          });
        });
        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
      };

      // Prompt to replace the current global save with an imported one. Uses a
      // dedicated confirm window so the delete flow's window is untouched.
      // `afterFn` runs once the prompt resolves (either choice); it chains the
      // regular-import summary popup.
      Scene_File.prototype._promptGlobalReplace = function (imp, afterFn) {
        this._pendingGlobalContents = imp;
        this._pendingGlobalAfter = afterFn || function () {};
        if (!this._globalConfirmWindow) this._createGlobalConfirmWindow();
        var win = this._globalConfirmWindow;
        win.setQuestion([
          "You imported a global save file:",
          "Do you want to replace your current one?",
        ]);
        win.x = (Graphics.boxWidth - win.width) / 2;
        win.y = (Graphics.boxHeight - win.height) / 2;
        if (this._listWindow) this._listWindow.deactivate();
        win.show();
        win.open();
        win.activate();
        win.select(1); // Default to "No"
      };

      Scene_File.prototype._createGlobalConfirmWindow = function () {
        this._globalConfirmWindow = new Window_SaveConfirm(0, 0);
        this._globalConfirmWindow.setHandler(
          "confirm",
          this._onGlobalConfirmYes.bind(this),
        );
        this._globalConfirmWindow.setHandler(
          "cancel",
          this._onGlobalConfirmNo.bind(this),
        );
        this._globalConfirmWindow.hide();
        this._globalConfirmWindow.close();
        this.addWindow(this._globalConfirmWindow);
      };

      Scene_File.prototype._onGlobalConfirmYes = function () {
        var imp = this._pendingGlobalContents;
        var after = this._pendingGlobalAfter;
        this._pendingGlobalContents = null;
        this._pendingGlobalAfter = null;
        var merged = false;
        try {
          applyGlobalSaveMerge(imp);
          SoundManager.playSave();
          // Replacing the global rewrites globalInfo, which drives the slot
          // list: redraw it.
          if (this._listWindow) this._listWindow.refresh();
          merged = true;
        } catch (e) {
          console.error("[lang-shim] Global save merge failed:", e);
          SoundManager.playBuzzer();
        }
        this._globalConfirmWindow.close();
        this._globalConfirmWindow.hide();
        if (this._listWindow) this._listWindow.activate();
        if (merged) {
          // The DRM reads globalInfo tags (vision-room unlocks, gallery/ending
          // progression, title-menu commands) at boot / title-command build
          // time. Merging them into a live session does not retroactively add
          // those entries, so reload once the user acknowledges: the fresh
          // boot re-reads the merged globalInfo and the unlocked content
          // appears. The reload supersedes the regular-import summary (a global
          // import is the batch's last action, and the reload re-derives the
          // save list anyway).
          this._showSaveInfoPopup(
            ["Global save imported.", "Reloading to apply unlocked content..."],
            function () {
              window.location.reload();
            },
          );
          return;
        }
        if (after) after.call(this);
      };

      Scene_File.prototype._onGlobalConfirmNo = function () {
        var after = this._pendingGlobalAfter;
        this._pendingGlobalContents = null;
        this._pendingGlobalAfter = null;
        this._globalConfirmWindow.close();
        this._globalConfirmWindow.hide();
        if (this._listWindow) this._listWindow.activate();
        if (after) after.call(this);
      };

      // Delete: remove save after confirmation. Same DRM-staleness avoidance
      // as import/export: check actual storage, not DataManager.isThisGameFile.
      // Utils.exists handles both file slots and autosaves (the fs shim
      // resolves both filename patterns to their localStorage keys).
      Scene_File.prototype._handleSaveDelete = function (savefileId) {
        var path = savefilePath(savefileId);
        if (!path || !Utils.exists(path)) {
          SoundManager.playBuzzer();
          return;
        }
        this._pendingDeleteId = savefileId;
        this._pendingDeletePath = path;
        this._listWindow.deactivate();
        if (!this._saveConfirmWindow) {
          this._createSaveConfirmWindow();
        }
        // For autosaves, label the prompt by the user-facing row name ("Auto N")
        // rather than the negative internal id.
        var label =
          savefileId > 0
            ? "Save " + savefileId
            : "Auto " + (Math.abs(savefileId) + 1);
        this._saveConfirmWindow.setAction("delete", label);
        this._saveConfirmWindow.show();
        this._saveConfirmWindow.open();
        this._saveConfirmWindow.activate();
        this._saveConfirmWindow.select(1); // Default to "No"
      };

      Scene_File.prototype._createSaveConfirmWindow = function () {
        this._saveConfirmWindow = new Window_SaveConfirm(0, 0);
        this._saveConfirmWindow.x =
          (Graphics.boxWidth - this._saveConfirmWindow.width) / 2;
        this._saveConfirmWindow.y =
          (Graphics.boxHeight - this._saveConfirmWindow.height) / 2;
        this._saveConfirmWindow.setHandler(
          "confirm",
          this._onDeleteConfirm.bind(this),
        );
        this._saveConfirmWindow.setHandler(
          "cancel",
          this._onDeleteCancel.bind(this),
        );
        this._saveConfirmWindow.hide();
        this._saveConfirmWindow.close();
        this.addWindow(this._saveConfirmWindow);
      };

      Scene_File.prototype._onDeleteConfirm = function () {
        var id = this._pendingDeleteId;
        var path = this._pendingDeletePath;
        try {
          if (id > 0) {
            StorageManager.remove(id);
            // Also remove backup if it exists (autosaves don't have bak files)
            var bakKey = StorageManager.webStorageKey(id) + "bak";
            localStorage.removeItem(bakKey);
            // Update global info
            var globalInfo = DataManager.loadGlobalInfo() || [];
            delete globalInfo[id];
            DataManager.saveGlobalInfo(globalInfo);
          } else {
            // Autosave: delete the on-disk file via the fs shim (which also
            // mirrors removal to IDB through the localStorage prototype
            // interception) and prune the autoSaves dict so the row vanishes
            // from the savefile list and getSaveInfo returns null. Without
            // the dict prune the list still shows a stale row, just with
            // the next autosave's data, because indices shift after deletion.
            if (path) Utils.delete(path);
            var giAuto = DataManager.loadGlobalInfo() || [];
            if (giAuto[0] && giAuto[0].autoSaves && path) {
              var fname = savefileBasename(path);
              if (fname) delete giAuto[0].autoSaves[fname];
              DataManager.saveGlobalInfo(giAuto);
            }
          }
          SoundManager.playOk();
        } catch (e) {
          console.error("[lang-shim] Save delete failed:", e);
          SoundManager.playBuzzer();
        }
        this._saveConfirmWindow.close();
        this._saveConfirmWindow.hide();
        this._listWindow.refresh();
        this._listWindow.activate();
        // The continue-menu map background caches the resolved map id per save
        // path and only re-evaluates when the hovered index changes. After a
        // delete the cursor stays on the (now empty) slot, so drop the cached
        // id and force Scene_Load to re-resolve the background next frame:
        // otherwise the deleted save's map stays drawn.
        if (window.__saveDisplay && window.__saveDisplay.invalidate) {
          window.__saveDisplay.invalidate(id);
        }
        // Also drop the rendered scene snapshot for this slot (declared in the
        // map-bg block below; var-hoisted into this function scope).
        if (typeof _sceneSnapCache !== "undefined" && _sceneSnapCache) {
          delete _sceneSnapCache[id];
        }
        this._mapBgIndex = null;
        this._pendingDeleteId = null;
        this._pendingDeletePath = null;
      };

      Scene_File.prototype._onDeleteCancel = function () {
        this._saveConfirmWindow.close();
        this._saveConfirmWindow.hide();
        this._listWindow.activate();
        this._pendingDeleteId = null;
        this._pendingDeletePath = null;
      };

      // Confirmation dialog window for save deletion
      window.Window_SaveConfirm = function () {
        this.initialize.apply(this, arguments);
      };

      Window_SaveConfirm.prototype = Object.create(Window_Command.prototype);
      Window_SaveConfirm.prototype.constructor = Window_SaveConfirm;

      Window_SaveConfirm.prototype.initialize = function (x, y) {
        // Question rendered above the Yes/No commands. Held as an array so the
        // same window can pose a one-line delete prompt or a multi-line
        // confirmation (e.g. the global-save import prompt). Must be set before
        // super-initialize since windowHeight() reads its length.
        this._questionLines = [];
        Window_Command.prototype.initialize.call(this, x, y);
        this.openness = 0;
      };

      // Multi-line question. Re-lays-out (height depends on line count) and
      // redraws. refresh() rebuilds the contents bitmap at the new height.
      Window_SaveConfirm.prototype.setQuestion = function (lines) {
        this._questionLines = Array.isArray(lines) ? lines : [String(lines)];
        this.height = this.windowHeight();
        this.refresh();
      };

      Window_SaveConfirm.prototype.setAction = function (action, label) {
        // label is a user-facing string like "Save 3" or "Auto 1".
        // Backwards-compatible with the old numeric arg: a bare number
        // still produces "Delete Save N?".
        var name = typeof label === "number" ? "Save " + label : String(label);
        this.setQuestion(["Delete " + name + "?"]);
      };

      Window_SaveConfirm.prototype.windowWidth = function () {
        // Wide enough for the longest global-import prompt line without the
        // browser squishing it to fit maxWidth.
        return 460;
      };

      Window_SaveConfirm.prototype.windowHeight = function () {
        // Question lines + gap + 2 command rows + padding. Guard against the
        // empty initial state (super-initialize calls this before setQuestion).
        var qlines = Math.max(1, (this._questionLines || []).length);
        return this.fittingHeight(qlines + 2) + 8;
      };

      Window_SaveConfirm.prototype.makeCommandList = function () {
        this.addCommand("Yes", "confirm");
        this.addCommand("No", "cancel");
      };

      Window_SaveConfirm.prototype.itemTextAlign = function () {
        return "center";
      };

      Window_SaveConfirm.prototype.drawAllItems = function () {
        // Draw each question line above the commands
        var pad = this.textPadding();
        var lh = this.lineHeight();
        var lines = this._questionLines || [];
        for (var q = 0; q < lines.length; q++) {
          this.drawText(
            lines[q],
            pad,
            q * lh,
            this.contentsWidth() - pad * 2,
            "center",
          );
        }
        // Draw commands below
        for (var i = 0; i < this.maxItems(); i++) {
          this.drawItem(i);
        }
      };

      Window_SaveConfirm.prototype.itemRect = function (index) {
        var rect = Window_Command.prototype.itemRect.call(this, index);
        // Offset commands below the question text
        var qlines = Math.max(1, (this._questionLines || []).length);
        rect.y += qlines * this.lineHeight() + 8;
        return rect;
      };

      Window_SaveConfirm.prototype.numVisibleRows = function () {
        return 2;
      };

      // Info popup (single OK button) for import rejection, etc.
      Scene_File.prototype._showSaveInfoPopup = function (lines, onDismiss) {
        if (!this._saveInfoWindow) this._createSaveInfoWindow();
        // One-shot callback fired when the user acknowledges the popup (OK or
        // cancel). Used by the global-import path to reload after the notice.
        this._saveInfoOnDismiss =
          typeof onDismiss === "function" ? onDismiss : null;
        this._saveInfoWindow.setMessage(lines);
        this._saveInfoWindow.x =
          (Graphics.boxWidth - this._saveInfoWindow.width) / 2;
        this._saveInfoWindow.y =
          (Graphics.boxHeight - this._saveInfoWindow.height) / 2;
        if (this._listWindow) this._listWindow.deactivate();
        this._saveInfoWindow.show();
        this._saveInfoWindow.open();
        this._saveInfoWindow.activate();
        this._saveInfoWindow.select(0);
      };

      Scene_File.prototype._createSaveInfoWindow = function () {
        this._saveInfoWindow = new Window_SaveInfo(0, 0);
        var onClose = this._onSaveInfoOk.bind(this);
        this._saveInfoWindow.setHandler("ok", onClose);
        this._saveInfoWindow.setHandler("cancel", onClose);
        this._saveInfoWindow.hide();
        this._saveInfoWindow.close();
        this.addWindow(this._saveInfoWindow);
      };

      Scene_File.prototype._onSaveInfoOk = function () {
        this._saveInfoWindow.close();
        this._saveInfoWindow.hide();
        if (this._listWindow) this._listWindow.activate();
        var cb = this._saveInfoOnDismiss;
        this._saveInfoOnDismiss = null;
        if (cb) cb.call(this);
      };

      // Info dialog window with a multi-line message and a single OK button.
      window.Window_SaveInfo = function () {
        this.initialize.apply(this, arguments);
      };

      Window_SaveInfo.prototype = Object.create(Window_Command.prototype);
      Window_SaveInfo.prototype.constructor = Window_SaveInfo;

      Window_SaveInfo.prototype.initialize = function (x, y) {
        this._messageLines = [];
        Window_Command.prototype.initialize.call(this, x, y);
        this.openness = 0;
      };

      Window_SaveInfo.prototype.setMessage = function (lines) {
        this._messageLines = Array.isArray(lines) ? lines : [String(lines)];
        this.refresh();
      };

      Window_SaveInfo.prototype.windowWidth = function () {
        return 520;
      };

      Window_SaveInfo.prototype.windowHeight = function () {
        // 2 message lines + gap + 1 command row + padding
        return this.fittingHeight(3) + 8;
      };

      Window_SaveInfo.prototype.makeCommandList = function () {
        this.addCommand("OK", "ok");
      };

      Window_SaveInfo.prototype.itemTextAlign = function () {
        return "center";
      };

      Window_SaveInfo.prototype.drawAllItems = function () {
        var pad = this.textPadding();
        var lines = this._messageLines || [];
        var lh = this.lineHeight();
        for (var i = 0; i < Math.min(lines.length, 2); i++) {
          this.drawText(
            lines[i] || "",
            pad,
            i * lh,
            this.contentsWidth() - pad * 2,
            "center",
          );
        }
        for (var j = 0; j < this.maxItems(); j++) {
          this.drawItem(j);
        }
      };

      Window_SaveInfo.prototype.itemRect = function (index) {
        var rect = Window_Command.prototype.itemRect.call(this, index);
        // Offset command below the 2 message lines
        rect.y += this.lineHeight() * 2 + 8;
        return rect;
      };

      Window_SaveInfo.prototype.numVisibleRows = function () {
        return 1;
      };
    }

    // Continue menu: hovered-save map background
    // While hovering a slot in the title-screen "Continue" menu, the menu
    // background becomes the map that save sits on: the map's ground image with
    // its parallax layered over it. The map id comes from the save payload
    // (__saveDisplay.mapId); the two image hashes come from the map JSON's note
    // field, e.g. "<ground:bab183cf848588f3><par:6bfa4133bda1b1bd>". Moving onto
    // a slot with no resolvable map (or no save) reverts to the default
    // background; leaving for the title screen restores it automatically since
    // Scene_Title rebuilds its own background.
    //
    // Gated to Scene_Load reached *from the title* (isPreviousScene), so the
    // in-game load screen is unaffected.
    if (
      typeof Scene_Load !== "undefined" &&
      typeof Scene_Title !== "undefined" &&
      typeof Sprite !== "undefined" &&
      typeof Bitmap !== "undefined"
    ) {
      // map id -> { ground, par } | null, and image hash -> Bitmap | null.
      var _mapBgNoteCache = {};
      var _mapBgImgCache = {};
      // Ground/parallax art is stored under a hashed filename within one of
      // these image folders; the SW resolves the hashed path directly and
      // decrypts it. parallaxes is the expected home; the rest are tried as a
      // fallback so a non-standard layout still resolves.
      var MAP_BG_DIRS = [
        "img/parallaxes/",
        "img/pictures/",
        "img/backgrounds/",
      ];

      function pad3(n) {
        n = "" + (n | 0);
        while (n.length < 3) n = "0" + n;
        return n;
      }

      function fetchMapBgNote(mapId, cb) {
        if (!mapId) {
          cb(null);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(_mapBgNoteCache, mapId)) {
          cb(_mapBgNoteCache[mapId]);
          return;
        }
        fetch("data/Map" + pad3(mapId) + ".json")
          .then(function (r) {
            return r && r.ok ? r.json() : null;
          })
          .then(function (data) {
            var res = null;
            if (data && typeof data.note === "string") {
              var g = data.note.match(/<ground:([0-9a-fA-F]+)>/);
              var p = data.note.match(/<par(?:allax)?:([0-9a-fA-F]+)>/);
              if (g || p) {
                res = {
                  ground: g ? g[1].toLowerCase() : null,
                  par: p ? p[1].toLowerCase() : null,
                };
              }
            }
            _mapBgNoteCache[mapId] = res;
            cb(res);
          })
          .catch(function () {
            _mapBgNoteCache[mapId] = null;
            cb(null);
          });
      }

      function loadMapBgImage(hash, cb) {
        if (!hash) {
          cb(null);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(_mapBgImgCache, hash)) {
          cb(_mapBgImgCache[hash]);
          return;
        }
        // The SW decrypts the hashed file. Poll the bitmap state (load
        // listeners fire on success only) so a missing or erroring image
        // advances to the next candidate folder, and an exhausted list
        // resolves to null instead of hanging the pending count. Uses
        // loadSafeBitmap rather than Bitmap.load so a genuinely-missing
        // background (a save referencing a hash not in IDB) fails fast to
        // state 'error' here instead of going through ResourceHandler's 3
        // retries and then the blocking printLoadingError dialog.
        var dir = 0;
        function tryDir() {
          if (dir >= MAP_BG_DIRS.length) {
            _mapBgImgCache[hash] = null;
            cb(null);
            return;
          }
          var bmp = loadSafeBitmap(MAP_BG_DIRS[dir] + hash + ".png");
          var tries = 0;
          (function poll() {
            if (bmp.isReady() && !(bmp.isError && bmp.isError())) {
              if (bmp.width > 1) {
                _mapBgImgCache[hash] = bmp;
                cb(bmp);
              } else {
                dir++;
                tryDir();
              }
            } else if ((bmp.isError && bmp.isError()) || tries++ > 300) {
              dir++;
              tryDir();
            } else {
              setTimeout(poll, 16);
            }
          })();
        }
        tryDir();
      }

      // Full-scene snapshot of a save: reconstruct the saved game objects,
      // build a real Spriteset_Map (tilemap + events at their saved
      // positions/pages + vehicles + followers + player + on-screen pictures +
      // weather + screen tone) and render one frame to a Bitmap. This is what
      // the game looked like at the instant of saving. Cached per savefileId;
      // returns null (caller falls back to ground/parallax) when it can't be
      // produced: no save contents, missing map JSON, missing engine deps, or
      // a render error.
      var _sceneSnapCache = {};
      // Per-slot flag: the saved moment is a full blackout (cutscene fade), so
      // the live game loads into a black screen. The preview neutralizes that
      // to show the last map, but the seamless cut-in must instead fade the
      // preview to black so the load doesn't flash straight to black.
      var _sceneSnapBlackout = {};
      // Globals the saved state stands in for while the spriteset is built and
      // snapped. Swapped in only across synchronous spans, always restored
      // before any async yield, so the live (title-era) globals are never seen
      // in a swapped state by the menu's update loop.
      var SCENE_GLOBAL_KEYS = [
        "$gameMap",
        "$gamePlayer",
        "$gameScreen",
        "$gameSwitches",
        "$gameVariables",
        "$gameSelfSwitches",
        "$gameActors",
        "$gameParty",
        "$gameSystem",
        "$gameTimer",
        "$gameTemp",
        "$gameMessage",
        "$gameTroop",
        "$dataMap",
      ];

      // True when a rendered snapshot is essentially a black screen: the
      // hallmark of a save captured during a cutscene fade (no dialogue yet),
      // where the previewed map would be far more useful than a black void.
      // Samples a coarse grid from one full readback; a pixel counts as "dark"
      // when nearly transparent or near-black. Requires >=99% dark so genuinely
      // dim-but-meaningful scenes (a night tint, a shadowed room) are kept.
      function isBitmapMostlyBlack(bmp) {
        try {
          var ctx = bmp && bmp._context;
          var w = bmp && bmp.width;
          var h = bmp && bmp.height;
          if (!ctx || !w || !h) return false;
          var data = ctx.getImageData(0, 0, w, h).data;
          var cols = 24;
          var rows = 18;
          var dark = 0;
          var total = 0;
          for (var iy = 0; iy < rows; iy++) {
            var py = Math.min(h - 1, Math.floor(((iy + 0.5) / rows) * h));
            for (var ix = 0; ix < cols; ix++) {
              var px = Math.min(w - 1, Math.floor(((ix + 0.5) / cols) * w));
              var o = (py * w + px) * 4;
              total++;
              if (
                data[o + 3] < 8 ||
                (data[o] < 12 && data[o + 1] < 12 && data[o + 2] < 12)
              ) {
                dark++;
              }
            }
          }
          return total > 0 && dark / total >= 0.99;
        } catch (e) {
          return false;
        }
      }

      // Strip the darkening sources that produce a full-black cutscene frame:
      // the screen tint (a [-255,-255,-255] blackout tone is kept by
      // swapInSavedState as a "lasting tone"), the brightness fade, and any
      // picture overlays (a full-screen black picture used as a manual fade).
      // Only invoked once the snapshot already tested >=99% black, so the only
      // thing these can be hiding is the map itself: there is no meaningful
      // picture to lose. Returns a restore fn: the screen lives on the shared
      // `_saveContentsCache` (browser-shim), reused across Continue visits, so
      // these edits MUST be undone after the re-render or the next visit's
      // first snap would already be de-blacked and blackout would go
      // undetected (-> a seamless cut-in that flashes to black).
      function neutralizeBlackout(screen) {
        if (!screen) return function () {};
        var savedTone = screen._tone;
        var savedToneTarget = screen._toneTarget;
        var savedToneDuration = screen._toneDuration;
        var savedBrightness = screen._brightness;
        var savedPics = null;
        screen._tone = [0, 0, 0, 0];
        screen._toneTarget = [0, 0, 0, 0];
        screen._toneDuration = 0;
        screen._brightness = 255;
        if (screen._pictures) {
          savedPics = screen._pictures.map(function (p) {
            return p
              ? { p: p, o: p._opacity, to: p._targetOpacity, d: p._duration }
              : null;
          });
          screen._pictures.forEach(function (p) {
            if (p) {
              p._opacity = 0;
              p._targetOpacity = 0;
              p._duration = 0;
            }
          });
        }
        return function restore() {
          screen._tone = savedTone;
          screen._toneTarget = savedToneTarget;
          screen._toneDuration = savedToneDuration;
          screen._brightness = savedBrightness;
          if (savedPics) {
            savedPics.forEach(function (s) {
              if (s) {
                s.p._opacity = s.o;
                s.p._targetOpacity = s.to;
                s.p._duration = s.d;
              }
            });
          }
        };
      }

      // A genuine cutscene fade-to-black behind a CG/cut-in shows a visible
      // picture on top of the black: any pictured slot still named and not
      // fully transparent. Such a fade is intentional presentation, not a
      // transient transition, so the brightness fade must be preserved.
      function saveHasVisiblePicture(screen) {
        if (!screen || !screen._pictures) return false;
        return screen._pictures.some(function (p) {
          return p && p._name && p._opacity > 0;
        });
      }

      function renderSaveSceneSnapshot(savefileId, cb) {
        if (Object.prototype.hasOwnProperty.call(_sceneSnapCache, savefileId)) {
          cb(_sceneSnapCache[savefileId]);
          return;
        }
        var sd = window.__saveDisplay;
        if (
          !sd ||
          !sd.contents ||
          typeof Spriteset_Map === "undefined" ||
          !Bitmap.snap ||
          typeof Game_Temp === "undefined" ||
          typeof PIXI === "undefined" ||
          !window.$dataTilesets
        ) {
          cb(null);
          return;
        }
        var contents = null;
        try {
          contents = sd.contents(savefileId);
        } catch (e) {
          contents = null;
        }
        var mapId = contents && contents.map && contents.map._mapId;
        if (!contents || !mapId) {
          cb(null);
          return;
        }
        function finish(bmp, blackout) {
          _sceneSnapCache[savefileId] = bmp || null;
          _sceneSnapBlackout[savefileId] = !!blackout;
          cb(bmp || null);
        }
        fetch("data/Map" + pad3(mapId) + ".json")
          .then(function (r) {
            return r && r.ok ? r.json() : null;
          })
          .then(function (dataMap) {
            if (!dataMap) {
              finish(null);
              return;
            }
            buildAndSnapScene(contents, dataMap, finish);
          })
          .catch(function () {
            finish(null);
          });
      }

      // Install the saved game state into the globals, returning a restore fn.
      // $gameTemp/$gameMessage/$gameTroop aren't in the save payload; fresh
      // (inert) instances stand in so any child the spriteset touches is safe.
      function swapInSavedState(contents, dataMap) {
        var saved = {};
        SCENE_GLOBAL_KEYS.forEach(function (k) {
          saved[k] = window[k];
        });
        window.$gameMap = contents.map;
        window.$gamePlayer = contents.player;
        // Followers gathered onto the leader (the engine's gatherFollowers,
        // common during cutscenes/dialogue) sit on the player's exact tile and
        // render as a sprite stacked directly under the player avatar, reading
        // as a duplicate of the controlled character. Blank the image of any
        // follower co-located with the player so only the player shows at that
        // tile; trailing followers on other tiles keep their graphic. The save
        // is a throwaway parsed copy, so this never touches the live party.
        var _ply = contents.player;
        if (_ply && _ply._followers && _ply._followers._data) {
          _ply._followers._data.forEach(function (f) {
            if (f && f._x === _ply._x && f._y === _ply._y) {
              f._characterName = "";
              f._characterIndex = 0;
            }
          });
        }
        window.$gameScreen = contents.screen;
        window.$gameSwitches = contents.switches;
        window.$gameVariables = contents.variables;
        window.$gameSelfSwitches = contents.selfSwitches;
        window.$gameActors = contents.actors;
        window.$gameParty = contents.party;
        window.$gameSystem = contents.system;
        window.$gameTimer = contents.timer;
        // Neutralize transient screen transitions so a save captured mid-fade
        // (e.g. an autosave during a map transfer: _brightness 0 -> a fully
        // opaque black fade sprite) still previews the actual scene. The
        // lasting color tone and zoom are kept; only the fade/flash/shake
        // overlays are reset. Idempotent across the two swapIn calls.
        //
        // Exception: when a CG/cut-in is shown on top of the black (a visible
        // picture), the fade-to-black is the intended backdrop, not a
        // transition. Clearing it would reveal the map under the CG (a weird
        // map+CG composite), so keep the brightness fade and let the snapshot
        // show the CG over black, exactly as in game.
        if (contents.screen) {
          if (!saveHasVisiblePicture(contents.screen)) {
            if (contents.screen.clearFade) contents.screen.clearFade();
            else contents.screen._brightness = 255;
          }
          if (contents.screen.clearFlash) contents.screen.clearFlash();
          if (contents.screen.clearShake) contents.screen.clearShake();
        }
        window.$dataMap = dataMap;
        // The raw fetched map JSON has no `.meta` (the engine adds it on load
        // via extractMetadata). Plugins like OrangeOverlay read $dataMap.meta
        // and each event's .meta during spriteset build, so reproduce that
        // here. onLoad keys off `object === $dataMap`, hence after the assign.
        if (
          typeof DataManager !== "undefined" &&
          DataManager.onLoad &&
          !dataMap.meta
        ) {
          try {
            DataManager.onLoad(window.$dataMap);
          } catch (e) {}
        }
        window.$gameTemp = new Game_Temp();
        // A save taken mid-dialogue carries the on-screen text in
        // contents.message (browser-shim's makeSaveContents override, pure-text
        // lines only). Stand in a deep copy so the preview can render the actual
        // line over the map: a copy because driving Window_Message can call
        // terminateMessage -> $gameMessage.clear(), which would otherwise empty
        // the shared, cross-visit contents cache and blank later previews.
        var savedMsg = contents.message;
        if (savedMsg && savedMsg._texts) {
          try {
            window.$gameMessage = JsonEx.makeDeepCopy(savedMsg);
          } catch (e) {
            window.$gameMessage = savedMsg;
          }
        } else if (typeof Game_Message !== "undefined") {
          window.$gameMessage = new Game_Message();
        }
        if (typeof Game_Troop !== "undefined")
          window.$gameTroop = new Game_Troop();
        return function restore() {
          SCENE_GLOBAL_KEYS.forEach(function (k) {
            window[k] = saved[k];
          });
        };
      }

      // Build a real Window_Message (plus its plugin satellites) for the
      // snapshot when the saved state holds an on-screen line ($gameMessage
      // carried in the save). Called inside the build swapped span so
      // $gameMessage is the saved one: startMessage reserves the face/bust +
      // windowskin bitmaps and fires the YEP name-box refresh now, so the shared
      // waitReady loop covers their images before the snap.
      //
      // TCOAAL's dialogue isn't one self-contained window: two plugins put
      // pieces on the *scene*:
      //   - YEP_MessageCore.createSubWindows does SceneManager._scene.addChild
      //     (this._nameWindow): the speaker name box. Built with the live scene
      //     it lands on Scene_Load, on top of the menu and never removed
      //     between rows. We point SceneManager._scene at the snapshot stage so
      //     it lands in the snapshot instead (below the menu, torn down with it).
      //   - GALV_MessageBackground draws the actual message box as a scene
      //     sprite (msgimg_*); the window's own skin is forced transparent
      //     (window.opacity 0). We build that sprite too, below the window.
      //   - Irina_VisualNovelBusts draws the speaker art. The in-dialogue "body"
      //     bust is mw._messageBodyBustSprite (loaded from the [BUST] faceName
      //     during startMessage); standalone \BUST[n] busts resolve through
      //     $bust(n) = SceneManager._scene._spriteset._messageBustSprites[n], so
      //     the stage is shimmed with _spriteset/_messageWindow for that lookup.
      //     Busts start at opacity 0 and fade in via their own update(), which
      //     nothing drives here; fillSnapshotMessageWindow settles them. The
      //     body bust is a window child (rendered bundled with / dimmed by the
      //     window); it's lifted out onto its own stage layer below the box.
      //
      // Final stage z-order, bottom -> top (the requested layering):
      //   spriteset (ground/parallax/characters/scene busts) -> pictures ->
      //   body bust -> GALV text background -> speaker name -> message text.
      //
      // Returns a bundle (window/bg/nameWindow/spriteset), all already added to
      // the stage in z-order, or null when there's no text / a class is missing /
      // a plugin throws; then the snapshot is simply the map without dialogue.
      function buildSnapshotMessageWindow(stage, spriteset) {
        try {
          if (
            typeof Window_Message === "undefined" ||
            !window.$gameMessage ||
            !window.$gameMessage.hasText ||
            !window.$gameMessage.hasText()
          ) {
            return null;
          }
          var mw;
          var prevScene = SceneManager._scene;
          try {
            // Sub-windows (YEP name box) attach to SceneManager._scene during
            // construction/startMessage; redirect that to the snapshot stage.
            // Also shim _spriteset/_messageWindow so Irina's $bust(n) lookup
            // resolves to the snapshot's own sprites instead of throwing.
            SceneManager._scene = stage;
            stage._spriteset = spriteset || null;
            mw = new Window_Message();
            stage._messageWindow = mw;
            // startMessage runs convertEscapeCharacters, which fires the YEP
            // name-box refresh (\n<Name>) and Irina's bust load right here,
            // within the swap. Force openness past the slide-in so the single
            // frame shows it open.
            mw.startMessage();
            mw.openness = 255;
            // Rebuild persistent scene busts (non-speaking characters) from the
            // saved state, here, while the scene is shimmed so $bust resolves.
            restoreSavedBusts();
          } finally {
            SceneManager._scene = prevScene;
          }
          // GALV message-background sprite (the real box). Galv.MBG.window was
          // set to mw by startMessage above, so its update() will track mw.
          var bg = null;
          if (typeof Sprite_GalvMsgBg !== "undefined") {
            try {
              bg = new Sprite_GalvMsgBg();
            } catch (e) {
              bg = null;
            }
          }
          var nameWin = mw._nameWindow || null;
          // Extract the in-dialogue body bust from the message window into its
          // own layer. As a window child it renders bundled with the text and in
          // front of the GALV background box, and the window's own render (the
          // openness-clipped contents pass, the alpha-0 skin container) muddies
          // it, which shows up as a translucent bust over hidden text. The
          // requested z-order wants every bust *behind* the box + text, so move
          // it onto the stage and convert its window-local position to stage
          // coordinates (the window has scale 1 and no rotation).
          var bodyBust = mw._messageBodyBustSprite || null;
          if (bodyBust && bodyBust.parent === mw) {
            mw.removeChild(bodyBust);
            bodyBust.x += mw.x;
            bodyBust.y += mw.y;
          }
          // Stage z-order, bottom -> top, layered over the already-added
          // spriteset (ground / parallax / characters / scene busts) and
          // picHost (pictures):
          //   body bust -> GALV text background -> speaker name -> message text.
          // addChild re-parents an existing child to the top, so re-adding the
          // name window (already attached during construction) restacks it.
          if (bodyBust) stage.addChild(bodyBust);
          if (bg) stage.addChild(bg);
          if (nameWin) {
            stage.addChild(nameWin);
            // Snap the name box fully open only when it holds a speaker name
            // (refresh sets _lastNameText); otherwise keep it hidden so an empty
            // box doesn't show.
            if (nameWin._lastNameText) {
              nameWin.openness = 255;
              nameWin.visible = true;
            } else {
              nameWin.openness = 0;
              nameWin.visible = false;
            }
          }
          stage.addChild(mw);
          return {
            window: mw,
            bg: bg,
            nameWindow: nameWin,
            spriteset: spriteset || null,
            stage: stage,
          };
        } catch (e) {
          console.warn("[lang-shim] snapshot message build failed:", e);
          return null;
        }
      }

      // Drive a Visual-Novel bust sprite to its final state. Busts spawn at
      // opacity 0 and ease toward their target opacity/position/scale/tone over
      // a handful of frames inside their own update(); the body bust lives on the
      // message window and the scene busts only get the 2 spriteset updates, so
      // none of them reach their target in the single snapshot frame. Pumping
      // update() well past the longest tween duration settles every easing to
      // its endpoint (durations clamp at 0) and sets the source frame. No-op
      // for an empty bust (target opacity 0).
      function settleBust(sp) {
        if (!sp || typeof sp.update !== "function") return;
        try {
          for (var i = 0; i < 240; i++) sp.update();
        } catch (e) {}
      }

      // Rebuild the persistent scene busts (e.g. the non-speaking character
      // standing in a conversation) from the state browser-shim stamped onto
      // $gameSystem._vnBusts at save time. Irina keeps no bust state in the save
      // and only the current line's speaking bust is reconstructable from
      // $gameMessage, so without this the non-speaker is missing. Slot 0 (the
      // body bust) is skipped: the message rebuild already drives it from the
      // [BUST] faceName. Must run inside the scene-shimmed span so $bust(n)
      // resolves to the snapshot's spriteset busts; loadBitmap reserves the
      // image (waitReady covers it) and the transform/opacity/tone/expression
      // are forced to their saved values (no fade), then settleBust sets frames.
      function restoreSavedBusts() {
        try {
          var saved = window.$gameSystem && window.$gameSystem._vnBusts;
          if (!saved || !saved.length || typeof $bust !== "function") return;
          for (var i = 0; i < saved.length; i++) {
            var b = saved[i];
            if (!b || !b.name || b.setting < 1) continue;
            var sp = $bust(b.setting);
            if (!sp || typeof sp.loadBitmap !== "function") continue;
            sp.loadBitmap(b.type || "face", b.name);
            sp._expressionIndex = b.expr || 0;
            sp.x = b.x;
            sp.y = b.y;
            if (sp.scale) {
              sp.scale.x = b.sx;
              sp.scale.y = b.sy;
            }
            if (sp.anchor) {
              sp.anchor.x = b.ax;
              sp.anchor.y = b.ay;
            }
            if (b.tone && sp.setColorTone) sp.setColorTone(b.tone);
            sp._opacityTarget = b.op;
            sp._opacityDuration = 0;
            sp.opacity = b.op;
          }
        } catch (e) {
          console.warn("[lang-shim] snapshot bust restore failed:", e);
        }
      }

      // Paint the current dialogue page into an already-built message bundle so
      // the snap captures it. Runs in the finalize swapped span, after the
      // images are loaded: draw the face, type the line instantly, then settle
      // the GALV background sprite. The saved state doesn't record which
      // page/character was visible, so we show the first page (stop at the first
      // real page break); the same line the in-game reload re-displays.
      function fillSnapshotMessageWindow(bundle) {
        if (!bundle || !bundle.window) return;
        var mw = bundle.window;
        // Typing the line runs processEscapeCharacter, and TCOAAL dialogue often
        // carries *inline* bust codes (\bustExpression, \bustOpacityTo, ...) that
        // call $bust(n) = SceneManager._scene._spriteset/_messageWindow. The
        // build phase shimmed the scene to the stage, but it's been restored to
        // Scene_Load by now, so without re-shimming here the first inline bust
        // code throws -> the catch aborts the draw and the line never appears
        // (while the speaker name, drawn back in the build phase, still shows).
        var prevScene = SceneManager._scene;
        try {
          if (bundle.stage) SceneManager._scene = bundle.stage;
          // Draw the reserved face/bust now that ImageManager has settled.
          var fg = 0;
          while (mw.updateLoading && mw.updateLoading() && fg++ < 4) {}
          // _showFast makes updateMessage emit the whole run in one pass;
          // zeroing _waitCount each pass defeats inline \. / \| pause codes so a
          // mid-line wait can't truncate the snapshot. Stop at a genuine page
          // break (this.pause) or the end of the text.
          mw._showFast = true;
          var g = 0;
          do {
            mw._waitCount = 0;
            mw.updateMessage();
            g++;
          } while (mw._textState && !mw.pause && g < 64);
          if (mw.updateOpen) mw.updateOpen();
          // Settle the GALV box: picks up its loaded image, opacity (from the
          // window openness) and position (from the message positionType).
          if (bundle.bg && bundle.bg.update) {
            bundle.bg.update();
            bundle.bg.update();
          }
          // Settle the Visual-Novel busts to full opacity/position: the body
          // bust (now lifted onto the stage) and the scene busts on the spriteset
          // (the \BUST[n] ones, plus any just touched by inline codes). Their face
          // images were reserved during the build / typing, so ImageManager has
          // them by now and updateFrame can set the source rect.
          if (mw._messageBodyBustSprite) settleBust(mw._messageBodyBustSprite);
          var ss = bundle.spriteset;
          if (ss && ss._messageBustSprites) {
            ss._messageBustSprites.forEach(function (b) {
              if (b) settleBust(b);
            });
          }
        } catch (e) {
          console.warn("[lang-shim] snapshot message render failed:", e);
        } finally {
          SceneManager._scene = prevScene;
        }
      }

      function buildAndSnapScene(contents, dataMap, done) {
        var stage = null;
        var spriteset = null;
        var msgBundle = null;
        // Scene-level picture host. A camera plugin (SRD_CameraCore with
        // "Zoom Pictures?") relocates picture creation from the spriteset to
        // the scene so the camera zoom doesn't scale pictures: it stubs
        // Spriteset_Base.createPictures to a no-op and stashes the original on
        // Scene_Base.createPicturesForCameraCore, which Scene_Map calls after
        // building its spriteset. Our preview builds only the spriteset, so
        // without reproducing that the player's on-screen pictures (the
        // full-screen overlays added by their actions) are missing and only
        // appear once the real map loads.
        var picHost = null;
        var buildErr = null;
        var restore = swapInSavedState(contents, dataMap);
        try {
          stage = new PIXI.Container();
          spriteset = new Spriteset_Map();
          stage.addChild(spriteset);
          // If the spriteset built no pictures of its own (createPictures was
          // stubbed) but the engine stashed the real builder on the scene,
          // recreate them on a host layered above the spriteset, matching the
          // live scene's order. Kick off one update inside this swapped span so
          // the picture image loads register before waitReady polls.
          if (
            (!spriteset._pictureContainer ||
              !spriteset._pictureContainer.children ||
              !spriteset._pictureContainer.children.length) &&
            typeof Scene_Base !== "undefined" &&
            typeof Scene_Base.prototype.createPicturesForCameraCore ===
              "function"
          ) {
            picHost = new Sprite();
            Scene_Base.prototype.createPicturesForCameraCore.call(picHost);
            stage.addChild(picHost);
            picHost.update();
          }
          // On-screen dialogue (message box + text + speaker name), above the
          // pictures; the live scene draws these over the spriteset. Built here
          // (adds itself to the stage in z-order) so its images register before
          // waitReady; painted in finalizeSnap once they're loaded.
          msgBundle = buildSnapshotMessageWindow(stage, spriteset);
        } catch (e) {
          buildErr = e;
        } finally {
          restore();
        }
        if (buildErr) {
          console.warn("[lang-shim] scene preview build failed:", buildErr);
          try {
            if (stage) stage.destroy({ children: true });
          } catch (e2) {}
          done(null);
          return;
        }
        // Building kicked off async image loads (tileset, characters,
        // parallax, pictures, Shadow1) through the normal SW path. Wait for
        // the cache to settle (capped ~3.2s) with globals back to live, then
        // settle + snap in one synchronous swapped span.
        var tries = 0;
        (function waitReady() {
          var ready = false;
          try {
            ready = ImageManager.isReady();
          } catch (e) {
            ready = true;
          }
          if (ready || tries++ > 200) {
            finalizeSnap();
          } else {
            setTimeout(waitReady, 16);
          }
        })();

        function finalizeSnap() {
          var bmp = null;
          var blackout = false;
          var restore2 = swapInSavedState(contents, dataMap);
          try {
            // A couple of updates settle character frames, parallax origin,
            // tone filter and picture sprites before the single render.
            spriteset.update();
            spriteset.update();
            // The scene-level picture host isn't a spriteset child, so the
            // scene would normally update it; do it here so its sprites pick
            // up the loaded bitmaps and their saved transform before the snap.
            if (picHost) {
              picHost.update();
              picHost.update();
            }
            // Paint the dialogue line now that its face/windowskin are loaded.
            // The window's contents (clipped by openness) are committed during
            // the PIXI render in Bitmap.snap, so this only has to draw into them
            // once before the snap. It stays painted for the blackout re-snap.
            fillSnapshotMessageWindow(msgBundle);
            bmp = Bitmap.snap(stage);
            // Save captured during a cutscene fade-to-black: the frame is all
            // black and useless as a preview. Drop the fade/tint/overlay and
            // re-render once to show the last visible map instead. If it's
            // still black afterward the map genuinely has no content to show,
            // so discard it and let the caller fall back to ground/parallax.
            if (bmp && isBitmapMostlyBlack(bmp)) {
              blackout = true;
              var restoreBlk = neutralizeBlackout(contents.screen);
              spriteset.update();
              spriteset.update();
              if (picHost) {
                picHost.update();
                picHost.update();
              }
              var bmp2 = Bitmap.snap(stage);
              // Undo the screen edits before anything else reads the cached
              // contents, so a later Continue visit re-detects this blackout.
              restoreBlk();
              if (bmp2 && !isBitmapMostlyBlack(bmp2)) {
                bmp = bmp2;
              } else {
                bmp = null;
              }
            }
          } catch (e) {
            console.warn("[lang-shim] scene preview snap failed:", e);
            bmp = null;
          } finally {
            restore2();
          }
          // children:true tears down the spriteset tree; textures are left
          // intact (they belong to the shared ImageManager cache).
          try {
            stage.destroy({ children: true });
          } catch (e) {}
          done(bmp, blackout);
        }
      }

      var _origLoadCreate = Scene_Load.prototype.create;
      Scene_Load.prototype.create = function () {
        _origLoadCreate.call(this);
        this._mapBgEnabled = SceneManager.isPreviousScene(Scene_Title);
        if (!this._mapBgEnabled) return;
        // Drop cached snapshots on each fresh Continue visit so an in-game
        // save-over (which happens between visits) is reflected next time.
        _sceneSnapCache = {};
        _sceneSnapBlackout = {};
        this._mapBgContainer = new Sprite();
        // Opaque black backdrop: ground/parallax art has large fully
        // transparent regions, so without this the default menu background
        // would show through. It's the first child, behind both layers, and
        // fades together with them via the container's opacity.
        if (typeof ScreenSprite !== "undefined") {
          this._mapBgBlack = new ScreenSprite();
          this._mapBgBlack.setBlack();
          this._mapBgBlack.opacity = 255;
        } else {
          var blk = new Bitmap(
            Graphics.boxWidth || Graphics.width,
            Graphics.boxHeight || Graphics.height,
          );
          blk.fillAll("black");
          this._mapBgBlack = new Sprite(blk);
        }
        this._mapBgGround = new Sprite();
        this._mapBgPar = new Sprite();
        // Full-scene snapshot (a single rendered Spriteset_Map still). When set
        // it supersedes the ground/par fallback layers, which are cleared.
        this._mapBgScene = new Sprite();
        this._mapBgContainer.addChild(this._mapBgBlack);
        this._mapBgContainer.addChild(this._mapBgGround);
        this._mapBgContainer.addChild(this._mapBgPar);
        this._mapBgContainer.addChild(this._mapBgScene);
        this._mapBgContainer.visible = false;
        this._mapBgContainer.opacity = 0;
        this._mapBgFadeIn = false;
        this._mapBgIndex = null;
        this._mapBgToken = 0;
        // Sit just below the window layer: above the default background, below
        // every menu window.
        var insertAt = this._windowLayer
          ? this.getChildIndex(this._windowLayer)
          : this.children.length;
        this.addChildAt(this._mapBgContainer, insertAt);
      };

      var _origLoadUpdate = Scene_Load.prototype.update;
      Scene_Load.prototype.update = function () {
        _origLoadUpdate.call(this);
        if (!this._mapBgEnabled || !this._mapBgContainer) return;
        if (!this._annotateOpen && this._listWindow) {
          var idx = this._listWindow.index();
          if (idx !== this._mapBgIndex) {
            this._mapBgIndex = idx;
            this._refreshMapBg();
          }
        }
        var c = this._mapBgContainer;
        if (this._mapBgFadeIn) {
          if (c.opacity < 255) c.opacity = Math.min(255, c.opacity + 32);
        } else if (c.opacity > 0) {
          c.opacity = Math.max(0, c.opacity - 32);
          if (c.opacity === 0) c.visible = false;
        }
        // Load transition: dissolve only the menu chrome over the (now opaque)
        // map snapshot. The window layer's alpha is baked into each window when
        // it renders into the layer's filter target, so this fades the help +
        // savefile windows together while the snapshot: which matches the map
        // Scene_Map is about to show: stays put. isBusy holds the scene swap
        // until the dissolve finishes; see onLoadSuccess.
        if (
          this._menuDissolve &&
          this._windowLayer &&
          this._windowLayer.alpha > 0
        ) {
          this._windowLayer.alpha = Math.max(0, this._windowLayer.alpha - 0.06);
        }
      };

      Scene_Load.prototype._refreshMapBg = function () {
        var self = this;
        var savefileId = 0;
        try {
          savefileId = this.savefileId();
        } catch (e) {}
        var sd = window.__saveDisplay;
        var mapId = sd && sd.mapId ? sd.mapId(savefileId) : 0;
        var token = ++this._mapBgToken;
        if (!mapId) {
          this._hideMapBg();
          return;
        }
        // Prefer a faithful full-scene snapshot; on any failure fall back to
        // the ground+parallax composite for this same hover (same token).
        renderSaveSceneSnapshot(savefileId, function (snap) {
          if (token !== self._mapBgToken) return;
          if (snap) {
            self._mapBgGround.bitmap = null;
            self._mapBgPar.bitmap = null;
            self._mapBgScene.bitmap = snap;
            self._fitMapBgSprite(self._mapBgScene, snap);
            self._showMapBg();
          } else {
            self._mapBgScene.bitmap = null;
            self._refreshMapBgGroundPar(token);
          }
        });
      };

      // Legacy ground+parallax composite, used as the snapshot fallback. Keeps
      // the caller's hover token so a stale async result is ignored.
      Scene_Load.prototype._refreshMapBgGroundPar = function (token) {
        var self = this;
        var savefileId = 0;
        try {
          savefileId = this.savefileId();
        } catch (e) {}
        var sd = window.__saveDisplay;
        var mapId = sd && sd.mapId ? sd.mapId(savefileId) : 0;
        if (!mapId) {
          this._hideMapBg();
          return;
        }
        fetchMapBgNote(mapId, function (info) {
          if (token !== self._mapBgToken) return;
          if (!info || (!info.ground && !info.par)) {
            self._hideMapBg();
            return;
          }
          var pending = (info.ground ? 1 : 0) + (info.par ? 1 : 0);
          var any = false;
          function done() {
            if (token !== self._mapBgToken) return;
            if (--pending <= 0) {
              if (any) self._showMapBg();
              else self._hideMapBg();
            }
          }
          if (info.ground) {
            loadMapBgImage(info.ground, function (b) {
              if (token === self._mapBgToken) {
                self._mapBgGround.bitmap = b || null;
                if (b) {
                  any = true;
                  self._fitMapBgSprite(self._mapBgGround, b);
                }
              }
              done();
            });
          } else {
            // No ground layer for this map: clear any leftover from the
            // previously hovered slot so it isn't drawn under the parallax.
            self._mapBgGround.bitmap = null;
          }
          if (info.par) {
            loadMapBgImage(info.par, function (b) {
              if (token === self._mapBgToken) {
                self._mapBgPar.bitmap = b || null;
                if (b) {
                  any = true;
                  self._fitMapBgSprite(self._mapBgPar, b);
                }
              }
              done();
            });
          } else {
            // No parallax for this map: clear the previous slot's parallax so
            // it isn't left drawn on top of the new ground.
            self._mapBgPar.bitmap = null;
          }
        });
      };

      // Scale to cover the whole screen, centred (preserves aspect ratio).
      Scene_Load.prototype._fitMapBgSprite = function (sprite, bmp) {
        if (!bmp || !bmp.width || !bmp.height) return;
        var sw = Graphics.boxWidth || Graphics.width;
        var sh = Graphics.boxHeight || Graphics.height;
        var scale = Math.max(sw / bmp.width, sh / bmp.height);
        sprite.scale.x = sprite.scale.y = scale;
        sprite.x = Math.round((sw - bmp.width * scale) / 2);
        sprite.y = Math.round((sh - bmp.height * scale) / 2);
      };

      Scene_Load.prototype._showMapBg = function () {
        if (!this._mapBgContainer) return;
        this._mapBgContainer.visible = true;
        this._mapBgFadeIn = true;
      };

      Scene_Load.prototype._hideMapBg = function () {
        this._mapBgFadeIn = false;
      };

      // Seamless load from the Continue menu.
      //
      // The hovered slot already renders its map snapshot behind the menu, and
      // Scene_Map is about to show that exact map. So instead of the stock
      // fade-to-black -> fade-to-game, run the normal success path (sound, audio
      // fade-out, version reload, goto) but neutralize its black visual fade and
      // dissolve only the menu chrome over the snapshot. With the from-black
      // fade-in on Scene_Map also suppressed, the menu simply melts away into
      // the running game.
      //
      // Only when a snapshot is actually showing for the selected slot; any
      // other case (snapshot not resolved, in-game load, or a blackout-origin
      // slot whose live game loads into black) keeps the stock fade: for a
      // blackout slot that stock fade-to-black is exactly what's wanted, so the
      // previewed map fades out instead of flashing straight to black.
      var _origLoadOnLoadSuccess = Scene_Load.prototype.onLoadSuccess;
      Scene_Load.prototype.onLoadSuccess = function () {
        // A blackout-origin slot (cutscene fade) previews the last map, but the
        // live game loads into black. Cutting straight in would flash to black;
        // keep the stock fade-to-black instead so the preview map fades out.
        var sfId = 0;
        try {
          sfId = this.savefileId();
        } catch (e) {}
        var slotBlackout = !!_sceneSnapBlackout[sfId];
        var seamless =
          this._mapBgEnabled &&
          this._mapBgContainer &&
          this._mapBgContainer.visible &&
          this._mapBgFadeIn &&
          this._windowLayer &&
          !slotBlackout;
        _origLoadOnLoadSuccess.call(this);
        if (!this._loadSuccess || !seamless) return;
        // Kill the black fade the success path just started.
        if (this._fadeSprite) {
          this._fadeSprite.opacity = 0;
          this._fadeDuration = 0;
        }
        // Hold the snapshot opaque and begin dissolving the menu over it.
        this._mapBgFadeIn = true;
        this._mapBgContainer.opacity = 255;
        this._menuDissolve = true;
        if (this._listWindow) this._listWindow.deactivate();
        // Tell Scene_Map to cut straight in rather than fade from black.
        window.__skipLoadFadeIn = true;
      };

      // Keep the scene rendered (snapshot visible, menu dissolving) until the
      // dissolve completes, so the swap to Scene_Map lands on a fully faded
      // menu instead of popping mid-fade.
      var _origLoadIsBusy = Scene_Load.prototype.isBusy;
      Scene_Load.prototype.isBusy = function () {
        if (
          this._menuDissolve &&
          this._windowLayer &&
          this._windowLayer.alpha > 0
        ) {
          return true;
        }
        return _origLoadIsBusy.call(this);
      };
    }

    // Suppress Scene_Map's from-black fade-in for the seamless Continue load
    // (set by Scene_Load.onLoadSuccess). Only consumed for a non-transfer load
    // coming straight from Scene_Load; a version-mismatch reload (_transfer) or
    // any other entry keeps the stock fade. The flag is always cleared after
    // start so it can never leak into a later scene change.
    if (typeof Scene_Map !== "undefined") {
      var _origMapNeedsFadeIn = Scene_Map.prototype.needsFadeIn;
      Scene_Map.prototype.needsFadeIn = function () {
        if (
          window.__skipLoadFadeIn &&
          !this._transfer &&
          typeof Scene_Load !== "undefined" &&
          SceneManager.isPreviousScene(Scene_Load)
        ) {
          return false;
        }
        return _origMapNeedsFadeIn.call(this);
      };

      var _origMapStartFade = Scene_Map.prototype.start;
      Scene_Map.prototype.start = function () {
        _origMapStartFade.call(this);
        window.__skipLoadFadeIn = false;
      };
    }

    // Adds a "Stretch" boolean toggle to the options window. When ON,
    // Graphics._stretchEnabled = true and the canvas scales to fill the
    // browser window while maintaining aspect ratio.
    if (
      typeof ConfigManager !== "undefined" &&
      typeof Graphics !== "undefined"
    ) {
      ConfigManager.stretch = true;

      var _orig_makeData = ConfigManager.makeData;
      ConfigManager.makeData = function () {
        var config = _orig_makeData.call(this);
        config.stretch = this.stretch;
        return config;
      };

      var _orig_applyData = ConfigManager.applyData;
      ConfigManager.applyData = function (config) {
        _orig_applyData.call(this, config);
        this.stretch = config.stretch === undefined ? true : !!config.stretch;
        Graphics._stretchEnabled = this.stretch;
        Graphics._updateAllElements();
      };

      // ConfigManager.load() already ran in Scene_Boot.create (before
      // applyPatches), so the patched applyData above missed the initial
      // load. Sync Graphics to the current ConfigManager.stretch value now.
      Graphics._stretchEnabled = ConfigManager.stretch;
      Graphics._updateAllElements();
    }

    if (typeof Window_Options !== "undefined") {
      // browser-shim removes the DRM's native (NW.js / config-backed)
      // fullscreen row, so this is a fresh command driven straight off the
      // standard Fullscreen API (module-scope _fsToggle/_fsElement) and the
      // real document.fullscreenElement state: never persisted to
      // ConfigManager, since the browser won't restore fullscreen on reload
      // without a gesture.

      // Real fullscreen state changes asynchronously (and can be driven from
      // outside the menu, e.g. the four-finger gesture or the browser's own
      // Esc), so redraw the open options window when the state actually flips.
      var _onFsChange = function () {
        var scene = typeof SceneManager !== "undefined" && SceneManager._scene;
        if (scene && scene._optionsWindow) scene._optionsWindow.refresh();
      };
      document.addEventListener("fullscreenchange", _onFsChange);
      document.addEventListener("webkitfullscreenchange", _onFsChange);
      document.addEventListener("mozfullscreenchange", _onFsChange);
      document.addEventListener("MSFullscreenChange", _onFsChange);

      var _orig_optMakeCmdList = Window_Options.prototype.makeCommandList;
      Window_Options.prototype.makeCommandList = function () {
        _orig_optMakeCmdList.call(this);
        this.addCommand("Stretch", "stretch");
        if (_fsSupported()) {
          this.addCommand("Fullscreen", "fullscreen");
        }
      };

      // Override statusText so 'stretch' shows 'On'/'Off' instead of raw bool,
      // and 'fullscreen' reflects the live document fullscreen state.
      var _orig_optStatusText = Window_Options.prototype.statusText;
      Window_Options.prototype.statusText = function (index) {
        var sym = this.commandSymbol(index);
        if (sym === "stretch") {
          return this.getConfigValue(sym) ? "On" : "Off";
        }
        if (sym === "fullscreen") {
          return _fsElement() ? "On" : "Off";
        }
        return _orig_optStatusText.apply(this, arguments);
      };

      // The DRM overrides processOk/cursorLeft/cursorRight with _input,
      // which treats unknown symbols as numeric (calls .boundaryWrap/.clamp).
      // Wrap _input to handle 'stretch' as a boolean toggle before the DRM path.
      var _orig_optInput = Window_Options.prototype._input;
      if (_orig_optInput) {
        Window_Options.prototype._input = function (dir, wrap) {
          var sym = this.commandSymbol(this.index());
          if (sym === "stretch") {
            var cur = this.getConfigValue(sym);
            this.changeValue(sym, !cur);
            return;
          }
          if (sym === "fullscreen") {
            // Not config-backed: toggle the browser directly. The redraw is
            // driven by the fullscreenchange listener once the state flips.
            SoundManager.playCursor();
            _fsToggle();
            return;
          }
          return _orig_optInput.apply(this, arguments);
        };
      }

      // Mouse wheel changes option values when mouse control plugin is active
      var _orig_optProcessWheel = Window_Options.prototype.processWheel;
      Window_Options.prototype.processWheel = function () {
        if (isPluginActive("_mouseControl") && this.isOpenAndActive()) {
          var threshold = 20;
          if (TouchInput.wheelY >= threshold) {
            // Scroll down = decrease value (like cursorLeft)
            var sym = this.commandSymbol(this.index());
            if (sym) {
              if (this._input) {
                this._input(-1, false);
              } else {
                this.cursorLeft(false);
              }
            }
            return;
          }
          if (TouchInput.wheelY <= -threshold) {
            // Scroll up = increase value (like cursorRight)
            var sym2 = this.commandSymbol(this.index());
            if (sym2) {
              if (this._input) {
                this._input(1, false);
              } else {
                this.cursorRight(false);
              }
            }
            return;
          }
        }
        if (_orig_optProcessWheel) {
          _orig_optProcessWheel.call(this);
        }
      };

      var _orig_optSetConfigValue = Window_Options.prototype.setConfigValue;
      Window_Options.prototype.setConfigValue = function (symbol, value) {
        _orig_optSetConfigValue.call(this, symbol, value);
        if (symbol === "stretch") {
          Graphics._stretchEnabled = !!value;
          Graphics._updateAllElements();
        }
      };
    }

    // Mobile fullscreen launch button: show it once the title screen is up
    // (the game's first interactive moment), and dismiss it the instant the
    // player navigates anywhere: every title command routes through
    // SceneManager.goto/push, so wrapping those covers "enters a menu or does
    // something else meaningful". The 5s timeout and first-keypress paths live
    // inside _showFsLaunchButton's teardown.
    if (typeof Scene_Title !== "undefined") {
      var _fsb_titleStart = Scene_Title.prototype.start;
      Scene_Title.prototype.start = function () {
        _fsb_titleStart.apply(this, arguments);
        _showFsLaunchButton();
      };
    }
    if (typeof SceneManager !== "undefined") {
      var _fsb_goto = SceneManager.goto;
      SceneManager.goto = function () {
        _dismissFsLaunchButton();
        return _fsb_goto.apply(this, arguments);
      };
      var _fsb_push = SceneManager.push;
      SceneManager.push = function () {
        _dismissFsLaunchButton();
        return _fsb_push.apply(this, arguments);
      };
    }

    // Always enable Continue on the title screen so players can import saves
    if (typeof Window_TitleCommand !== "undefined") {
      Window_TitleCommand.prototype.isContinueEnabled = function () {
        return true;
      };
    }

    // Strip the DRM payload's "Language" entry from the title command list.
    // Language selection is driven by the active translation mod instead.
    if (typeof Window_TitleCommand !== "undefined") {
      var _pre_makeCmdList_lang = Window_TitleCommand.prototype.makeCommandList;
      Window_TitleCommand.prototype.makeCommandList = function () {
        _pre_makeCmdList_lang.call(this);
        for (var i = this._list.length - 1; i >= 0; i--) {
          var it = this._list[i];
          var sym = (it.symbol || "").toString().toLowerCase();
          var nm = (it.name || "").toString().toLowerCase();
          if (sym === "language" || nm === "language") {
            this._list.splice(i, 1);
          }
        }
      };
    }

    // The DRM payload defines its own makeCommandList that filters
    // commands to a strict ordered set (MenuOptions.labels()). We wrap
    // it to append "Mods" after that filtering.
    if (typeof Window_TitleCommand !== "undefined" && getModList().length > 0) {
      var _payload_makeCmdList = Window_TitleCommand.prototype.makeCommandList;
      Window_TitleCommand.prototype.makeCommandList = function () {
        _payload_makeCmdList.call(this);
        // Insert Mods before Quit Game
        var quitIdx = -1;
        for (var i = 0; i < this._list.length; i++) {
          if (
            this._list[i].symbol === "quit" ||
            this._list[i].symbol === "exitGame" ||
            this._list[i].name === "Quit Game"
          ) {
            quitIdx = i;
            break;
          }
        }
        var modsCmd = {
          name: "Mods",
          symbol: "mods",
          enabled: true,
          ext: null,
        };
        if (quitIdx >= 0) {
          this._list.splice(quitIdx, 0, modsCmd);
        } else {
          this._list.push(modsCmd);
        }
      };

      // Add Mods icon to MenuOptions if the payload defined it.
      // The character sheet loads async: when it arrives, refresh
      // the title command window so the icon appears even on first render.
      if (typeof MenuOptions !== "undefined") {
        var modsSheet = ImageManager.loadNormalBitmap("img/mods.png", 0);
        var modsIcon = new Bitmap(26, 26);
        modsSheet.addLoadListener(function () {
          modsIcon.blt(
            modsSheet,
            0,
            0,
            modsSheet.width,
            modsSheet.height,
            0,
            0,
            26,
            26,
          );
          modsIcon._loadingState = "loaded";
          modsIcon._callLoadListeners();
          // Redraw the title command window if it's currently visible
          if (
            typeof SceneManager !== "undefined" &&
            SceneManager._scene &&
            SceneManager._scene._commandWindow
          ) {
            SceneManager._scene._commandWindow.refresh();
          }
        });
        MenuOptions.iconImages["Mods"] = modsIcon;
      }
    }

    if (typeof Scene_Title !== "undefined") {
      var _orig_createCmdWin = Scene_Title.prototype.createCommandWindow;
      Scene_Title.prototype.createCommandWindow = function () {
        _orig_createCmdWin.call(this);
        this._commandWindow.setHandler("mods", this.commandMods.bind(this));
      };

      Scene_Title.prototype.commandMods = function () {
        this._commandWindow.close();
        SceneManager.push(Scene_Mods);
      };
    }

    // Help / Feedback title entry: opens the "feedback." subdomain of the
    // current host in a new tab. Sits right below "Mods" (or before Quit
    // when no mods are registered).
    // Hidden for now (kept intact to re-enable later).
    var SHOW_REPORT_ISSUE_ENTRY = false;
    if (SHOW_REPORT_ISSUE_ENTRY && typeof Window_TitleCommand !== "undefined") {
      var _pre_help_makeCmdList = Window_TitleCommand.prototype.makeCommandList;
      Window_TitleCommand.prototype.makeCommandList = function () {
        _pre_help_makeCmdList.call(this);
        var insertIdx = -1;
        for (var i = 0; i < this._list.length; i++) {
          if (this._list[i].symbol === "mods") {
            insertIdx = i + 1;
            break;
          }
        }
        if (insertIdx < 0) {
          for (var j = 0; j < this._list.length; j++) {
            var sym = this._list[j].symbol;
            var nm = this._list[j].name;
            if (sym === "quit" || sym === "exitGame" || nm === "Quit Game") {
              insertIdx = j;
              break;
            }
          }
        }
        var helpCmd = {
          name: "Report issue",
          symbol: "help",
          enabled: true,
          ext: null,
        };
        if (insertIdx >= 0) {
          this._list.splice(insertIdx, 0, helpCmd);
        } else {
          this._list.push(helpCmd);
        }
      };

      if (
        typeof MenuOptions !== "undefined" &&
        MenuOptions.iconImages &&
        typeof ImageManager !== "undefined" &&
        typeof Bitmap !== "undefined"
      ) {
        var helpSheet = ImageManager.loadNormalBitmap("img/help.png", 0);
        var helpIcon = new Bitmap(26, 26);
        helpSheet.addLoadListener(function () {
          helpIcon.blt(
            helpSheet,
            0,
            0,
            helpSheet.width,
            helpSheet.height,
            0,
            0,
            26,
            26,
          );
          helpIcon._loadingState = "loaded";
          helpIcon._callLoadListeners();
          if (
            typeof SceneManager !== "undefined" &&
            SceneManager._scene &&
            SceneManager._scene._commandWindow
          ) {
            SceneManager._scene._commandWindow.refresh();
          }
        });
        // Icon map is keyed by the command's display name.
        MenuOptions.iconImages["Report issue"] = helpIcon;
      }
    }

    if (SHOW_REPORT_ISSUE_ENTRY && typeof Scene_Title !== "undefined") {
      var _orig_help_createCmdWin = Scene_Title.prototype.createCommandWindow;
      Scene_Title.prototype.createCommandWindow = function () {
        _orig_help_createCmdWin.call(this);
        this._commandWindow.setHandler("help", this.commandHelp.bind(this));
      };

      Scene_Title.prototype.commandHelp = function () {
        var host =
          typeof location !== "undefined" && location.hostname
            ? location.hostname
            : "";
        var target =
          /\./.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host)
            ? host
            : "tcoaal.app";
        var url = "https://feedback." + target + "/";
        try {
          window.open(url, "_blank", "noopener,noreferrer");
        } catch (e) {}
        if (this._commandWindow) this._commandWindow.activate();
      };
    }

    // Language title entry: opens Scene_Language to pick a translation for the
    // current context (base game or active overhaul). Inserted between Options
    // and Credits. Defined AFTER the Mods/Help wrappers (and the DRM-language
    // strip) so this wrapper runs last and the command isn't stripped. Shown
    // only when the context actually has translations (always true for the
    // base game, which at least offers English).
    if (typeof Window_TitleCommand !== "undefined") {
      var _pre_lang_makeCmdList = Window_TitleCommand.prototype.makeCommandList;
      Window_TitleCommand.prototype.makeCommandList = function () {
        _pre_lang_makeCmdList.call(this);
        if (!shouldShowLanguage()) return;
        // Already present? (defensive against double-application)
        for (var d = 0; d < this._list.length; d++) {
          if (this._list[d].symbol === "language") return;
        }
        // Prefer right after Options; else right before Credits/Gallery; else
        // before Mods; else before Quit; else append.
        var insertIdx = -1;
        for (var i = 0; i < this._list.length; i++) {
          var s = (this._list[i].symbol || "").toString().toLowerCase();
          var n = (this._list[i].name || "").toString().toLowerCase();
          if (s === "options" || n === "options") {
            insertIdx = i + 1;
            break;
          }
        }
        if (insertIdx < 0) {
          var fallbacks = [
            "credits",
            "gallery",
            "rollcredits",
            "mods",
            "quit",
            "exitgame",
          ];
          for (var j = 0; j < this._list.length; j++) {
            var sj = (this._list[j].symbol || "").toString().toLowerCase();
            var nj = (this._list[j].name || "").toString().toLowerCase();
            if (fallbacks.indexOf(sj) >= 0 || nj === "quit game") {
              insertIdx = j;
              break;
            }
          }
        }
        var langCmd = {
          name: "Language",
          symbol: "language",
          enabled: true,
          ext: null,
        };
        if (insertIdx >= 0) this._list.splice(insertIdx, 0, langCmd);
        else this._list.push(langCmd);
      };

      if (
        typeof MenuOptions !== "undefined" &&
        MenuOptions.iconImages &&
        typeof ImageManager !== "undefined" &&
        typeof Bitmap !== "undefined"
      ) {
        var langSheet = ImageManager.loadNormalBitmap(
          "img/system/f633ab2ca861decf.png",
          0,
        );
        var langIcon = new Bitmap(26, 26);
        langSheet.addLoadListener(function () {
          langIcon.blt(
            langSheet,
            0,
            0,
            langSheet.width,
            langSheet.height,
            0,
            0,
            26,
            26,
          );
          langIcon._loadingState = "loaded";
          langIcon._callLoadListeners();
          if (
            typeof SceneManager !== "undefined" &&
            SceneManager._scene &&
            SceneManager._scene._commandWindow
          ) {
            SceneManager._scene._commandWindow.refresh();
          }
        });
        MenuOptions.iconImages["Language"] = langIcon;
      }
    }

    if (typeof Scene_Title !== "undefined") {
      var _orig_lang_createCmdWin = Scene_Title.prototype.createCommandWindow;
      Scene_Title.prototype.createCommandWindow = function () {
        _orig_lang_createCmdWin.call(this);
        this._commandWindow.setHandler(
          "language",
          this.commandLanguage.bind(this),
        );
      };

      Scene_Title.prototype.commandLanguage = function () {
        this._commandWindow.close();
        SceneManager.push(Scene_Language);
      };
    }

    function exportGlobalSave() {
      try {
        var json = StorageManager.load(0);
        if (!json) {
          SoundManager.playBuzzer();
          return;
        }
        var rpgsave = LZString.compressToBase64(json);
        var mod = getActiveMod();
        var prefix = mod ? mod + "_" : "";
        var filename = prefix + "global.rpgsave";
        var bridge = androidExportBridge();
        if (bridge) {
          bridge.exportFile(
            textToBase64(rpgsave),
            filename,
            "application/octet-stream",
          );
        } else {
          var blob = new Blob([rpgsave], {
            type: "application/octet-stream",
          });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        SoundManager.playSave();
      } catch (e) {
        console.error("[lang-shim] Global save export failed:", e);
        SoundManager.playBuzzer();
      }
    }

    // Scene_Mods: mod selection screen
    window.Scene_Mods = function () {
      this.initialize.apply(this, arguments);
    };

    Scene_Mods.prototype = Object.create(Scene_MenuBase.prototype);
    Scene_Mods.prototype.constructor = Scene_Mods;

    Scene_Mods.prototype.initialize = function () {
      Scene_MenuBase.prototype.initialize.call(this);
      this._installing = null;
    };

    Scene_Mods.prototype.create = function () {
      Scene_MenuBase.prototype.create.call(this);
      this.createHelpWindow();
      this.createActiveModWindow();
      this.createListWindow();
      this.createConfirmWindow();
    };

    Scene_Mods.prototype.createHelpWindow = function () {
      this._helpWindow = new Window_Help(1);
      // Header stays at just "Mods": when an overhaul or translation is
      // enabled it gets its own Window_ModActive rectangle below this one
      // (createActiveModWindow), so the header doesn't need to spell out
      // "Mods | Active: <name>" (a long mod name there overlapped the
      // centered [Del]/[Enter] hint row drawn over this same window by
      // _drawModsHints).
      this._helpWindow.setText("Mods");
      this.addWindow(this._helpWindow);
      this._drawModsHints();
    };

    Scene_Mods.prototype.createActiveModWindow = function () {
      // Plugin-type mods can have many active at once and stay in
      // Window_ModList with a green border. Only the single
      // overhaul/translation slot (the one returned by getActiveMod) gets
      // hoisted into its own framed rectangle here.
      var am = getActiveMod();
      if (!am) {
        this._activeModWindow = null;
        return;
      }
      var entry = null;
      var list = getModList();
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === am) {
          entry = list[i];
          break;
        }
      }
      if (!entry || isPluginType(entry.type)) {
        this._activeModWindow = null;
        return;
      }
      var y = this._helpWindow.height;
      var width = Graphics.boxWidth;
      // Pin row + 4 visible list rows = 5 rows total below the help bar,
      // all at the same height. Each window contributes one standardPadding
      // pair (pad2 = 36) to the chrome budget. Keeping pin/list rows the
      // same height makes the pin look like a peeled-off list row.
      var pad2 = 36;
      var contentH = Graphics.boxHeight - y;
      var rowH = Math.floor((contentH - 2 * pad2) / 5);
      this._modRowHeight = rowH;
      this._activeModWindow = new Window_ModActive(
        0,
        y,
        width,
        rowH + pad2,
        entry,
      );
      this._activeModWindow.setHandler("ok", this.onActiveModOk.bind(this));
      this._activeModWindow.setHandler("cancel", this.popScene.bind(this));
      // The pin only has a single item, so pressing Down on it hops focus
      // to the top of the main list rather than no-oping.
      var scene = this;
      this._activeModWindow.cursorDown = function () {
        if (scene._listWindow && scene._listWindow.maxItems() > 0) {
          SoundManager.playCursor();
          this.deactivate();
          scene._listWindow.select(0);
          scene._listWindow.activate();
        }
      };
      this.addWindow(this._activeModWindow);
    };

    Scene_Mods.prototype.onActiveModOk = function () {
      var mod = this._activeModWindow.selectedMod();
      if (!mod) {
        this._activeModWindow.activate();
        return;
      }
      // The pin only hosts the currently-active overhaul/translation, so
      // OK on it can only mean "disable". Confirm first, then on Yes the
      // standard disableOverhaul path runs (clears _activeMod, reloads).
      this._showConfirm(
        "Disable " + mod.name + "?",
        "disableOverhaul",
        mod,
        this._activeModWindow,
      );
    };

    Scene_Mods.prototype._drawModsHints = function () {
      var hw = this._helpWindow;
      var labels = [
        { text: "[Del] Uninstall mod", key: "hintUninstall" },
        { text: "[Enter] Install/Enable/Disable mod", key: "hintInstall" },
      ];
      var separator = "   ";
      var pad = hw.standardPadding();
      hw.contents.fontSize = 16;
      hw.contents.textColor = "#888888";
      var totalW = 0;
      for (var li = 0; li < labels.length; li++) {
        totalW += hw.contents.measureTextWidth(labels[li].text);
        if (li < labels.length - 1)
          totalW += hw.contents.measureTextWidth(separator);
      }
      var startX = Math.floor((hw.contentsWidth() - totalW) / 2);
      var y = (hw.contentsHeight() - 20) / 2;
      var curX = startX;
      this._modHintRects = {};
      for (var li = 0; li < labels.length; li++) {
        var tw = hw.contents.measureTextWidth(labels[li].text);
        hw.contents.drawText(labels[li].text, curX, y, tw + 4, 20);
        this._modHintRects[labels[li].key] = {
          x: hw.x + pad + curX,
          y: hw.y + pad + y,
          w: tw + 4,
          h: 20,
        };
        curX += tw;
        if (li < labels.length - 1)
          curX += hw.contents.measureTextWidth(separator);
      }
      hw.contents.fontSize = hw.standardFontSize();
      hw.resetTextColor();
    };

    Scene_Mods.prototype._drawOfflineBadge = function () {
      var hw = this._helpWindow;
      if (this._offlineBadgeRect) {
        var r = this._offlineBadgeRect;
        // Clear 1px wider on each side to catch anti-aliasing bleed.
        hw.contents.clearRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
        this._offlineBadgeRect = null;
      }
      // Uses module-level _cachedOffline (probe-confirmed) so Android WebView's
      // unreliable navigator.onLine doesn't suppress the badge.
      if (!_cachedOffline) return;

      var label = "OFFLINE";
      var badgeFontSize = 14;
      var dotR = 4;
      var dotGap = 6;
      var hPad = 8;
      var textPad = hw.textPadding ? hw.textPadding() : 6;

      var savedSize = hw.contents.fontSize;
      // Measure "Mods" at the title font size to find where it ends on the bitmap.
      // Window_Help.refresh calls drawTextEx(text, textPadding(), 0).
      hw.contents.fontSize = hw.standardFontSize ? hw.standardFontSize() : 28;
      var modsW = hw.contents.measureTextWidth("Mods");

      hw.contents.fontSize = badgeFontSize;
      var labelW = hw.contents.measureTextWidth(label);

      // Span the full content height so the badge aligns with the "Mods" text row.
      var badgeH = hw.contentsHeight();
      var badgeY = 0;
      var badgeW = hPad + dotR * 2 + dotGap + labelW + hPad;
      var badgeX = textPad + modsW + 8;

      hw.contents.fillRect(badgeX, badgeY, badgeW, badgeH, "rgba(110,20,30,0.88)");

      var dotCX = badgeX + hPad + dotR;
      var dotCY = Math.floor(badgeH / 2);
      hw.contents.drawCircle(dotCX, dotCY, dotR, "#ff5f6e");

      hw.contents.textColor = "#ffd5d8";
      var lineH = badgeFontSize + 4;
      var textX = dotCX + dotR + dotGap;
      var textY = Math.floor((badgeH - lineH) / 2);
      hw.contents.drawText(label, textX, textY, labelW + 2, lineH);

      this._offlineBadgeRect = { x: badgeX, y: badgeY, w: badgeW, h: badgeH };
      hw.contents.fontSize = savedSize;
      hw.resetTextColor();
    };

    Scene_Mods.prototype.createListWindow = function () {
      var y = this._helpWindow.height;
      if (this._activeModWindow) y += this._activeModWindow.height;
      var width = Graphics.boxWidth;
      var height = Graphics.boxHeight - y;
      // When the pin is present, show 4 list rows so list row height
      // matches pin row height. Without a pin the list reverts to the
      // original 5-row layout.
      var maxVisible = this._activeModWindow ? 4 : 5;
      this._listWindow = new Window_ModList(0, y, width, height, maxVisible);
      this._listWindow.setHandler("ok", this.onModOk.bind(this));
      this._listWindow.setHandler("cancel", this.popScene.bind(this));
      if (this._activeModWindow) {
        // Pressing Up on the top row hops focus up to the pin instead of
        // doing nothing: paired with the pin's cursorDown override above,
        // this lets the user move freely between the two windows.
        var scene = this;
        var origCursorUp = Window_Selectable.prototype.cursorUp;
        this._listWindow.cursorUp = function (wrap) {
          if (this.index() < this.maxCols()) {
            SoundManager.playCursor();
            this.deactivate();
            scene._activeModWindow.select(0);
            scene._activeModWindow.activate();
            return;
          }
          origCursorUp.call(this, wrap);
        };
      }
      this.addWindow(this._listWindow);
      // Edge case: the list ended up empty (every entry in mods.json was
      // the active overhaul, which was filtered out). Hand initial focus
      // to the pin so input has somewhere to go.
      if (this._listWindow.maxItems() === 0 && this._activeModWindow) {
        this._listWindow.deactivate();
        this._activeModWindow.select(0);
        this._activeModWindow.activate();
      }
    };

    Scene_Mods.prototype.createConfirmWindow = function () {
      this._confirmWindow = new Window_ModConfirm();
      this._confirmWindow.setHandler("yes", this.onConfirmYes.bind(this));
      this._confirmWindow.setHandler("no", this.onConfirmNo.bind(this));
      // Cancel (Esc / B button) dismisses the popup without acting. Without
      // this handler Window_Selectable.processCancel deactivates the window
      // and leaves the scene with no active focus.
      this._confirmWindow.setHandler("cancel", this.onConfirmNo.bind(this));
      this._confirmWindow.hide();
      this._confirmWindow.deactivate();
      this.addWindow(this._confirmWindow);
    };

    Scene_Mods.prototype.start = function () {
      Scene_MenuBase.prototype.start.call(this);
      var self = this;
      // Install counts for the rows. Async and non-blocking: the menu opens
      // and draws immediately, then redraws once (if) the numbers land, so a
      // slow Worker never delays the scene.
      loadInstallCounts(function () {
        if (self._listWindow) self._listWindow.refresh();
        if (self._activeModWindow) self._activeModWindow.refresh();
      });
      // Mouse position tracker for cross-window hover-to-focus. Vanilla
      // MV's TouchInput only updates x/y on press, and MouseControl keeps
      // its own _mouseX/_mouseY private, so we attach our own listener
      // scoped to this scene. Removed in terminate() to avoid leaking
      // handlers across scene transitions.
      this._modsMouseX = null;
      this._modsMouseY = null;
      this._modsLastSeenMouseX = null;
      this._modsLastSeenMouseY = null;
      this._modsMouseHandler = function (e) {
        self._modsMouseX = Graphics.pageToCanvasX(e.pageX);
        self._modsMouseY = Graphics.pageToCanvasY(e.pageY);
      };
      document.addEventListener("mousemove", this._modsMouseHandler);
      // The offline indicator (defined in app/index.html) is gated by this
      // body class so it only shows in the Mods menu: the one place where
      // network state actually changes what the user can do (install).
      try {
        document.body.classList.add("mods-scene-active");
      } catch (e) {}
      this._offlineBadgeHandler = function () {
        _probeOffline(function () { self._drawOfflineBadge(); });
      };
      window.addEventListener("online", this._offlineBadgeHandler);
      window.addEventListener("offline", this._offlineBadgeHandler);
      // 5s probe while in Mods menu: Android events are unreliable so we poll;
      // desktop online/offline events are sufficient so no interval needed.
      if (_isAndroidApp) {
        this._offlineProbeInterval = setInterval(this._offlineBadgeHandler, 5000);
      }
      // Draw immediately from cached state, then kick off a fresh probe.
      self._drawOfflineBadge();
      this._offlineBadgeHandler();
      // Re-read user-imported mods (installed via modding.html, possibly while
      // this game tab was already open) before resolving install status, so a
      // freshly created mod appears without a full page reload. The boot-time
      // loadImportedMods only ran once; modding.html, by contrast, re-reads the
      // registry on every render, which is why it always shows the mod.
      loadImportedMods(function () {
        if (self._listWindow && self._listWindow.rebuild) {
          self._listWindow.rebuild();
        }
        fetchAllModStatus(function () {
          if (self._listWindow) self._listWindow.refresh();
          if (self._activeModWindow) self._activeModWindow.refresh();
        });
      });
    };

    Scene_Mods.prototype.terminate = function () {
      if (this._modsMouseHandler) {
        document.removeEventListener("mousemove", this._modsMouseHandler);
        this._modsMouseHandler = null;
      }
      if (this._offlineProbeInterval) {
        clearInterval(this._offlineProbeInterval);
        this._offlineProbeInterval = null;
      }
      if (this._offlineBadgeHandler) {
        window.removeEventListener("online", this._offlineBadgeHandler);
        window.removeEventListener("offline", this._offlineBadgeHandler);
        this._offlineBadgeHandler = null;
      }
      // Restore 30s background probe now that the Mods menu is closed.
      try {
        document.body.classList.remove("mods-scene-active");
      } catch (e) {}
      Scene_MenuBase.prototype.terminate.call(this);
    };

    Scene_Mods.prototype.update = function () {
      // Cross-window touch focus must run BEFORE the children update, so
      // the now-active window's own processTouch (called from its update)
      // can consume the same touch-trigger event we used to swap focus.
      // Without this, clicking the pin while the list is focused would be
      // silently dropped: the list's processTouch sees the touch outside
      // its frame and the pin's processTouch is gated on this.active.
      this._processCrossWindowTouch();
      Scene_MenuBase.prototype.update.call(this);
      // Del key: list and pin handle their own selection's uninstall.
      if (Input.isTriggered("delete")) {
        if (this._listWindow && this._listWindow.active) {
          this._handleDelete(this._listWindow);
        } else if (this._activeModWindow && this._activeModWindow.active) {
          this._handleDelete(this._activeModWindow);
        }
      }
      // Hint button click detection (only with mouse control enabled)
      var hintWin = null;
      if (this._listWindow && this._listWindow.active) {
        hintWin = this._listWindow;
      } else if (this._activeModWindow && this._activeModWindow.active) {
        hintWin = this._activeModWindow;
      }
      if (
        isPluginActive("_mouseControl") &&
        this._modHintRects &&
        hintWin &&
        !this._pendingAction &&
        TouchInput.isTriggered()
      ) {
        var tx = TouchInput.x;
        var ty = TouchInput.y;
        var rUninstall = this._modHintRects.hintUninstall;
        var rInstall = this._modHintRects.hintInstall;
        if (
          rUninstall &&
          tx >= rUninstall.x &&
          tx <= rUninstall.x + rUninstall.w &&
          ty >= rUninstall.y &&
          ty <= rUninstall.y + rUninstall.h
        ) {
          this._handleDelete(hintWin);
        } else if (
          rInstall &&
          tx >= rInstall.x &&
          tx <= rInstall.x + rInstall.w &&
          ty >= rInstall.y &&
          ty <= rInstall.y + rInstall.h
        ) {
          if (hintWin === this._activeModWindow) {
            this.onActiveModOk();
          } else {
            this.onModOk();
          }
        }
      }
    };

    Scene_Mods.prototype._handleDelete = function (sourceWin) {
      var mod = sourceWin.selectedMod && sourceWin.selectedMod();
      if (!mod) return;
      if (isBuiltIn(mod) && isPluginType(mod.type)) {
        // Built-in plugin: Del disables instead of uninstalling, since the
        // files are shipped with the app and can't actually be removed.
        if (isPluginActive(mod.key)) {
          this._showConfirm(
            "Disable " + mod.name + "?",
            "disablePlugin",
            mod,
            sourceWin,
          );
        }
        return;
      }
      if (_modStatus[mod.key] && _modStatus[mod.key].installed) {
        this._showConfirm(
          "Uninstall " + mod.name + "?",
          "uninstall",
          mod,
          sourceWin,
        );
      }
    };

    Scene_Mods.prototype._processCrossWindowTouch = function () {
      if (!this._activeModWindow) return;
      if (this._pendingAction) return;
      if (this._confirmWindow && this._confirmWindow.active) return;
      var aw = this._activeModWindow;
      var lw = this._listWindow;

      // Two signals trigger a focus swap: a click anywhere on canvas
      // (TouchInput.isTriggered) and a fresh mouse movement while the
      // cursor is over the inactive window. The hover path lets the pin
      // highlight on mouse-over without first clicking, so MouseControl's
      // hover-to-select can then drive its cursor inside the pin. We gate
      // hover on actual movement so keyboard navigation isn't disturbed
      // when the mouse is parked over either window.
      var tx, ty;
      var clicked = TouchInput.isTriggered();
      if (clicked) {
        tx = TouchInput.x;
        ty = TouchInput.y;
      } else if (
        this._modsMouseX != null &&
        (this._modsMouseX !== this._modsLastSeenMouseX ||
          this._modsMouseY !== this._modsLastSeenMouseY)
      ) {
        tx = this._modsMouseX;
        ty = this._modsMouseY;
        this._modsLastSeenMouseX = tx;
        this._modsLastSeenMouseY = ty;
      } else {
        return;
      }

      function inside(win) {
        return (
          win &&
          tx >= win.x &&
          ty >= win.y &&
          tx < win.x + win.width &&
          ty < win.y + win.height
        );
      }
      if (lw && lw.active && inside(aw) && !inside(lw)) {
        SoundManager.playCursor();
        lw.deactivate();
        aw.select(0);
        aw.activate();
      } else if (
        aw.active &&
        lw &&
        lw.maxItems() > 0 &&
        inside(lw) &&
        !inside(aw)
      ) {
        SoundManager.playCursor();
        aw.deactivate();
        lw.activate();
      }
    };

    Scene_Mods.prototype._showConfirm = function (
      message,
      action,
      mod,
      sourceWin,
    ) {
      this._pendingAction = { type: action, mod: mod };
      // Track which window opened the prompt so a "No" answer hands focus
      // back to it (otherwise pin-initiated cancels would dump the user
      // into the list).
      this._confirmSource = sourceWin || this._listWindow;
      if (this._listWindow) this._listWindow.deactivate();
      if (this._activeModWindow) this._activeModWindow.deactivate();
      this._confirmWindow.setInfo(false);
      this._confirmWindow.setMessage(message);
      this._confirmWindow.show();
      this._confirmWindow.activate();
      this._confirmWindow.select(1);
      SoundManager.playOk();
    };

    // Single-OK info popup. Used to surface conditions the user can't act
    // on from the menu (e.g. trying to install a remote mod while offline)
    // without a confirmation choice.
    Scene_Mods.prototype._showInfo = function (message, sourceWin) {
      this._pendingAction = null;
      this._confirmSource = sourceWin || this._listWindow;
      if (this._listWindow) this._listWindow.deactivate();
      if (this._activeModWindow) this._activeModWindow.deactivate();
      this._confirmWindow.setInfo(true);
      this._confirmWindow.setMessage(message);
      this._confirmWindow.show();
      this._confirmWindow.activate();
      this._confirmWindow.select(0);
      SoundManager.playBuzzer();
    };

    Scene_Mods.prototype.onModOk = function () {
      var mod = this._listWindow.selectedMod();
      if (!mod) {
        this._listWindow.activate();
        return;
      }

      var status = _modStatus[mod.key];
      var installed = status && status.installed;

      if (!installed && isBuiltIn(mod) && isPluginType(mod.type)) {
        // Built-in plugin: toggle enable/disable (no install step: shipped with app)
        if (!isPluginActive(mod.key)) {
          if (!isModAvailable(mod)) {
            // Base-game-only plugin while a non-translation overhaul is
            // active. Surface the constraint as an info popup so the user
            // understands why the toggle didn't take.
            var blockerName = mod.name;
            var activeKey = getActiveMod();
            var mods = getModList();
            for (var _bi = 0; _bi < mods.length; _bi++) {
              if (mods[_bi].key === activeKey) {
                blockerName = mods[_bi].name;
                break;
              }
            }
            this._showInfo(
              mod.name +
                " is only available on the base game. Disable " +
                blockerName +
                " first.",
            );
            return;
          }
          setPluginActive(mod.key, true);
          // Built-in plugins have no install action to count (they ship with
          // the app), so first enable is the adoption event worth recording --
          // like a translation's first activation. trackModInstall de-dupes,
          // so re-enabling never recounts.
          trackModInstall(mod.key);
          SoundManager.playOk();
          var self = this;
          loadPluginMod(mod.key, function () {
            self._listWindow.refresh();
            self._listWindow.activate();
          });
          this._listWindow.refresh();
          this._listWindow.activate();
        } else {
          this._showConfirm("Disable " + mod.name + "?", "disablePlugin", mod);
        }
        return;
      }

      if (!installed) {
        if (_modStatus[mod.key] && _modStatus[mod.key]._downloading) {
          // Already downloading in the background (possibly started in an
          // earlier visit to this menu). Re-selecting it is a no-op -- the row
          // shows live progress -- so just keep the list navigable.
          this._listWindow.activate();
          return;
        }
        // Install is the only mod operation that needs the network. Enable
        // / disable / uninstall all work entirely against IDB and the SW,
        // so we don't block those. Built-in mods are shipped with the app
        // and are handled by the early branch above (no install step), so
        // by the time we get here we're looking at a remote mod that must
        // be downloaded. Surface a popup offline instead of swallowing the
        // tap with a buzzer.
        if (navigator.onLine === false) {
          this._showInfo("You need an internet connection");
          return;
        }
        this._showConfirm("Install " + mod.name + "?", "install", mod);
        return;
      }

      if (isPluginType(mod.type)) {
        if (isPluginActive(mod.key)) {
          this._showConfirm("Disable " + mod.name + "?", "disablePlugin", mod);
        } else {
          setPluginActive(mod.key, true);
          SoundManager.playOk();
          var self = this;
          loadPluginMod(mod.key, function () {
            self._listWindow.refresh();
            self._listWindow.activate();
          });
          this._listWindow.refresh();
          this._listWindow.activate();
        }
        return;
      }

      if (getActiveMod() === mod.key) {
        this._showConfirm("Disable " + mod.name + "?", "disableOverhaul", mod);
      } else if (getActiveMod()) {
        var currentMod = getActiveMod();
        var currentName = currentMod;
        var mods = getModList();
        for (var i = 0; i < mods.length; i++) {
          if (mods[i].key === currentMod) {
            currentName = mods[i].name;
            break;
          }
        }
        this._showConfirm(
          "Enable " + mod.name + "? This will disable " + currentName,
          "switchOverhaul",
          mod,
        );
      } else {
        this._showConfirm("Enable " + mod.name + "?", "enableOverhaul", mod);
      }
    };

    // Refresh whichever Mods scene is currently on screen. Install runs in the
    // background and its callbacks outlive the scene the user started it from
    // (they can browse other rows, return to the active-mod pin, or leave the
    // scene entirely), so a callback must never poke a torn-down window -- it
    // targets the live Scene_Mods, if one happens to be showing.
    function refreshModsListUI() {
      var scene = SceneManager._scene;
      if (!scene || !(scene instanceof window.Scene_Mods)) return;
      if (scene._listWindow) scene._listWindow.refresh();
      if (scene._activeModWindow) scene._activeModWindow.refresh();
    }

    Scene_Mods.prototype.onConfirmYes = function () {
      this._confirmWindow.hide();
      this._confirmWindow.deactivate();

      var action = this._pendingAction;
      this._pendingAction = null;
      if (!action) {
        // Info popups (_showInfo) leave pendingAction null and dismiss back
        // to the source window so focus mirrors the Yes/No cancel flow.
        var src = this._confirmSource || this._listWindow;
        this._confirmSource = null;
        src.activate();
        return;
      }

      var mod = action.mod;
      var self = this;

      switch (action.type) {
        case "install":
          // Guard against launching a duplicate download: if one is already in
          // flight for this mod (e.g. started on an earlier visit to the menu),
          // just refocus the list and bail. Two concurrent downloads writing
          // the same IDB keys would fight over the shared progress bar.
          if (_modStatus[mod.key] && _modStatus[mod.key]._downloading) {
            this._listWindow.activate();
            break;
          }
          if (!_modStatus[mod.key]) _modStatus[mod.key] = {};
          // Fire the download off in the background, then hand focus straight
          // back to the list: the row draws its own progress (drawModRow fill +
          // "Installing..." label, both driven by these _modStatus fields), so
          // the menu stays fully navigable -- the user can browse other mods,
          // hop to the active-mod pin, or leave the scene while files stream
          // in. Progress lives on the module-global _modStatus (not this scene
          // instance) so it survives leaving and re-entering the menu.
          _modStatus[mod.key]._downloading = true;
          _modStatus[mod.key]._progress = "Connecting...";
          _modStatus[mod.key]._percent = 0;
          _modStatus[mod.key]._percentShown = 0;
          _modStatus[mod.key]._error = null;
          this._installing = mod.key;
          this._listWindow.refresh();
          this._listWindow.activate();

          installMod(
            mod.key,
            mod.path,
            function onProgress(d) {
              var st = _modStatus[mod.key];
              if (!st) return;
              if (typeof d.percent === "number") st._percent = d.percent;
              st._progress = d.message || "Installing... " + d.percent + "%";
              refreshModsListUI();
            },
            function onDone(d) {
              var st = _modStatus[mod.key];
              st.installed = true;
              st.version = d.version || "";
              st._downloading = false;
              st._percent = 100;
              st._percentShown = 100;
              if (self._installing === mod.key) self._installing = null;
              trackModInstall(mod.key);
              if (isPluginType(mod.type)) {
                setPluginActive(mod.key, true);
                loadPluginMod(mod.key, function () {
                  refreshModsListUI();
                });
              } else {
                // An overhaul's translations are bundled with it: pull every
                // language under "<mod.key>_translations" now, so they're ready
                // (and offline-capable) by the time the user enables this mod
                // and opens its Language menu.
                ensureTranslationsFor(mod.key);
                refreshModsListUI();
              }
              // Do not steal focus on completion: the user may have moved to
              // another row or the pin while the download ran. The refresh
              // above just redraws the finished row in place.
            },
            function onError(msg) {
              var st = _modStatus[mod.key];
              st._downloading = false;
              st._error = msg;
              if (self._installing === mod.key) self._installing = null;
              refreshModsListUI();
            },
          );
          break;

        case "enableOverhaul":
          setActiveMod(mod.key, function () {
            AudioManager.stopAll();
            location.reload();
          });
          break;

        case "switchOverhaul":
          setActiveMod(mod.key, function () {
            AudioManager.stopAll();
            location.reload();
          });
          break;

        case "disableOverhaul":
          setActiveMod(null, function () {
            AudioManager.stopAll();
            location.reload();
          });
          break;

        case "disablePlugin":
          setPluginActive(mod.key, false);
          AudioManager.stopAll();
          location.reload();
          break;

        case "uninstall":
          var wasActive = getActiveMod() === mod.key;
          var wasPlugin = isPluginActive(mod.key);
          if (wasPlugin) setPluginActive(mod.key, false);
          uninstallMod(mod.key, function () {
            if (wasActive) {
              AudioManager.stopAll();
              location.reload();
              return;
            }
            self._listWindow.refresh();
            self._listWindow.activate();
          });
          break;

        default:
          this._listWindow.activate();
      }
    };

    Scene_Mods.prototype.onConfirmNo = function () {
      this._confirmWindow.hide();
      this._confirmWindow.deactivate();
      this._pendingAction = null;
      var src = this._confirmSource || this._listWindow;
      this._confirmSource = null;
      src.activate();
    };

    // Window_ModConfirm: Yes/No confirmation dialog
    window.Window_ModConfirm = function () {
      this.initialize.apply(this, arguments);
    };

    Window_ModConfirm.prototype = Object.create(Window_Command.prototype);
    Window_ModConfirm.prototype.constructor = Window_ModConfirm;

    Window_ModConfirm.prototype.initialize = function () {
      this._message = "";
      this._infoMode = false;
      Window_Command.prototype.initialize.call(this, 0, 0);
      this.updatePlacement();
      this.openness = 255;
    };

    Window_ModConfirm.prototype.windowWidth = function () {
      if (this._message) {
        var textW =
          this.textWidth(this._message) + this.standardPadding() * 2 + 24;
        return Math.max(360, Math.min(textW, Graphics.boxWidth - 40));
      }
      return 360;
    };
    Window_ModConfirm.prototype.windowHeight = function () {
      // One line for the message + one line per command (Yes/No -> 2, OK -> 1)
      return this.fittingHeight(this._infoMode ? 2 : 3);
    };

    Window_ModConfirm.prototype.updatePlacement = function () {
      this.x = (Graphics.boxWidth - this.width) / 2;
      this.y = (Graphics.boxHeight - this.height) / 2;
    };

    // Switch between Yes/No confirm and single-OK info popups. Reuses one
    // window instance: callers pair this with _showConfirm / _showInfo.
    Window_ModConfirm.prototype.setInfo = function (isInfo) {
      var next = !!isInfo;
      if (this._infoMode === next) return;
      this._infoMode = next;
      this.height = this.windowHeight();
      this.clearCommandList();
      this.makeCommandList();
      this.createContents();
      this.updatePlacement();
      this.refresh();
    };

    Window_ModConfirm.prototype.setMessage = function (msg) {
      this._message = msg;
      this.width = this.windowWidth();
      this.updatePlacement();
      this.createContents();
      this.refresh();
    };

    Window_ModConfirm.prototype.makeCommandList = function () {
      if (this._infoMode) {
        this.addCommand("OK", "yes");
      } else {
        this.addCommand("Yes", "yes");
        this.addCommand("No", "no");
      }
    };

    Window_ModConfirm.prototype.refresh = function () {
      Window_Command.prototype.refresh.call(this);
      if (this._message) {
        this.drawText(this._message, 0, 0, this.contentsWidth(), "center");
      }
    };

    Window_ModConfirm.prototype.itemRect = function (index) {
      var rect = Window_Command.prototype.itemRect.call(this, index);
      rect.y += this.lineHeight();
      return rect;
    };

    function isBuiltIn(mod) {
      return mod.path && mod.path.indexOf("mods/_") === 0;
    }

    // Language flags to show beside a mod's tag: English first (always: the
    // original language), then each available translation. Only language-
    // bearing mods (overhauls) get flags; plugins and translation rows get
    // none. Each entry is { key, url }; the English flag is the bundled
    // app/img/en.png.
    function getModFlagList(mod) {
      if (!mod || isPluginType(mod.type) || isTranslationType(mod.type)) {
        return [];
      }
      var list = [{ key: "__english__", url: "img/en.png" }];
      var trs = getModTranslations(mod.key);
      for (var i = 0; i < trs.length; i++) {
        list.push({
          key: trs[i].key,
          url: langRowIconUrl({ key: trs[i].key, icon: trs[i].icon }),
        });
      }
      return list;
    }

    // Preload the flag icons for every mod in `win._mods`, storing them in
    // win._iconBitmaps under "flag:<key>" so drawModTagFlags can draw them
    // synchronously. Called from each list window's _loadIcons.
    function loadModFlagIcons(win) {
      var mods = win._mods || [];
      for (var i = 0; i < mods.length; i++) {
        var flags = getModFlagList(mods[i]);
        for (var j = 0; j < flags.length; j++) {
          if (!flags[j].url) continue;
          var bmp = loadSafeBitmap(flags[j].url);
          win._iconBitmaps["flag:" + flags[j].key] = bmp;
          bmp.addLoadListener(function () {
            win.refresh();
          });
        }
      }
    }

    // Draw the small, informative row of language flags for a mod, starting at
    // x and vertically centred on the line whose top is `topY`. Each flag is
    // scaled to the tag's text height with a small gap between them. Purely
    // informative: not interactive. Bitmaps come from win._iconBitmaps
    // ("flag:<key>"), preloaded by loadModFlagIcons.
    function drawModTagFlags(win, mod, x, topY, iconCache) {
      var flags = getModFlagList(mod);
      if (!flags.length) return;
      var flagH = win.contents.fontSize + 2;
      var gap = 6;
      var fy = topY + Math.floor((win.lineHeight() - flagH) / 2);
      var maxX = win.contents.width - 4;
      for (var i = 0; i < flags.length; i++) {
        var bmp = iconCache && iconCache["flag:" + flags[i].key];
        if (!bmp || !bmp.isReady() || bmp.width <= 1) continue;
        var fw = Math.max(1, Math.round((bmp.width * flagH) / bmp.height));
        if (x + fw > maxX) break;
        win.contents.blt(bmp, 0, 0, bmp.width, bmp.height, x, fy, fw, flagH);
        x += fw + gap;
      }
    }

    // Shared per-row renderer for Window_ModList and Window_ModActive so
    // both surfaces display a mod with the exact same layout. The right column
    // reads top-to-bottom: a single status label (line 1), then the last-update
    // date (line 2) and the install count (line 3) as metadata below it. The
    // left column is name + by-author (line 1), the type tag (line 2), and the
    // description (line 3). Options:
    //   showTypeTag        omit the [Type] badge in the middle column (pin)
    //   showInstallStatus  omit the right-side status label, one of
    //                      Not installed / Disabled / Enabled (plus the
    //                      Installing.../Error/Unavailable states), shown one
    //                      at a time (pin: the active mod is installed and
    //                      enabled by definition, so the [Active ...] tag on
    //                      line 2 already says so)
    //   showEnabledBadge   legacy no-op: the Enabled/Disabled state is folded
    //                      into the single status label above, kept only so
    //                      existing callers' opts stay valid
    //   showActiveLabel    draw "[Active overhaul mod]" / "[Active
    //                      translation mod]" in green on line 2 (pin:
    //                      replaces the type tag, which would be redundant
    //                      with the existence of the pin itself)
    function drawModRow(win, mod, rect, isActive, iconCache, opts) {
      opts = opts || {};
      var showTypeTag = opts.showTypeTag !== false;
      var showInstallStatus = opts.showInstallStatus !== false;
      var showActiveLabel = !!opts.showActiveLabel;
      var lineHeight = win.lineHeight();
      var pad = rect.x;

      var iconH = rect.height - pad * 2;
      var iconW = Math.floor((iconH * 16) / 9);
      var textX = rect.x + iconW + 8;
      var iconY = rect.y + pad;

      // While this mod is downloading, the row doubles as its own progress
      // bar: a blue accent fills left-to-right in proportion to the install
      // percentage, slowly taking over the grey "not installed" base painted
      // underneath (drawItem) so the filled part reads blue and the rest stays
      // grey. A brighter baseline keeps it legible under the text.
      // _percentShown is eased toward the real _percent by the list window's
      // update loop, so the fill glides smoothly between the coarse steps
      // installMod reports. Drawn under the icon and text.
      var dlSt = _modStatus[mod.key];
      if (dlSt && dlSt._downloading) {
        var pctRaw =
          typeof dlSt._percentShown === "number"
            ? dlSt._percentShown
            : typeof dlSt._percent === "number"
              ? dlSt._percent
              : 0;
        var pct = Math.max(0, Math.min(100, pctRaw));
        // Span the full row width, not the text-inset rect: the grey base is
        // painted across the whole itemRect, so starting the fill at rect.x
        // (inset by textPadding) would leave a thin grey strip clinging to the
        // far-left edge. Outset by textPadding to line the two up exactly.
        var tp = win.textPadding ? win.textPadding() : 0;
        var rowX = rect.x - tp;
        var rowW = rect.width + tp * 2;
        var fillW = Math.floor((rowW * pct) / 100);
        if (fillW > 0) {
          win.contents.fillRect(
            rowX,
            rect.y,
            fillW,
            rect.height,
            "rgba(120,210,255,0.24)",
          );
          win.contents.fillRect(
            rowX,
            rect.y + rect.height - 3,
            fillW,
            3,
            "rgba(120,210,255,0.6)",
          );
        }
      }

      var iconBmp = iconCache && iconCache[mod.key];
      var src =
        iconBmp && iconBmp.isReady() && iconBmp.width > 1
          ? iconBmp
          : getDefaultModIcon();
      if (src && src.isReady() && src.width > 1) {
        var scale = Math.min(iconW / src.width, iconH / src.height);
        var dw = Math.floor(src.width * scale);
        var dh = Math.floor(src.height * scale);
        var ix = rect.x + Math.floor((iconW - dw) / 2);
        var iy = iconY + Math.floor((iconH - dh) / 2);
        win.contents.blt(src, 0, 0, src.width, src.height, ix, iy, dw, dh);
      }

      var availW = rect.width - (textX - rect.x);

      // Line 1: mod name + "by author" (left), date (right)
      win.resetTextColor();
      var nameW = win.textWidth(mod.name);
      win.drawText(mod.name, textX, rect.y, availW);
      var byX = textX + Math.min(nameW, availW) + 8;
      var byText = "by " + mod.author;
      win.contents.fontSize = 18;
      win.contents.textColor = "#aaaacc";
      win.drawText(byText, byX, rect.y + 4, rect.width - (byX - rect.x));
      win.contents.fontSize = win.standardFontSize();

      // Right side of line 1: an optional "NEW"/"UPDATED" badge pinned to the
      // far right, with the last-update date drawn to its left. The badge
      // clears once the user's cursor lands on the row (see the Window_Mod*
      // select overrides below).
      var badge = modBadge(mod);
      var badgeReserve = 0;
      if (badge) {
        win.contents.fontSize = 16;
        win.contents.textColor = badge === "NEW" ? "#7cff8a" : "#ffc04a";
        win.drawText(badge, rect.x, rect.y + 4, rect.width, "right");
        badgeReserve = win.textWidth(badge) + 10;
        win.contents.fontSize = win.standardFontSize();
      }

      // The last-update date and the install count are metadata, so they sit
      // low in the right column (lines 2 and 3) under the single status label
      // on line 1. See the right-column block further down.

      var status = _modStatus[mod.key];
      var installed = status && status.installed;
      var lineY = rect.y + lineHeight;
      // Vertical offset from line 2's top to line 3's top. Sized at half
      // the standard lineHeight so three lines of content (lineHeight +
      // smallLine + small-text descent) fit inside a 96px row with a few
      // pixels of clearance from the bottom green border around active
      // plugins. The old 0.7 ratio (=25 at lineHeight 36) was tuned for
      // the larger 103px row used before the pin existed.
      var smallLine = Math.floor(lineHeight / 2);

      // Lines 2 and 3 share a single small font size. Set it once here so
      // the right-side status (line 2), the description (line 3 left),
      // and the Enabled badge (line 3 right) all render at the same scale
      // whether or not the type tag is drawn: without this the pin
      // (which skips the tag) was inheriting standardFontSize for these
      // labels and rendering them at ~28pt.
      win.contents.fontSize = 16;

      // Line 2: type label (left, optional) + installed status (right, optional)
      if (showActiveLabel) {
        // Pin variant: identify the slot as "the active overhaul/translation
        // mod" in green, which both labels the section AND replaces the now-
        // removed right-side "Enabled" badge without duplicating its meaning.
        var activeKind = isTranslationType(mod.type)
          ? "translation"
          : "overhaul";
        var activeLabel = "[Active " + activeKind + " mod]";
        win.contents.textColor = "#88ff88";
        win.drawText(activeLabel, textX, lineY + 2, availW);
        drawModTagFlags(
          win,
          mod,
          textX + win.textWidth(activeLabel) + 10,
          lineY + 2,
          iconCache,
        );
      } else if (showTypeTag) {
        var rawType = (mod.type || "overhaul")
          .replace(/^built-in\s+/i, "")
          .replace(/\b\w/g, function (c) {
            return c.toUpperCase();
          });
        var typeLabel = "[" + rawType + "]";
        win.contents.textColor = isPluginType(mod.type)
          ? "#88bbff"
          : isTranslationType(mod.type)
            ? "#ffcc66"
            : "#ff8888";
        win.drawText(typeLabel, textX, lineY + 2, availW);
        // Informative: each language flag available for this mod, drawn at the
        // tag's text size with a small gap between them. Not interactive.
        drawModTagFlags(
          win,
          mod,
          textX + win.textWidth(typeLabel) + 10,
          lineY + 2,
          iconCache,
        );
      }

      // Line 1 (right): the single install/enable status label, exactly one
      // of Installing.../Error/Not installed/Unavailable/Enabled/Disabled, one
      // at a time. It sits to the left of any NEW/UPDATED badge (badgeReserve).
      // Built-in plugins are always installed, so they fall straight through to
      // the Unavailable/Enabled/Disabled branch.
      if (showInstallStatus) {
        var statusText;
        var statusColor = "#aaaaaa";
        if (status && status._downloading) {
          statusText = status._progress || "Installing...";
          statusColor = "#ffff88";
        } else if (status && status._error) {
          statusText = "Error: " + status._error;
          statusColor = "#ff8888";
        } else if (!installed && !isBuiltIn(mod)) {
          statusText = "Not installed";
        } else if (!isActive && !isModAvailable(mod)) {
          // Installed but gated by the active overhaul (e.g. Unlocker while a
          // non-translation overhaul is active): the toggle is unavailable
          // rather than something the user turned off.
          statusText = "Unavailable";
          statusColor = "#ffaa66";
        } else if (isActive) {
          statusText = "Enabled";
          statusColor = "#88ff88";
        } else {
          statusText = "Disabled";
        }
        win.contents.fontSize = 16;
        win.contents.textColor = statusColor;
        win.drawText(
          statusText,
          rect.x,
          rect.y + 4,
          rect.width - badgeReserve,
          "right",
        );
        win.contents.fontSize = 16;
      }

      // Line 2 (right): last-update date, muted, under the status label with a
      // blank line's worth of gap between them (line 1 -> line 2 is a full
      // lineHeight).
      if (mod.lastUpdate) {
        win.contents.fontSize = 16;
        win.resetTextColor();
        win.drawText(mod.lastUpdate, rect.x, lineY + 2, rect.width, "right");
        win.contents.fontSize = 16;
      }

      // Line 3: description (left) with the install count pinned right, drawn
      // directly under the date. Reserve the count's width so a long
      // description never runs under it. installsText is null until the counts
      // arrive (or forever offline with nothing cached), in which case the line
      // just carries the description alone.
      var installs = installCountFor(mod.key);
      var installsText =
        installs !== null ? formatInstallCount(installs, mod.type) : null;
      var installsReserve = 0;
      if (installsText) {
        win.contents.fontSize = 16;
        installsReserve = win.textWidth(installsText) + 16;
      }
      if (mod.description) {
        win.contents.fontSize = 16;
        win.contents.textColor = "#cccccc";
        // GameFont ships CJK Unified Ideographs glyphs but no Hangul/Thai/etc.
        // Canvas 2D falls back per-codepoint when the font-family list has
        // more than one entry, so append system fallbacks to cover scripts
        // the base font lacks (notably Korean for "한국어").
        var _prevFace = win.contents.fontFace;
        win.contents.fontFace =
          _prevFace +
          ', "Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
        win.drawText(
          mod.description,
          textX,
          lineY + smallLine + 2,
          Math.max(0, availW - installsReserve),
        );
        win.contents.fontFace = _prevFace;
      }
      if (installsText) {
        // Muted so the count reads as metadata rather than status.
        win.contents.fontSize = 16;
        win.contents.textColor = "#aaaacc";
        win.drawText(
          installsText,
          rect.x,
          lineY + smallLine + 2,
          rect.width,
          "right",
        );
      }

      win.contents.fontSize = win.standardFontSize();
      win.resetTextColor();
    }

    // Window_ModActive: dedicated framed rectangle showing the active
    // overhaul/translation mod above the main list. It's a real
    // Window_Selectable with a single item so the engine handles hover,
    // touch-to-trigger, and the [Enter]/[Del] handlers exactly like a
    // one-row Window_ModList: the user can disable or uninstall the active
    // mod from the pin without scrolling to find it. The pin uses the
    // standard windowskin (rounded corners, translucent fill) just like
    // every other RPG Maker MV menu panel.
    window.Window_ModActive = function () {
      this.initialize.apply(this, arguments);
    };

    Window_ModActive.prototype = Object.create(Window_Selectable.prototype);
    Window_ModActive.prototype.constructor = Window_ModActive;

    Window_ModActive.prototype.initialize = function (
      x,
      y,
      width,
      height,
      mod,
    ) {
      this._mods = [mod];
      this._iconBitmaps = {};
      Window_Selectable.prototype.initialize.call(this, x, y, width, height);
      this._loadIcons();
      this.refresh();
      this.select(0);
      // Past the initial auto-select: from here on a select() means the user
      // moved the cursor onto the row, which counts as "seen" for the badge.
      this._seenReady = true;
    };

    // Mark the pinned mod as seen once the user actually lands on it (hover or
    // keyboard), not on the initial auto-select during initialize.
    Window_ModActive.prototype.select = function (index) {
      Window_Selectable.prototype.select.call(this, index);
      if (this._seenReady && index >= 0) {
        var mod = this._mods[index];
        if (mod && markModSeen(mod)) this.refresh();
      }
    };

    Window_ModActive.prototype.maxItems = function () {
      return 1;
    };

    Window_ModActive.prototype.maxCols = function () {
      return 1;
    };

    Window_ModActive.prototype.itemHeight = function () {
      // Single item fills the full content area.
      return this.height - this.padding * 2;
    };

    Window_ModActive.prototype._itemGap = function () {
      return 6;
    };

    Window_ModActive.prototype.itemRect = function (index) {
      // Mirror Window_ModList's itemRect tweak so the row content inside
      // the pin has the exact same visible height (and therefore icon size,
      // text positions) as a row in the list below. Without this the pin's
      // row would be 6px taller than a list row and the layouts would drift
      // out of sync.
      var rect = Window_Selectable.prototype.itemRect.call(this, index);
      var gap = this._itemGap();
      rect.y += Math.floor(gap / 2);
      rect.height -= gap;
      return rect;
    };

    Window_ModActive.prototype._loadIcons = function () {
      var self = this;
      var mod = this._mods[0];
      if (mod && mod.icon) {
        var bmp = loadSafeBitmap(modIconUrl(mod.icon));
        this._iconBitmaps[mod.key] = bmp;
        bmp.addLoadListener(function () {
          self.refresh();
        });
      }
      loadModFlagIcons(this);
      var def = getDefaultModIcon();
      if (def) {
        def.addLoadListener(function () {
          self.refresh();
        });
      }
    };

    Window_ModActive.prototype.drawItem = function (index) {
      var mod = this._mods[index];
      if (!mod) return;
      var rect = this.itemRectForText(index);
      // The pin only ever hosts the currently-active overhaul/translation,
      // so the type badge would be redundant and the install status is
      // always "installed" (otherwise the mod couldn't be active). The
      // right-side "Enabled" badge is also suppressed here: the green
      // "[Active ... mod]" tag on line 2 already labels the slot, and the
      // duplicate marker cluttered the row.
      drawModRow(this, mod, rect, true, this._iconBitmaps, {
        showTypeTag: false,
        showInstallStatus: false,
        showEnabledBadge: false,
        showActiveLabel: true,
      });
    };

    Window_ModActive.prototype.selectedMod = function () {
      return this._mods[0] || null;
    };

    // Window_ModList: mod list
    window.Window_ModList = function () {
      this.initialize.apply(this, arguments);
    };

    Window_ModList.prototype = Object.create(Window_Selectable.prototype);
    Window_ModList.prototype.constructor = Window_ModList;

    Window_ModList.prototype.initialize = function (
      x,
      y,
      width,
      height,
      maxVisible,
    ) {
      // The active overhaul/translation mod is hoisted into its own pin
      // window (Window_ModActive) above this list, so we hide it here to
      // keep it from appearing twice. Plugin-type mods stay in the list
      // regardless of their active state since multiple plugins can be
      // active at once and they're not represented by the pin.
      this._mods = buildModListRows();
      this._iconBitmaps = {};
      // When the pin is shown above us, the scene passes 4 so a list row
      // ends up the same height as the pin row (boxH-helpH split into
      // 5 equal rows: 1 pin + 4 list). Without a pin we keep the original
      // 5-row layout.
      this._maxVisible = maxVisible || 5;
      Window_Selectable.prototype.initialize.call(this, x, y, width, height);
      this._loadIcons();
      this.refresh();
      this.select(0);
      // Past the initial auto-select: subsequent select() calls come from the
      // user hovering or navigating, which marks the row as seen.
      this._seenReady = true;
      this.activate();
    };

    // Mark the highlighted mod as seen on hover/navigation so its NEW/UPDATED
    // badge clears. Guarded by _seenReady so the initial auto-select doesn't
    // silently consume the badge before the user has looked at the row.
    Window_ModList.prototype.select = function (index) {
      Window_Selectable.prototype.select.call(this, index);
      if (this._seenReady && index >= 0 && index < this._mods.length) {
        var mod = this._mods[index];
        if (mod && markModSeen(mod)) this.refresh();
      }
    };

    // Rebuild the row models from the current _modsData. Called when the Mods
    // scene opens after re-reading user-imported mods, so a mod installed via
    // modding.html while this game tab was already open (no page reload) shows
    // up without restarting the game. Mirrors the filter in initialize (the
    // active overhaul/translation lives in the pin, not the list).
    Window_ModList.prototype.rebuild = function () {
      var prevLen = this._mods ? this._mods.length : 0;
      this._mods = buildModListRows();
      this._iconBitmaps = {};
      this._loadIcons();
      if (this.index() >= this._mods.length) {
        this.select(this._mods.length > 0 ? this._mods.length - 1 : -1);
      }
      this.refresh();
      // Nothing was selectable before (empty list handed focus to the pin);
      // now that rows exist, take focus so the new mod is reachable.
      if (prevLen === 0 && this._mods.length > 0 && !this.active) {
        this.select(0);
        this.activate();
      }
    };

    Window_ModList.prototype._loadIcons = function () {
      var self = this;
      for (var i = 0; i < this._mods.length; i++) {
        var mod = this._mods[i];
        if (mod.icon) {
          var bmp = loadSafeBitmap(modIconUrl(mod.icon));
          this._iconBitmaps[mod.key] = bmp;
          bmp.addLoadListener(function () {
            self.refresh();
          });
        }
      }
      loadModFlagIcons(this);
      var defIcon = getDefaultModIcon();
      if (defIcon) {
        defIcon.addLoadListener(function () {
          self.refresh();
        });
      }
    };

    Window_ModList.prototype.maxItems = function () {
      return this._mods.length;
    };

    Window_ModList.prototype.maxVisibleItems = function () {
      return this._maxVisible;
    };

    Window_ModList.prototype.itemHeight = function () {
      var innerHeight = this.height - this.padding * 2;
      return Math.floor(innerHeight / this.maxVisibleItems());
    };

    Window_ModList.prototype._itemGap = function () {
      return 6;
    };

    Window_ModList.prototype.itemRect = function (index) {
      var rect = Window_Selectable.prototype.itemRect.call(this, index);
      var gap = this._itemGap();
      rect.y += Math.floor(gap / 2);
      rect.height -= gap;
      return rect;
    };

    Window_ModList.prototype.selectedMod = function () {
      var idx = this.index();
      return idx >= 0 && idx < this._mods.length ? this._mods[idx] : null;
    };

    Window_ModList.prototype.drawItem = function (index) {
      var mod = this._mods[index];
      if (!mod) return;

      var rect = this.itemRectForText(index);

      var isActive = isPluginType(mod.type)
        ? isPluginActive(mod.key)
        : getActiveMod() === mod.key;

      // Not-installed mods/plugins get a muted grey wash so the list visually
      // separates "ready to use" rows from ones that still need downloading.
      // Built-in plugins ship with the app (always available, never "not
      // installed") so they never get the wash. A row that is mid-download is
      // still "not installed", so it keeps the grey base too -- the blue
      // progress fill (drawn on top in drawModRow) then slowly takes it over
      // as the install advances.
      var st = _modStatus[mod.key];
      var isInstalled = st && st.installed;
      if (!isInstalled && !isBuiltIn(mod)) {
        var wash = this.itemRect(index);
        this.contents.fillRect(
          wash.x,
          wash.y,
          wash.width,
          wash.height,
          "rgba(44,44,48,0.75)",
        );
      }

      // Active plugins get a green border in the list (overhaul/translation
      // active are already hoisted out into Window_ModActive, so they never
      // reach this branch here).
      if (isActive && isPluginType(mod.type)) {
        var bgRect = this.itemRect(index);
        var borderColor = "#88ff88";
        var t = 2;
        this.contents.fillRect(
          bgRect.x,
          bgRect.y,
          bgRect.width,
          t,
          borderColor,
        );
        this.contents.fillRect(
          bgRect.x,
          bgRect.y + bgRect.height - t,
          bgRect.width,
          t,
          borderColor,
        );
        this.contents.fillRect(
          bgRect.x,
          bgRect.y,
          t,
          bgRect.height,
          borderColor,
        );
        this.contents.fillRect(
          bgRect.x + bgRect.width - t,
          bgRect.y,
          t,
          bgRect.height,
          borderColor,
        );
      }

      drawModRow(this, mod, rect, isActive, this._iconBitmaps, {
        showTypeTag: true,
      });
    };

    // Ease each downloading row's fill toward its real percentage so the bar
    // glides between the coarse steps installMod reports (roughly every 20
    // files). Only visible rows that are actually mid-animation get redrawn,
    // so an idle Mods menu does zero per-frame work.
    Window_ModList.prototype.update = function () {
      Window_Selectable.prototype.update.call(this);
      var top = this.topIndex();
      var end = Math.min(top + this.maxPageItems(), this._mods.length);
      for (var i = top; i < end; i++) {
        var mod = this._mods[i];
        if (!mod) continue;
        var st = _modStatus[mod.key];
        if (!st || !st._downloading) continue;
        var target = typeof st._percent === "number" ? st._percent : 0;
        var shown = typeof st._percentShown === "number" ? st._percentShown : 0;
        if (Math.abs(target - shown) < 0.5) {
          if (shown !== target) {
            st._percentShown = target;
            this.redrawItem(i);
          }
          continue;
        }
        st._percentShown = shown + (target - shown) * 0.18;
        this.redrawItem(i);
      }
    };

    Window_ModList.prototype.playOkSound = function () {
      SoundManager.playOk();
    };

    // Language picker
    //
    // The Language menu lists, for the active context (base game or active
    // overhaul), a default English row followed by every available
    // translation. It reuses drawModRow for a layout identical to the Mods
    // list (flag icon + name + "by author" + endonym), and Window_ModConfirm
    // for the switch prompt. Selecting a language sets the active-language
    // overlay and reloads, exactly like switching an overhaul in the Mods menu.

    var ENGLISH_LANG_KEY = "__english__";

    // Build the row models: English first (icon app/img/en.png; author = the
    // active overhaul's author, or "Kit9" for the plain base game), then the
    // context's translations.
    function buildLangRows() {
      var rows = [];
      var ctx = getActiveContextMod();
      var defAuthor = "Kit9";
      if (ctx !== "BASE") {
        var oe = getModEntry(getActiveMod());
        if (oe && oe.author) defAuthor = oe.author;
      }
      rows.push({
        key: ENGLISH_LANG_KEY,
        name: "English",
        author: defAuthor,
        description: "English",
        icon: "img/en.png",
        path: "",
        isEnglish: true,
        active: !_activeLang,
      });
      var list = getContextTranslations();
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        rows.push({
          key: t.key,
          name: t.name,
          author: t.author,
          description: t.description,
          icon: t.icon,
          path: "",
          active: _activeLang === t.key,
        });
      }
      return rows;
    }

    // Icon URL for a row. English uses the bundled flag. An installed
    // translation resolves from IDB through the SW mod-asset path (offline
    // capable); otherwise fall back to the remote flag URL.
    function langRowIconUrl(L) {
      if (L.isEnglish) return "img/en.png";
      // Prefer the IDB copy (offline-capable) only when icon.png was actually
      // downloaded for this translation; some translations omit it from their
      // manifest, in which case the SW's /mods path would 404. Fall back to
      // the remote flag URL (and ultimately the default icon when offline).
      var entry = _modsData && _modsData[L.key];
      var hasLocalIcon =
        _modStatus[L.key] &&
        _modStatus[L.key].installed &&
        entry &&
        entry.files &&
        entry.files.indexOf("icon.png") >= 0;
      if (hasLocalIcon) return "/mods/" + L.key + "/www/icon.png";
      return L.icon || "";
    }

    window.Window_LangList = function () {
      this.initialize.apply(this, arguments);
    };

    Window_LangList.prototype = Object.create(Window_Selectable.prototype);
    Window_LangList.prototype.constructor = Window_LangList;

    Window_LangList.prototype.initialize = function (
      x,
      y,
      width,
      height,
      maxVisible,
    ) {
      this._langs = buildLangRows();
      this._iconBitmaps = {};
      this._maxVisible = maxVisible || 5;
      Window_Selectable.prototype.initialize.call(this, x, y, width, height);
      this._loadIcons();
      this.refresh();
      var sel = 0;
      for (var i = 0; i < this._langs.length; i++) {
        if (this._langs[i].active) {
          sel = i;
          break;
        }
      }
      this.select(sel);
      this.activate();
    };

    Window_LangList.prototype._loadIcons = function () {
      var self = this;
      for (var i = 0; i < this._langs.length; i++) {
        var L = this._langs[i];
        var url = langRowIconUrl(L);
        if (url) {
          var bmp = loadSafeBitmap(url);
          this._iconBitmaps[L.key] = bmp;
          bmp.addLoadListener(function () {
            self.refresh();
          });
        }
      }
      var def = getDefaultModIcon();
      if (def) {
        def.addLoadListener(function () {
          self.refresh();
        });
      }
    };

    Window_LangList.prototype.maxItems = function () {
      return this._langs.length;
    };
    Window_LangList.prototype.maxVisibleItems = function () {
      return this._maxVisible;
    };
    Window_LangList.prototype.itemHeight = function () {
      return Math.floor(
        (this.height - this.padding * 2) / this.maxVisibleItems(),
      );
    };
    Window_LangList.prototype._itemGap = function () {
      return 6;
    };
    Window_LangList.prototype.itemRect = function (index) {
      var rect = Window_Selectable.prototype.itemRect.call(this, index);
      var gap = this._itemGap();
      rect.y += Math.floor(gap / 2);
      rect.height -= gap;
      return rect;
    };
    Window_LangList.prototype.selectedLang = function () {
      var idx = this.index();
      return idx >= 0 && idx < this._langs.length ? this._langs[idx] : null;
    };
    Window_LangList.prototype.drawItem = function (index) {
      var L = this._langs[index];
      if (!L) return;
      // Green border on the currently-applied language (mirrors the active
      // plugin styling in Window_ModList) so it stays marked regardless of
      // where the selection cursor sits.
      if (L.active) {
        var b = this.itemRect(index);
        var c = "#88ff88";
        var t = 2;
        this.contents.fillRect(b.x, b.y, b.width, t, c);
        this.contents.fillRect(b.x, b.y + b.height - t, b.width, t, c);
        this.contents.fillRect(b.x, b.y, t, b.height, c);
        this.contents.fillRect(b.x + b.width - t, b.y, t, b.height, c);
      }
      var rect = this.itemRectForText(index);
      drawModRow(this, L, rect, !!L.active, this._iconBitmaps, {
        showTypeTag: false,
        showInstallStatus: false,
        showEnabledBadge: false,
      });
    };
    Window_LangList.prototype.playOkSound = function () {
      SoundManager.playOk();
    };

    // Scene_Language: the title-menu language picker.
    window.Scene_Language = function () {
      this.initialize.apply(this, arguments);
    };

    Scene_Language.prototype = Object.create(Scene_MenuBase.prototype);
    Scene_Language.prototype.constructor = Scene_Language;

    Scene_Language.prototype.create = function () {
      Scene_MenuBase.prototype.create.call(this);
      this._helpWindow = new Window_Help(1);
      this._helpWindow.setText("Language");
      this.addWindow(this._helpWindow);

      var y = this._helpWindow.height;
      this._listWindow = new Window_LangList(
        0,
        y,
        Graphics.boxWidth,
        Graphics.boxHeight - y,
        5,
      );
      this._listWindow.setHandler("ok", this.onLangOk.bind(this));
      this._listWindow.setHandler("cancel", this.popScene.bind(this));
      this.addWindow(this._listWindow);

      this._confirmWindow = new Window_ModConfirm();
      this._confirmWindow.setHandler("yes", this.onConfirmYes.bind(this));
      this._confirmWindow.setHandler("no", this.onConfirmNo.bind(this));
      this._confirmWindow.setHandler("cancel", this.onConfirmNo.bind(this));
      this._confirmWindow.hide();
      this._confirmWindow.deactivate();
      this.addWindow(this._confirmWindow);
    };

    Scene_Language.prototype.start = function () {
      Scene_MenuBase.prototype.start.call(this);
      var self = this;
      // Refresh install status so already-downloaded flags render from IDB
      // (offline-capable) instead of the remote URL.
      var list = getContextTranslations();
      var remaining = list.length;
      if (!remaining) return;
      for (var i = 0; i < list.length; i++) {
        checkModInstalled(list[i].key, function () {
          remaining--;
          if (remaining <= 0 && self._listWindow) {
            self._listWindow._loadIcons();
            self._listWindow.refresh();
          }
        });
      }
    };

    Scene_Language.prototype.onLangOk = function () {
      var L = this._listWindow.selectedLang();
      if (!L) {
        this._listWindow.activate();
        return;
      }
      if (L.active) {
        // Normally a no-op. But a just-migrated language can be the SELECTED
        // value while its files haven't been (re)downloaded yet: such a boot
        // runs in English until the background sync finishes and the page
        // reloads. Re-selecting it must force the install + reload rather than
        // leaving the user stuck, so only short-circuit when it's genuinely
        // ready (English, or an installed translation).
        var ready =
          L.isEnglish || (_modStatus[L.key] && _modStatus[L.key].installed);
        if (ready) {
          SoundManager.playOk();
          this._listWindow.activate();
          return;
        }
      }
      this._pendingLang = L;
      var msg = L.isEnglish
        ? "Switch to English?"
        : "Switch language to " + L.name + "?";
      this._listWindow.deactivate();
      this._confirmWindow.setInfo(false);
      this._confirmWindow.setMessage(msg);
      this._confirmWindow.show();
      this._confirmWindow.activate();
      this._confirmWindow.select(1);
      SoundManager.playOk();
    };

    Scene_Language.prototype._showInfo = function (message) {
      this._pendingLang = null;
      this._listWindow.deactivate();
      this._confirmWindow.setInfo(true);
      this._confirmWindow.setMessage(message);
      this._confirmWindow.show();
      this._confirmWindow.activate();
      this._confirmWindow.select(0);
      SoundManager.playBuzzer();
    };

    Scene_Language.prototype.onConfirmNo = function () {
      this._confirmWindow.hide();
      this._confirmWindow.deactivate();
      this._pendingLang = null;
      this._listWindow.activate();
    };

    Scene_Language.prototype.onConfirmYes = function () {
      this._confirmWindow.hide();
      this._confirmWindow.deactivate();
      var L = this._pendingLang;
      this._pendingLang = null;
      if (!L) {
        // Info-popup acknowledgement: nothing to apply.
        this._listWindow.activate();
        return;
      }
      var self = this;
      function apply() {
        // A translation's download is not a signal: every translation for the
        // active context is pulled automatically (ensureTranslationsFor /
        // ensureContextTranslations), so "installed" just means the app ran
        // once online. Choosing to USE one is the real, user-initiated event,
        // so translations are counted here, at first activation, instead.
        // English is the untranslated baseline, not a translation: nothing to
        // count. trackModInstall de-dupes, so re-activating never recounts.
        if (!L.isEnglish) trackModInstall(L.key);
        // Pull the matching base-game translation first (when this is an
        // overhaul translation) so the SW can translate the original game lines
        // it doesn't cover from the moment the page reloads, not a sync later.
        ensureBaseFallbackInstalled(L.isEnglish ? null : L.key, function () {
          setActiveLang(L.isEnglish ? null : L.key, function () {
            AudioManager.stopAll();
            location.reload();
          });
        });
      }
      if (L.isEnglish) {
        apply();
        return;
      }
      // Translations are eagerly downloaded, so this is normally already
      // installed. If not, download on demand (online) or explain (offline).
      if (_modStatus[L.key] && _modStatus[L.key].installed) {
        apply();
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        this._showInfo("You need an internet connection");
        return;
      }
      var entry = _modsData && _modsData[L.key];
      if (!entry || !entry.files || entry.files.length === 0) {
        this._showInfo("This translation is unavailable");
        return;
      }
      if (!_modStatus[L.key]) _modStatus[L.key] = {};
      _modStatus[L.key]._downloading = true;
      this._listWindow.refresh();
      installMod(
        L.key,
        entry.path,
        function () {},
        function () {
          _modStatus[L.key].installed = true;
          _modStatus[L.key]._downloading = false;
          apply();
        },
        function () {
          _modStatus[L.key]._downloading = false;
          self._showInfo("Download failed");
        },
      );
    };

    // Suppress the selection cursor while the window is inactive so the
    // mods screen only ever shows ONE highlight box at a time. Vanilla MV
    // keeps the cursor rect sized to the selected item on every Selectable
    // regardless of `active`, and Window.prototype._updateCursor only uses
    // `active` to drive the blink animation: the sprite itself stays at
    // full opacity. The result is that both the pin and the list always
    // looked simultaneously selected. We override updateCursor (the actual
    // MV method: _refreshCursor doesn't exist, so the previous version of
    // this patch was a no-op) to clear the rect when inactive, and hook
    // activate/deactivate so the cursor visibility flips immediately when
    // focus crosses windows.
    function hideCursorWhenInactive(WindowClass) {
      var origUpdateCursor =
        WindowClass.prototype.updateCursor ||
        Window_Selectable.prototype.updateCursor;
      WindowClass.prototype.updateCursor = function () {
        if (!this.active) {
          this.setCursorRect(0, 0, 0, 0);
        } else {
          origUpdateCursor.call(this);
        }
      };
      var origActivate = WindowClass.prototype.activate;
      WindowClass.prototype.activate = function () {
        origActivate.call(this);
        this.updateCursor();
      };
      var origDeactivate = WindowClass.prototype.deactivate;
      WindowClass.prototype.deactivate = function () {
        origDeactivate.call(this);
        this.updateCursor();
      };
    }
    hideCursorWhenInactive(Window_ModActive);
    hideCursorWhenInactive(Window_ModList);
    hideCursorWhenInactive(Window_LangList);

    // Background-download the active context's translations once boot has
    // settled (deferred so it doesn't compete with the initial asset loads).
    setTimeout(ensureContextTranslations, 2000);

    /*console.log(
      "[lang-shim] Mod system patches applied" +
        (_modsLoaded ? " (mods: " + getModList().length + ")" : "") +
        (getActiveMod() ? ", active: " + getActiveMod() : ""),
    );*/
  }

  // Audio load failures: AudioStreaming.js's own ResourceHandler.fetchWithRetry
  // (not stock rpg_core.js, a third-party plugin, never edited directly) has
  // two failure branches. An immediate 4xx (the realistic "missing file" case)
  // crashes synchronously via SceneManager.catchException before this function
  // could otherwise intervene, so the whole function is replaced rather than
  // wrapped: a thin try/catch wrap would run its catch only after
  // catchException already showed the permanent crash overlay. Only the two
  // failure branches change; the success-path fetch/response handling is
  // copied verbatim from the shipped plugin so behavior for a working asset
  // is unchanged.
  function patchAudioResourceHandler() {
    if (typeof ResourceHandler === "undefined") return;
    if (typeof ResourceHandler.fetchWithRetry !== "function") return;
    if (ResourceHandler.__ignorePatchApplied) return;
    ResourceHandler.__ignorePatchApplied = true;

    function alwaysIgnoreEnabled() {
      try {
        return localStorage.getItem("_alwaysIgnoreLoadErrors") === "1";
      } catch (e) {
        return false;
      }
    }

    ResourceHandler.fetchWithRetry = async function (
      method,
      url,
      _retryCount,
    ) {
      if (_retryCount === undefined) _retryCount = 0;
      let retry;
      try {
        const response = await (!window.cordova
          ? fetch(url, { credentials: "same-origin" })
          : new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.responseType = "blob";
              xhr.onload = () =>
                resolve(new Response(xhr.response, { status: xhr.status }));
              xhr.onerror = reject;
              xhr.open("GET", url);
              xhr.send();
            }));
        if (response.ok) {
          switch (method) {
            case "stream":
              if (response.body) {
                return response.body.getReader();
              }
              const value = new Uint8Array(await response.arrayBuffer());
              return {
                _done: false,
                read() {
                  if (!this._done) {
                    this._done = true;
                    return Promise.resolve({ done: false, value });
                  } else {
                    return Promise.resolve({ done: true });
                  }
                },
              };
            case "arrayBuffer":
            case "blob":
            case "formData":
            case "json":
            case "text":
              return await response[method]();
            default:
              return Promise.reject(new Error("method not allowed"));
          }
        } else if (response.status < 500) {
          // client error
          retry = false;
        } else {
          // server error
          retry = true;
        }
      } catch (error) {
        if (Utils.isNwjs() || window.cordova) {
          // local file error
          retry = false;
        } else {
          // network error
          retry = true;
        }
      }
      if (!retry) {
        const error = new Error("Failed to load: " + url);
        if (alwaysIgnoreEnabled()) {
          console.warn(
            "[ignore-load-errors] auto-ignoring failed audio load:",
            url,
          );
          throw error;
        }
        await new Promise((resolveDismiss) => {
          window.__pendingLoadFailures.push({
            target: null,
            resolve: resolveDismiss,
          });
          Graphics.printLoadingError(url, { allowRetry: false });
          SceneManager.stop();
        });
        throw error;
      } else if (_retryCount < this._defaultRetryInterval.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, this._defaultRetryInterval[_retryCount]),
        );
        return this.fetchWithRetry(method, url, _retryCount + 1);
      } else {
        if (this._reloaders.length === 0) {
          Graphics.printLoadingError(url);
          SceneManager.stop();
        }
        return new Promise((resolve) =>
          this._reloaders.push(() => resolve(this.fetchWithRetry(method, url, 0))),
        );
      }
    };
  }

  // Hook into Scene_Boot.prototype.start
  //
  // The DRM payload (loaded via plugins AFTER lang-shim.js) overwrites
  // Scene_Boot.prototype.start, so we cannot wrap it here at load time.
  // Instead, expose hookSceneBoot() for the bootstrap sentinel to call
  // after all plugin scripts have executed.

  function hookSceneBoot() {
    patchAudioResourceHandler();
    if (typeof Scene_Boot === "undefined") return;

    // Re-apply the isReady gate AFTER the DRM payload has executed.
    // The DRM can (and does) overwrite Scene_Boot.prototype.isReady,
    // which drops the _savesRestored gate set during the IIFE. Without
    // this gate the game can boot before IDB saves are restored to
    // localStorage, causing mod saves to appear lost after a reload.
    var _post_drm_isReady = Scene_Boot.prototype.isReady;
    Scene_Boot.prototype.isReady = function () {
      return _savesRestored && _post_drm_isReady.call(this);
    };

    var _orig_bootStart = Scene_Boot.prototype.start;
    Scene_Boot.prototype.start = function () {
      applyPatches();
      loadActivePlugins();
      // Read the install counts once, here at game entry. loadInstallCounts is
      // load-once for the session, so the Mods menu later reuses this result
      // instead of re-reading: installs stay live via trackModInstall's local
      // +1. Warming it here means the numbers are ready by the time the menu
      // opens.
      loadInstallCounts();
      // One-time backfill for pre-counting adopters. Deferred so it never
      // competes with the asset-heavy boot: the POSTs are keepalive and the
      // scan is background IDB, but there's no reason to fire them mid-boot.
      setTimeout(backfillInstallCounts, 3000);
      return _orig_bootStart.apply(this, arguments);
    };
  }

  // Drag-and-drop save loading. A .rpgsave (native) or .json (legacy web
  // export) dropped anywhere on the window loads instantly and jumps to
  // the map, provided the save's origin matches the active mod context
  // (base game <-> mod, mod <-> mod must match). Mismatched, malformed,
  // or unsupported drops are silently ignored per spec.
  (function installSaveDnD() {
    function dtHasFiles(dt) {
      if (!dt || !dt.types) return false;
      for (var i = 0; i < dt.types.length; i++) {
        if (dt.types[i] === "Files") return true;
      }
      return false;
    }

    function gameReady() {
      return (
        typeof DataManager !== "undefined" &&
        typeof SceneManager !== "undefined" &&
        typeof Scene_Map !== "undefined" &&
        typeof Scene_Base !== "undefined" &&
        typeof $dataSystem !== "undefined" &&
        $dataSystem &&
        DataManager.isDatabaseLoaded() &&
        SceneManager._scene &&
        !(SceneManager._scene instanceof Scene_Boot) &&
        !SceneManager.isSceneChanging()
      );
    }

    // Lazy-defined one-shot transition scene. Running extractSaveContents
    // directly from a live Scene_Map's context crashes: $gameMap is replaced
    // from the save while $dataMap still belongs to the outgoing map, so the
    // next refreshIfNeeded tick hits null entries in $dataMap.events. By
    // routing through a Scene_Base subclass, the extraction runs only after
    // the previous scene has terminated, and the following Scene_Map
    // instance loads a matching $dataMap before its own update runs.
    var _Scene_DropLoad = null;
    function getDropLoadScene() {
      if (_Scene_DropLoad) return _Scene_DropLoad;
      if (typeof Scene_Base === "undefined") return null;

      function Scene_DropLoad() {
        this.initialize.apply(this, arguments);
      }
      Scene_DropLoad.prototype = Object.create(Scene_Base.prototype);
      Scene_DropLoad.prototype.constructor = Scene_DropLoad;
      Scene_DropLoad._pendingContents = null;

      Scene_DropLoad.prototype.initialize = function () {
        Scene_Base.prototype.initialize.call(this);
        this._loadSuccess = false;
      };

      Scene_DropLoad.prototype.create = function () {
        Scene_Base.prototype.create.call(this);
      };

      // Extraction runs here, not in create(). By the time start() fires,
      // the previous scene has fully terminated (no live Scene_Map update
      // can race us on $gameMap), and our own fadeOut sequencing mirrors
      // Scene_Load so Scene_Map.needsFadeIn works normally.
      Scene_DropLoad.prototype.start = function () {
        Scene_Base.prototype.start.call(this);
        var contents = Scene_DropLoad._pendingContents;
        Scene_DropLoad._pendingContents = null;
        if (!contents) {
          SceneManager.goto(Scene_Title);
          return;
        }
        try {
          DataManager.createGameObjects();
          DataManager.extractSaveContents(contents);
          this._loadSuccess = true;
          SoundManager.playLoad();
          this.fadeOutAll();
          SceneManager.goto(Scene_Map);
        } catch (e) {
          console.error("[lang-shim] DnD save load failed:", e);
          SceneManager.goto(Scene_Title);
        }
      };

      Scene_DropLoad.prototype.terminate = function () {
        Scene_Base.prototype.terminate.call(this);
        if (
          this._loadSuccess &&
          typeof $gameSystem !== "undefined" &&
          $gameSystem
        ) {
          $gameSystem.onAfterLoad();
        }
      };

      _Scene_DropLoad = Scene_DropLoad;

      // Scene_Map.needsFadeIn() only fades in from Scene_Battle/Scene_Load,
      // so arriving from our transition scene would leave the screen black
      // after the outgoing fadeOutAll. Extend it to treat Scene_DropLoad
      // the same way.
      if (typeof Scene_Map !== "undefined" && Scene_Map.prototype.needsFadeIn) {
        var _orig_needsFadeIn = Scene_Map.prototype.needsFadeIn;
        Scene_Map.prototype.needsFadeIn = function () {
          return (
            _orig_needsFadeIn.call(this) ||
            SceneManager.isPreviousScene(Scene_DropLoad)
          );
        };
      }

      return _Scene_DropLoad;
    }

    function detectOrigin(contents, filename) {
      if (contents && typeof contents._modId !== "undefined") {
        var id = contents._modId || null;
        return isTranslationModId(id) ? null : id;
      }
      if (filename && _modsData) {
        var keys = Object.keys(_modsData);
        for (var i = 0; i < keys.length; i++) {
          if (isTranslationType(_modsData[keys[i]].type)) continue;
          if (filename.indexOf(keys[i] + "_") === 0) return keys[i];
        }
      }
      return null;
    }

    function parseDroppedSave(raw) {
      var text = (raw || "").toString().trim();
      if (!text) return null;
      try {
        var json;
        if (text.charAt(0) === "{") {
          var parsed = JSON.parse(text);
          if (!parsed || !parsed.data) return null;
          json = parsed.data;
        } else {
          json = LZString.decompressFromBase64(text);
        }
        if (!json) return null;
        return JsonEx.parse(json);
      } catch (e) {
        return null;
      }
    }

    function loadContentsAndStart(contents) {
      var SceneCls = getDropLoadScene();
      if (!SceneCls) return;
      SceneCls._pendingContents = contents;
      SceneManager.goto(SceneCls);
    }

    function handleDroppedFile(file) {
      if (!file || !gameReady()) return;
      var name = (file.name || "").toLowerCase();
      if (!/\.(rpgsave|json)$/.test(name)) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        var contents = parseDroppedSave(e.target.result);
        if (!contents) return;
        var saveModId = detectOrigin(contents, file.name);
        var currentModId = getActiveSaveScope() || null;
        if (saveModId !== currentModId) return;
        loadContentsAndStart(contents);
      };
      reader.onerror = function () {};
      reader.readAsText(file);
    }

    function onDragOver(e) {
      if (!dtHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.dataTransfer.dropEffect = "copy";
      } catch (_) {}
    }

    function onDrop(e) {
      if (!dtHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      var files = e.dataTransfer.files;
      if (files && files.length > 0) handleDroppedFile(files[0]);
    }

    window.addEventListener("dragenter", onDragOver, false);
    window.addEventListener("dragover", onDragOver, false);
    window.addEventListener("drop", onDrop, false);
  })();

  // Quick save: a core feature, available regardless of any mod.
  // A quick save is a normal *file* save: the shortcut for menu -> save ->
  // pick a slot. File slots use positive ids and are uncapped (browser-shim
  // grows DataManager.maxSavefiles with usage); the game's auto-saves
  // (negative ids, capped at 5) are managed by the engine and untouched here.
  //
  // Exposes window.__quickSave (called by the Virtual Controller mod's
  // on-screen button) and binds the 'M' key globally, so the shortcut works
  // even when that mod isn't installed. A 1s cooldown debounces both paths.
  (function installQuickSave() {
    if (typeof window === "undefined" || !window.addEventListener) return;
    if (window.__quickSave) return;

    var COOLDOWN = 1000;
    var lastSaveAt = 0;
    var toastEl = null;
    var toastTimer = null;

    // Saving is only meaningful on the map with saving enabled: the same
    // gate the engine's Scene_Save enforces before DataManager.saveGame.
    function canQuickSave() {
      return (
        typeof DataManager !== "undefined" &&
        typeof SceneManager !== "undefined" &&
        typeof Scene_Map !== "undefined" &&
        SceneManager._scene instanceof Scene_Map &&
        typeof $gameSystem !== "undefined" &&
        $gameSystem &&
        $gameSystem.isSaveEnabled()
      );
    }

    // Lowest empty file slot (positive id). Slots are uncapped, so one is
    // always free; the trailing return is a defensive fallback.
    function firstAvailableSlot() {
      var max = DataManager.maxSavefiles();
      for (var i = 1; i <= max; i++) {
        if (!DataManager.isThisGameFile(i)) return i;
      }
      return max + 1;
    }

    // Transient feedback toast, self-contained (no mod overlay required).
    function toast(msg) {
      if (!document.body) return;
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "qs-toast";
        toastEl.style.cssText = [
          "position:fixed;left:50%;top:12%;transform:translateX(-50%)",
          "z-index:100001;pointer-events:none;white-space:nowrap",
          "background:rgba(20,20,26,0.82);color:#f4f4f4;padding:8px 16px",
          "border:2px solid rgba(255,255,255,0.32);border-radius:18px",
          "font-family:Arial,Helvetica,sans-serif;font-weight:bold",
          "font-size:clamp(13px,3.4vw,18px)",
          "text-shadow:0 1px 2px rgba(0,0,0,0.8)",
          "opacity:0;transition:opacity 0.18s",
        ].join(";");
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      void toastEl.offsetWidth; // restart the fade if already visible
      toastEl.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        if (toastEl) toastEl.style.opacity = "0";
      }, 1400);
    }

    function quickSave() {
      var now = Date.now();
      if (now - lastSaveAt < COOLDOWN) return;
      lastSaveAt = now;

      // Best-effort: dim the Virtual Controller's save button if it's on
      // screen (no-op when that mod isn't active).
      var btn = document.querySelector("#vc-overlay .vc-save");
      if (btn) {
        btn.classList.add("vc-cooldown");
        setTimeout(function () {
          btn.classList.remove("vc-cooldown");
        }, COOLDOWN);
      }

      if (!canQuickSave()) {
        if (typeof SoundManager !== "undefined") SoundManager.playBuzzer();
        //toast("Can't save here");
        return;
      }
      var id = firstAvailableSlot();
      $gameSystem.onBeforeSave();
      if (DataManager.saveGame(id)) {
        if (
          typeof StorageManager !== "undefined" &&
          StorageManager.cleanBackup
        ) {
          StorageManager.cleanBackup(id);
        }
        SoundManager.playSave();
        toast("Saved: slot " + id);
      } else {
        SoundManager.playBuzzer();
        toast("Save failed");
      }
    }

    window.__quickSave = quickSave;

    // 'M' quick-saves from the keyboard. Ignore auto-repeat and presses while
    // typing into a field (e.g. the save-note input) so it never fires twice
    // or steals a keystroke.
    window.addEventListener("keydown", function (e) {
      if (e.repeat || (e.key !== "m" && e.key !== "M")) return;
      var t = e.target;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      quickSave();
    });
  })();

  window.__langShimHookBoot = hookSceneBoot;

  // Diagnostic: read the imported-mods registry through lang-shim's OWN
  // openAssetsDb/getAssetMain path and report alongside the in-memory
  // _modsData keys, so a "modding.html shows it but the game doesn't" report
  // can be pinpointed (read discrepancy vs merge vs render). Also force a
  // re-merge so calling it can repair a stale list on the spot.
  window.__langShimDebugMods = function (cb) {
    openAssetsDb(function (db) {
      var out = {
        dbConnection: !!db,
        modsDataKeysBefore: _modsData ? Object.keys(_modsData) : null,
      };
      if (!db) {
        console.log("[langShimDebug] openAssetsDb returned NO db", out);
        if (cb) cb(out);
        return;
      }
      getAssetMain(db, IMPORTED_MODS_KEY, function (raw) {
        out.registryViaLangShim = raw || null;
        loadImportedMods(function () {
          out.modsDataKeysAfter = _modsData ? Object.keys(_modsData) : null;
          console.log(
            "[langShimDebug] registry via lang-shim:",
            out.registryViaLangShim,
          );
          console.log(
            "[langShimDebug] _modsData BEFORE re-merge:",
            out.modsDataKeysBefore,
          );
          console.log(
            "[langShimDebug] _modsData AFTER re-merge:",
            out.modsDataKeysAfter,
          );
          if (cb) cb(out);
        });
      });
    });
  };

  // Single startup probe so _cachedOffline is accurate before the first
  // Scene_Mods entry (no periodic background check outside the Mods menu).
  _probeOffline(null);
})();

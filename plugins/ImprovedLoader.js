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
/*:
 * @plugindesc Better save/load: pause in cutscenes, notes, episode tags, scene preview, fast load, quick save (TCOAAL).
 * @author kidev
 *
 * @param Label
 * @desc Prefix of every save row. "auto" = the episode the save is in (base game map ids); "" = none; anything else verbatim.
 * @default auto
 *
 * @help
 * Standalone build of the Browser Player's save and load features:
 *  - Escape opens the menu during events and dialogue; a save taken with a
 *    line on screen re-opens that line on load instead of skipping it.
 *  - Every row shows "[Episode X] <note>"; the note defaults to the save's
 *    creation time and is edited inline with [N] (long-press on touch).
 *    Notes live in savenotes.json next to the save files.
 *  - File slots are uncapped; the autosave count follows the option.
 *  - The Continue menu previews the hovered save as a rendered scene (map,
 *    events, pictures, dialogue and busts) and dissolves into the game on
 *    load with no black fade.
 *  - M quick-saves to the first free slot (window.__quickSave for
 *    VirtualController.js).
 *
 * Install: copy to www/js/plugins/ and add
 *   {"name":"ImprovedLoader","status":true,"description":"","parameters":{"Label":"auto"}}
 * to www/js/plugins.js AFTER the AudioStreaming entry: the game's payload
 * runs inside that plugin and assigns the methods this one wraps.
 */
/*
 * Sections are numbered in load order below. Everything is an additive
 * override guarded on the classes it touches, so an engine missing one of
 * them simply runs without that section.
 */

(function () {
  "use strict";

  var PARAMS =
    typeof PluginManager !== "undefined" && PluginManager.parameters
      ? PluginManager.parameters("ImprovedLoader")
      : {};
  var LABEL_MODE = PARAMS.Label === undefined ? "auto" : String(PARAMS.Label);

  var ns = {};

  // 1. Helpers

  function pad3(n) {
    n = "" + (n | 0);
    while (n.length < 3) n = "0" + n;
    return n;
  }

  // Map id -> episode label. Ranges mirror the base game's chapter/map
  // layout. Credits: https://github.com/PA3MA3AH/better-saves
  function detectEpisode(mapId) {
    mapId = parseInt(mapId, 10) || 0;
    if (mapId >= 3 && mapId <= 18) return "Episode 1";
    if (mapId === 221) return "Episode 4";
    if (mapId === 261) return "Episode 2";
    if (mapId >= 19 && mapId <= 107) return "Episode 2";
    if (mapId >= 1 && mapId <= 2) return "Episode 3A";
    if (mapId >= 108) return "Episode 3A";
    return "Unknown";
  }

  // GAME_VERSION is declared `const` at the top level of main.js: a
  // classical (non-module) script, so it's a global LEXICAL binding, not a
  // `window` property, and only the bare identifier reads it. `typeof` on it
  // stays safe when main.js never declares it (pre-2.0.12 builds).
  function readGameVersionGlobal() {
    return typeof GAME_VERSION === "string" ? GAME_VERSION : null;
  }

  // Pull the "v3.0.13" suffix the game appends to the save title; fall back
  // to the GAME_VERSION global.
  function saveVersion(info) {
    var m = info && info.title && String(info.title).match(/\sv(\d[\w.]*)$/i);
    if (m) return "v" + m[1];
    var gv = readGameVersionGlobal();
    return gv ? "v" + gv : "";
  }

  // The running build's version in saveVersion()'s format, or null.
  function currentGameVersionText() {
    var gv = readGameVersionGlobal();
    return gv ? "v" + gv : null;
  }

  // Plain dot-numeric version compare ("v3.0.13" vs "2.0.14", "v" prefix
  // optional on either side). Returns -1 (a < b), 0 (equal), 1 (a > b), or
  // null when either side isn't cleanly dot-numeric.
  function compareVersionText(a, b) {
    var pa = String(a).replace(/^v/i, "").split(".");
    var pb = String(b).replace(/^v/i, "").split(".");
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var na = parseInt(pa[i], 10);
      var nb = parseInt(pb[i], 10);
      if (isNaN(na) || isNaN(nb)) return null;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }

  // Default per-save note: the wall-clock time the save was written, in the
  // user's locale (12h/24h, D/M/Y order, separators).
  function formatSaveTimestamp(ms) {
    var d = new Date(typeof ms === "number" ? ms : Date.now());
    try {
      return d.toLocaleString(undefined, {
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (e) {
      try {
        return d.toLocaleString();
      } catch (e2) {
        return "" + d;
      }
    }
  }

  // Fetch a map's JSON the way the game itself does. In the shipped game the
  // file lives under a hashed name and is TCOAAL-wrapped: the DRM payload's
  // App.redirect maps the logical path to the stored one and Crypto.dekit
  // unwraps the bytes (DataManager.loadDataFile does exactly this). Without
  // the DRM (a plain project) the logical path is fetched as JSON. cb gets
  // the parsed object, or null on any failure.
  function loadMapJson(mapId, cb) {
    var logical = "data/Map" + pad3(mapId) + ".json";
    var drm =
      typeof App !== "undefined" &&
      typeof App.redirect === "function" &&
      typeof Crypto !== "undefined" &&
      typeof Crypto.dekit === "function";
    var url = logical;
    if (drm) {
      try {
        url = App.redirect(logical) || logical;
      } catch (e) {
        url = logical;
      }
    }
    var xhr = new XMLHttpRequest();
    var done = false;
    function finish(v) {
      if (done) return;
      done = true;
      cb(v);
    }
    xhr.open("GET", url);
    xhr.overrideMimeType("application/json");
    if (drm) xhr.responseType = "arraybuffer";
    xhr.onload = function () {
      if (xhr.status >= 400) {
        finish(null);
        return;
      }
      try {
        var text;
        if (drm) {
          var guard = typeof Crypto.guard === "function" ? Crypto.guard() : -1;
          var buf = Crypto.dekit(xhr.response, url, guard);
          text = new TextDecoder().decode(new Uint8Array(buf));
        } else {
          text = xhr.responseText;
        }
        finish(JSON.parse(text));
      } catch (e) {
        finish(null);
      }
    };
    xhr.onerror = function () {
      finish(null);
    };
    try {
      xhr.send();
    } catch (e) {
      finish(null);
    }
  }

  // 2. Note store

  // Keyed by basename, not index: an autosave shifts index as newer ones
  // arrive, its basename does not. Shape { "<basename>": { note, auto } },
  // where `auto` is the creation-time string applyDefault last wrote. The
  // note is refreshed on save-over only while it still equals that string,
  // and the marker is dropped the moment the player edits it.
  function createNoteStore(fsLike, filePath) {
    var data = null;
    function load() {
      if (data) return data;
      data = {};
      try {
        if (fsLike.existsSync(filePath)) {
          var parsed = JSON.parse(
            String(fsLike.readFileSync(filePath, "utf8")),
          );
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            data = parsed;
        }
      } catch (e) {
        data = {};
      }
      return data;
    }
    function flush() {
      try {
        fsLike.writeFileSync(filePath, JSON.stringify(load(), null, 2));
      } catch (e) {
        /* read-only save dir: notes stay in memory for this session */
      }
    }
    function entry(key) {
      var d = load();
      return d[key] && typeof d[key] === "object" ? d[key] : null;
    }
    function get(key) {
      var e = entry(key);
      return e && typeof e.note === "string" ? e.note : "";
    }
    function isAuto(key) {
      var e = entry(key);
      return !!(e && e.auto && e.note === e.auto);
    }
    function set(key, text) {
      var d = load();
      text = text ? String(text) : "";
      if (!text) {
        delete d[key];
      } else {
        var e = entry(key) || {};
        e.note = text;
        // A player-written note is never "auto" again.
        if (e.auto !== text) delete e.auto;
        d[key] = e;
      }
      flush();
    }
    function applyDefault(key, now) {
      var d = load();
      var e = entry(key);
      var cur = e ? e.note || "" : "";
      var marker = e ? e.auto || "" : "";
      if (!cur || cur === marker) {
        var stamp = formatSaveTimestamp(
          typeof now === "number" ? now : Date.now(),
        );
        d[key] = { note: stamp, auto: stamp };
        flush();
      } else if (marker) {
        delete e.auto;
        flush();
      }
    }
    return {
      load: load,
      get: get,
      set: set,
      isAuto: isAuto,
      applyDefault: applyDefault,
      all: load,
    };
  }

  // 3. Save readers

  function nodeFs() {
    try {
      return typeof require === "function" ? require("fs") : null;
    } catch (e) {
      return null;
    }
  }

  // Read a save file as text: through the game's Utils.readFile when the
  // payload provides it, else straight from the filesystem. null when the
  // file is missing or unreadable.
  function readTextFile(path) {
    if (!path) return null;
    try {
      if (typeof Utils !== "undefined" && typeof Utils.readFile === "function")
        return Utils.readFile(path) || null;
    } catch (e) {
      /* fall through to fs */
    }
    try {
      var fsm = nodeFs();
      return fsm ? fsm.readFileSync(path, "utf8") : null;
    } catch (e2) {
      return null;
    }
  }

  // Whether a file exists: the game's Utils.exists when present, else fs.
  function fileExists(path) {
    if (!path) return false;
    try {
      if (typeof Utils !== "undefined" && typeof Utils.exists === "function")
        return !!Utils.exists(path);
    } catch (e) {
      /* fall through to fs */
    }
    try {
      var fsm = nodeFs();
      return !!(fsm && fsm.existsSync(path));
    } catch (e2) {
      return false;
    }
  }

  // On-disk path of a save (positive id = file slot, <= 0 = autosave by
  // list index, which the payload's StorageManager.localFilePath resolves).
  // "" when nothing backs the id.
  function savePath(savefileId) {
    try {
      if (
        typeof StorageManager === "undefined" ||
        typeof StorageManager.localFilePath !== "function"
      )
        return "";
      return StorageManager.localFilePath(savefileId) || "";
    } catch (e) {
      return "";
    }
  }

  function saveBasename(savefileId) {
    var p = savePath(savefileId);
    if (!p) return "";
    var parts = String(p).split(/[\/\\]/);
    return parts[parts.length - 1] || "";
  }

  // The save is LZString-compressed base64 of JsonEx output, but the map node
  // is plain JSON apart from the "@" class markers, so JSON.parse is enough
  // for _mapId. Cached by path.
  var _mapIdCache = {};
  function saveMapId(savefileId) {
    var path = savePath(savefileId);
    if (!path) return 0;
    if (Object.prototype.hasOwnProperty.call(_mapIdCache, path))
      return _mapIdCache[path];
    var mapId = 0;
    try {
      var raw = readTextFile(path);
      if (raw) {
        var json = LZString.decompressFromBase64(String(raw).trim());
        if (json) {
          var data = JSON.parse(json);
          if (data && data.map && typeof data.map._mapId === "number")
            mapId = data.map._mapId;
        }
      }
    } catch (e) {
      mapId = 0;
    }
    _mapIdCache[path] = mapId;
    return mapId;
  }

  // The full JsonEx.parse result, so the caller gets real engine instances it
  // can swap into the globals and feed to a Spriteset_Map. Cached by path.
  var _saveContentsCache = {};
  function saveContents(savefileId) {
    if (typeof JsonEx === "undefined" || !JsonEx.parse) return null;
    var path = savePath(savefileId);
    if (!path) return null;
    if (Object.prototype.hasOwnProperty.call(_saveContentsCache, path))
      return _saveContentsCache[path];
    var res = null;
    try {
      var raw = readTextFile(path);
      if (raw) {
        var json = LZString.decompressFromBase64(String(raw).trim());
        if (json) res = JsonEx.parse(json);
      }
    } catch (e) {
      res = null;
    }
    _saveContentsCache[path] = res;
    return res;
  }

  // Writing a slot reuses its path, so both caches go stale on a save-over.
  function invalidateSaveCaches() {
    _mapIdCache = {};
    _saveContentsCache = {};
  }

  // Notes, wired to the store: the key is the save's basename.
  var _noteStore = null;
  function noteStore() {
    if (_noteStore) return _noteStore;
    var dir = "";
    try {
      dir = StorageManager.localFileDirectoryPath() || "";
    } catch (e) {
      dir = "";
    }
    if (dir && !/[\/\\]$/.test(dir)) dir += "/";
    var fsm = nodeFs() || {
      existsSync: function () {
        return false;
      },
      readFileSync: function () {
        return "";
      },
      writeFileSync: function () {},
    };
    _noteStore = createNoteStore(fsm, dir + "savenotes.json");
    return _noteStore;
  }
  function getNote(savefileId) {
    var k = saveBasename(savefileId);
    return k ? noteStore().get(k) : "";
  }
  function setNote(savefileId, text) {
    var k = saveBasename(savefileId);
    if (k) noteStore().set(k, text);
  }
  function isAutoNote(savefileId) {
    var k = saveBasename(savefileId);
    return !!k && noteStore().isAuto(k);
  }
  // Stamp the creation-time note onto a freshly written file slot. Autosaves
  // (ids <= 0) are stamped by name in the _autoSave replacement below.
  function applyDefaultSaveNote(savefileId) {
    if (typeof savefileId !== "number" || savefileId <= 0) return;
    var k = saveBasename(savefileId);
    if (k) noteStore().applyDefault(k, Date.now());
  }

  // The "[...]" prefix of a save row. "auto" reads the episode off the map
  // the save sits on (a base-game notion: an overhaul reuses those map ids
  // for another story, so it names itself instead); "" means no prefix.
  function saveLabel(savefileId) {
    if (LABEL_MODE === "auto") return detectEpisode(ns.saveMapId(savefileId));
    return LABEL_MODE;
  }

  // 4. Slots

  // Highest occupied file slot: the highest index of globalInfo that holds
  // an info entry AND whose file exists (a stale entry for a deleted file
  // must not keep rows around).
  function highestSaveSlot(gdat, exists) {
    var top = 0;
    if (!gdat || !gdat.length) return 0;
    for (var i = 1; i < gdat.length; i++) {
      if (gdat[i] && exists(i) && i > top) top = i;
    }
    return top;
  }

  var _slotCache = { value: -1, expires: 0 };
  function invalidateSlotCache() {
    _slotCache.value = -1;
  }

  if (
    typeof DataManager !== "undefined" &&
    typeof StorageManager !== "undefined"
  ) {
    // Window_SavefileList derives its row count from maxSavefiles, so
    // overriding that one value feeds both the slot allocator and the UI.
    // globalInfo comes off the payload's cached array, never through
    // StorageManager.load(0): the payload maps id 0 to the first autosave.
    var cachedTopSlot = function () {
      var now = Date.now();
      if (_slotCache.value >= 0 && now < _slotCache.expires)
        return _slotCache.value;
      var top = 0;
      try {
        var gdat =
          DataManager._gdat ||
          (typeof DataManager.loadGlobalInfo === "function"
            ? DataManager.loadGlobalInfo()
            : null);
        top = highestSaveSlot(gdat, function (i) {
          return StorageManager.exists(i);
        });
      } catch (e) {
        top = 0;
      }
      _slotCache.value = top;
      _slotCache.expires = now + 250;
      return top;
    };
    DataManager.maxSavefiles = function () {
      return Math.max(50, cachedTopSlot() + 5);
    };

    // Every write drops the caches (slot count, map id, contents) and gives
    // the slot its creation time as a default, editable note.
    if (typeof StorageManager.save === "function") {
      var _origStorageSave = StorageManager.save;
      StorageManager.save = function (savefileId) {
        invalidateSlotCache();
        invalidateSaveCaches();
        var r = _origStorageSave.apply(this, arguments);
        try {
          applyDefaultSaveNote(savefileId);
        } catch (e) {
          /* notes are best-effort */
        }
        return r;
      };
    }
    if (typeof StorageManager.remove === "function") {
      var _origStorageRemove = StorageManager.remove;
      StorageManager.remove = function () {
        invalidateSlotCache();
        invalidateSaveCaches();
        return _origStorageRemove.apply(this, arguments);
      };
    }
  }

  // Without this, lowering the option leaves orphan auto<ts>.rpgsave files on
  // disk: the visible count is min(option, files), but the file list keeps
  // growing to the payload's hardcoded autoSaveMax().
  // This mirrors the payload's _autoSave and only swaps the cap; the rest
  // (autoSaveMax, the option's own clamp) is untouched. The new autosave is
  // annotated with its creation time like a file slot; it bypasses
  // StorageManager.save, so the note is stamped here by name.
  if (
    typeof DataManager !== "undefined" &&
    typeof DataManager._autoSave === "function" &&
    typeof App !== "undefined" &&
    typeof App.dataPath === "function" &&
    typeof Utils !== "undefined" &&
    typeof Utils.files === "function" &&
    typeof Utils.writeFile === "function" &&
    typeof Utils.delete === "function"
  ) {
    DataManager._autoSave = function () {
      if (this.savesDisabled) return;
      if (
        typeof $gameMap !== "undefined" &&
        typeof $dataSystem !== "undefined" &&
        $gameMap._mapId === $dataSystem.startMapId
      )
        return;
      var cap =
        (typeof ConfigManager !== "undefined" && ConfigManager.autoSaves) || 0;
      if (cap < 1) return;
      $gameSystem.onBeforeSave();
      var dataPath = App.dataPath();
      var fname = "auto" + Date.now() + ".rpgsave";
      var fpath = Utils.join(dataPath, fname);
      var contents = JsonEx.stringify(this.makeSaveContents());
      var payload = LZString.compressToBase64(contents);
      if (!Utils.writeFile(fpath, payload)) return;
      var autos = [];
      var entries = Utils.files(dataPath) || [];
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        var lower = name.toLowerCase();
        if (
          lower.indexOf("auto") === 0 &&
          lower.lastIndexOf(".rpgsave") === lower.length - 8
        ) {
          autos.push(name);
        }
      }
      this.sortDesc(autos);
      while (autos.length > cap) {
        Utils.delete(Utils.join(dataPath, autos.pop()));
      }
      var nextDict = {};
      var prevDict = this.globalGet("autoSaves", {});
      prevDict[fname] = this.makeSavefileInfo();
      for (var j = 0; j < autos.length; j++) {
        var key = autos[j];
        nextDict[key] = Object.prototype.hasOwnProperty.call(prevDict, key)
          ? prevDict[key]
          : this.recoveryMeta();
      }
      this.globalSet("autoSaves", nextDict);
      invalidateSaveCaches();
      try {
        noteStore().applyDefault(fname, Date.now());
      } catch (e) {
        /* notes are best-effort */
      }
    };
  }

  // 5. Escape opens the menu during events

  // Stock MV locks the menu for the whole duration of an event, which is
  // most of TCOAAL, through three independent gates: Scene_Map.update skips
  // updateScene (and so updateCallMenu) while a message is busy;
  // updateCallMenu's isMenuEnabled() is false while an event runs, so even a
  // textless CG blocks it; and Window_Message swallows cancel/Escape to
  // advance text, so the key never reaches a menu check anyway.
  //
  // isMenuEnabled() is deliberately left alone, so a stretch that disables
  // the menu on purpose ($gameSystem.disableMenu()) stays locked. Instead
  // Window_Message.isTriggered drops cancel/Escape - read only by the pause
  // handler, so the whole behaviour change is that Escape opens the menu -
  // and a tail check on Scene_Map.update fires only in the cases the stock
  // pipeline skips, so it never races updateCallMenu on a quiet map.
  if (
    typeof Window_Message !== "undefined" &&
    typeof Window_Message.prototype.isTriggered === "function"
  ) {
    Window_Message.prototype.isTriggered = function () {
      return Input.isRepeated("ok") || TouchInput.isRepeated();
    };
  }
  if (
    typeof Scene_Map !== "undefined" &&
    typeof Scene_Map.prototype.update === "function" &&
    typeof Scene_Map.prototype.callMenu === "function"
  ) {
    var _escMenuOrigUpdate = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function () {
      _escMenuOrigUpdate.call(this);
      this.updateEscapeToMenuDuringEvent();
    };
    Scene_Map.prototype.updateEscapeToMenuDuringEvent = function () {
      if (!this.isActive() || SceneManager.isSceneChanging()) return;
      // Only handle what the stock updateCallMenu can't reach this frame.
      if (!$gameMap.isEventRunning() && !$gameMessage.isBusy()) return;
      // Honour an explicit in-game menu lock (forced / no-save sequences).
      if (!$gameSystem.isMenuEnabled()) return;
      // A choice / number / item prompt owns the cancel key: leave it alone.
      var mw = this._messageWindow;
      if (mw && mw.isAnySubWindowActive && mw.isAnySubWindowActive()) return;
      if (Input.isTriggered("escape") || TouchInput.isCancelled()) {
        this.callMenu();
      }
    };
  }

  // 6. The on-screen line rides in the save; the VN busts are stamped

  // Stock RPG Maker omits $gameMessage from the save payload, which is fine
  // for vanilla MV where you can only save on a quiet map. Section 5 makes
  // saving mid-line normal here, and then: command101 has already populated
  // $gameMessage, advanced the interpreter past the 401 text lines and set
  // wait mode 'message' before the save is taken. The interpreter lives in
  // $gameMap and IS saved, so on load it resumes in wait mode 'message' with
  // a reborn empty $gameMessage, updateWaitMode sees !isBusy() and drops the
  // wait at once. The line the player was reading is skipped.
  //
  // So a plain text message rides in the save. Only a plain one: a pending
  // choice / number / item prompt holds a bound _choiceCallback that JsonEx
  // cannot serialize, and restoring it without the callback would take the
  // wrong branch (those states are unreachable from the menu anyway, since
  // the sub-window owns the cancel key).
  //
  // Irina_VisualNovelBusts keeps bust state ONLY on transient sprites, with
  // no $gameSystem fields and no save hooks, and Game_Interpreter.terminate
  // clears them at event end - so a non-speaking bust placed earlier in the
  // conversation is nowhere in the save, and by Scene_Save the map's bust
  // sprites are gone. captureVnBusts stamps the live sprites onto
  // $gameSystem, which IS saved, while still on the map. Only the Continue
  // preview reads the field back.
  function captureVnBusts() {
    try {
      if (typeof SceneManager === "undefined") return;
      var scene = SceneManager._scene;
      if (!scene || typeof $gameSystem === "undefined" || !$gameSystem) return;
      var ss = scene._spriteset;
      var mw = scene._messageWindow;
      var sceneBusts = ss && ss._messageBustSprites;
      // Only a scene that can actually provide busts may rewrite the field;
      // Scene_Save/Scene_Menu (no spriteset/message window) must leave the
      // value previously stamped on the map intact.
      if (!sceneBusts && !mw) return;
      var out = [];
      var grab = function (sp) {
        if (!sp || !sp._bustName) return;
        out.push({
          setting: sp._setting,
          type: sp._type || "face",
          name: sp._bustName,
          expr: sp._expressionIndex || 0,
          x: sp.x,
          y: sp.y,
          sx: sp.scale ? sp.scale.x : 1,
          sy: sp.scale ? sp.scale.y : 1,
          ax: sp.anchor ? sp.anchor.x : 0.5,
          ay: sp.anchor ? sp.anchor.y : 1,
          op: typeof sp.opacity === "number" ? sp.opacity : 255,
          tone:
            sp._colorTone && sp._colorTone.slice ? sp._colorTone.slice() : null,
        });
      };
      if (mw) grab(mw._messageBodyBustSprite);
      if (sceneBusts) sceneBusts.forEach(grab);
      $gameSystem._vnBusts = out.length ? out : null;
    } catch (e) {
      /* best-effort: the preview just shows no persistent busts */
    }
  }

  if (
    typeof DataManager !== "undefined" &&
    typeof DataManager.makeSaveContents === "function" &&
    typeof DataManager.extractSaveContents === "function"
  ) {
    var _origMakeSaveContents = DataManager.makeSaveContents;
    DataManager.makeSaveContents = function () {
      captureVnBusts();
      var contents = _origMakeSaveContents.apply(this, arguments);
      try {
        var m = window.$gameMessage;
        if (
          contents &&
          m &&
          m.hasText &&
          m.hasText() &&
          !m.isChoice() &&
          !m.isNumberInput() &&
          !m.isItemChoice()
        ) {
          contents.message = m;
        }
      } catch (e) {
        /* leave the payload as the engine made it */
      }
      return contents;
    };
    var _origExtractSaveContents = DataManager.extractSaveContents;
    DataManager.extractSaveContents = function (contents) {
      _origExtractSaveContents.apply(this, arguments);
      try {
        if (contents && contents.message) {
          window.$gameMessage = contents.message;
        }
      } catch (e) {
        /* an old save simply keeps the fresh message */
      }
    };
  }

  // Capture at the moment the menu is opened (still on Scene_Map), covering
  // the normal menu -> save flow. Section 5 routes through callMenu too, so
  // both menu entry points are handled.
  if (
    typeof Scene_Map !== "undefined" &&
    typeof Scene_Map.prototype.callMenu === "function"
  ) {
    var _vnOrigCallMenu = Scene_Map.prototype.callMenu;
    Scene_Map.prototype.callMenu = function () {
      captureVnBusts();
      return _vnOrigCallMenu.apply(this, arguments);
    };
  }

  // 7. Save rows

  // Character capacity of the title line, refreshed whenever a row draws;
  // bounds the note length to what fits after "[label] ".
  var _lineChars = 30;
  function noteMax(label) {
    if (!label) return Math.max(0, _lineChars - 1);
    return Math.max(0, _lineChars - (label.length + 2) - 1);
  }

  if (
    typeof Window_SavefileList !== "undefined" &&
    typeof Window_SavefileList.prototype.drawItem === "function"
  ) {
    // The payload's drawItem, with the build version moved under the file /
    // auto label (it no longer rides in the title line) and the row's id
    // handed to drawGameTitle, which has no id of its own. The autosave row
    // keeps the base game's styling: green "Auto N" on a dark blue-gray
    // band, dimmed when no savefile info is available.
    Window_SavefileList.prototype.drawItem = function (index) {
      var itemRect = this.itemRectForText(index);
      var autoSaveCount =
        typeof DataManager.autoSaveCount === "function"
          ? DataManager.autoSaveCount()
          : 0;
      var adjustedIndex = index + 1;
      if (adjustedIndex > autoSaveCount) {
        adjustedIndex -= autoSaveCount;
      } else {
        adjustedIndex = -adjustedIndex + 1;
      }
      var saveInfo = DataManager.getSaveInfo
        ? DataManager.getSaveInfo(adjustedIndex)
        : DataManager.loadSavefileInfo(adjustedIndex);
      this.resetTextColor();
      this.changePaintOpacity(true);
      if (adjustedIndex > 0) {
        var fileText = TextManager.file + " " + adjustedIndex;
        this.drawText(fileText, itemRect.x, itemRect.y, 180);
      } else {
        var padding = 20;
        var textColor = "#B2E087";
        var bgColor = "rgba(65, 73, 87, 0.2)";
        var autoText = "Auto " + (Math.abs(adjustedIndex) + 1);
        if (this._mode === "save") {
          textColor = "#363636";
        }
        this.contents.fillRect(
          itemRect.x - padding,
          itemRect.y,
          itemRect.width + padding * 2,
          itemRect.height,
          bgColor,
        );
        this.changePaintOpacity(saveInfo != null);
        this.changeTextColor(textColor);
        this.drawText(autoText, itemRect.x, itemRect.y, 180);
        this.resetTextColor();
      }
      if (saveInfo) {
        if (this._mode === "save" && adjustedIndex < 1) {
          this.changePaintOpacity(false);
        } else {
          this.changePaintOpacity(true);
        }
        // Build version under the file/auto label: dim, half-size, on the
        // next line. Recolored amber with a "(!)" suffix only when the
        // save's version is ABOVE the running build AND this is a load
        // context: saving re-tags the slot with the running version anyway,
        // while loading a save newer than the build is where trouble can
        // start (a heads-up, not a gate).
        var ver = saveVersion(saveInfo);
        if (ver) {
          var prevSize = this.contents.fontSize;
          this.contents.fontSize = Math.floor(this.standardFontSize() * 0.7);
          var curVer = currentGameVersionText();
          var cmp = curVer ? compareVersionText(ver, curVer) : null;
          var verLabel = ver;
          if (this._mode !== "save" && cmp !== null && cmp > 0) {
            this.changeTextColor("#e0a030");
            verLabel = ver + " (!)";
          } else {
            this.changeTextColor("#9aa0a8");
          }
          this.drawText(
            verLabel,
            itemRect.x,
            itemRect.y + this.lineHeight() - 4,
            180,
          );
          this.resetTextColor();
          this.contents.fontSize = prevSize;
        }
        this._curSaveId = adjustedIndex;
        this.drawContents(saveInfo, itemRect, true);
      }
    };

    // Replace the game-title line with "[label] <note>" (or just the note
    // when the label is empty).
    Window_SavefileList.prototype.drawGameTitle = function (info, x, y, width) {
      var saveId = this._curSaveId;
      var label = saveLabel(saveId);
      // Refresh the shared line-char capacity for the note editor, estimated
      // from an average glyph width at the current font.
      try {
        var sample = "abcdefghijklmnopqrstuvwxyz0123456789";
        var avg = this.contents.measureTextWidth(sample) / sample.length || 8;
        _lineChars = Math.max(1, Math.floor(width / avg));
      } catch (e) {
        /* keep the previous estimate */
      }
      var used = 0;
      this.resetTextColor();
      if (label) {
        var prefix = "[" + label + "]";
        this.drawText(prefix, x, y, width);
        used = this.textWidth(prefix + " ");
      }
      var remain = width - used;
      // Inline note editor: when this row is the one being annotated, render
      // the live edit buffer + a blinking caret in place of the stored note.
      // The edit state (_noteEdit) is driven by Scene_File (section 8).
      var edit = this._noteEdit;
      if (edit && edit.id === saveId) {
        if (remain > 8) this._drawNoteEditor(edit, x + used, y, remain);
        return;
      }
      var note = getNote(saveId);
      if (note && remain > 0) {
        this.changeTextColor("#aab0b8");
        this.drawText(note, x + used, y, remain);
        this.resetTextColor();
      }
    };

    // Draw the in-progress note text + caret for the inline editor onto an
    // offscreen bitmap (clipped to the available width, scrolled to keep the
    // caret visible), then blit it onto the row.
    Window_SavefileList.prototype._drawNoteEditor = function (edit, x, y, w) {
      var lh = this.lineHeight();
      if (
        !this._noteEditBmp ||
        this._noteEditBmp.width !== w ||
        this._noteEditBmp.height !== lh
      ) {
        this._noteEditBmp = new Bitmap(w, lh);
      }
      var fb = this._noteEditBmp;
      fb.clear();
      fb.fontFace = this.contents.fontFace;
      fb.fontSize = this.contents.fontSize;
      fb.textColor = "#ffffff";
      var text = edit.text || "";
      var innerPad = 2;
      var avail = w - innerPad * 2;
      var caretPx = fb.measureTextWidth(text.slice(0, edit.caret));
      var sc = edit.scroll || 0;
      if (caretPx - sc > avail) sc = caretPx - avail;
      if (caretPx - sc < 0) sc = caretPx;
      if (sc < 0) sc = 0;
      if (fb.measureTextWidth(text) <= avail) sc = 0;
      edit.scroll = sc;
      if (text) {
        fb.drawText(
          text,
          innerPad - sc,
          0,
          fb.measureTextWidth(text) + 8,
          lh,
          "left",
        );
      }
      // Blink the caret ~twice a second.
      if (Math.floor((edit.blink || 0) / 30) % 2 === 0) {
        fb.fillRect(innerPad + caretPx - sc, 4, 2, lh - 8, "#ffffff");
      }
      this.contents.blt(fb, 0, 0, w, lh, x, y);
    };
  }

  // 8. Scene_File

  // Touch-primary detection (same expression as MouseControl.js): the
  // long-press editor is the touch equivalent of the [N] key.
  var _isMobile =
    typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 1));

  // N edits the highlighted row's note. Assigned after every key-mapping
  // plugin has run (this plugin loads last), so it wins over a mapper that
  // rebuilt the table.
  if (typeof Input !== "undefined" && Input.keyMapper) {
    Input.keyMapper[78] = "annotate";
  }

  if (
    typeof Scene_File !== "undefined" &&
    typeof StorageManager !== "undefined" &&
    typeof DataManager !== "undefined"
  ) {
    var _origSceneFileUpdate = Scene_File.prototype.update;
    Scene_File.prototype.update = function () {
      _origSceneFileUpdate.call(this);
      if (this._annotateOpen) {
        this._updateNoteEdit();
        return;
      }
      this._updateAnnotateLongPress();
      if (!this._listWindow || !this._listWindow.active) return;
      if (this._saveConfirmWindow && this._saveConfirmWindow.visible) return;
      // The payload's savefileId() maps list index -> real savefile id,
      // accounting for the autosaves shown at the top (positive = file
      // slot, <= 0 = autosave). Stock MV's returns index + 1, which matches
      // the autosave-less layout. Either way this is the highlighted row.
      if (Input.isTriggered("annotate")) {
        this._handleAnnotate(this.savefileId());
        return;
      }
      // Click on the [N] hint in the help window.
      if (
        this._fileHintRects &&
        typeof TouchInput !== "undefined" &&
        TouchInput.isTriggered()
      ) {
        var tx = TouchInput.x;
        var ty = TouchInput.y;
        var r = this._fileHintRects.annotate;
        if (r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          this._handleAnnotate(this.savefileId());
        }
      }
    };

    // Draw the [N] hint in the help window, centered (MouseControl draws its
    // "<- Back" button right-aligned in the same window), and remember its
    // screen rect so a click on it works too. The Continue / Load menu also
    // opens scrolled past the autosaves when at least one file save exists:
    // the autosaves stay reachable by scrolling up. With no file saves they
    // are the only loadable rows, so they stay in view.
    var _origSceneFileStart = Scene_File.prototype.start;
    Scene_File.prototype.start = function () {
      _origSceneFileStart.call(this);
      this._fileHintRects = {};
      var hw = this._helpWindow;
      if (hw && hw.contents) {
        var text = "[N] Annotate";
        var pad = hw.standardPadding();
        hw.contents.fontSize = 16;
        hw.contents.textColor = "#888888";
        var lw = hw.contents.measureTextWidth(text);
        var hx = Math.floor((hw.contentsWidth() - lw) / 2);
        var hy = (hw.contentsHeight() - 20) / 2;
        hw.contents.drawText(text, hx, hy, lw + 4, 20);
        this._fileHintRects.annotate = {
          x: hw.x + pad + hx,
          y: hw.y + pad + hy,
          w: lw + 4,
          h: 20,
        };
        hw.contents.fontSize = hw.standardFontSize();
        hw.resetTextColor();
      }
      if (
        typeof Scene_Load !== "undefined" &&
        this instanceof Scene_Load &&
        this._listWindow
      ) {
        var lwAuto = this._listWindow;
        var autoTop =
          typeof DataManager.autoSaveCount === "function"
            ? DataManager.autoSaveCount()
            : 0;
        if (autoTop > 0 && this._hasNonAutoSave()) {
          lwAuto.select(autoTop);
          if (typeof lwAuto.setTopRow === "function") lwAuto.setTopRow(autoTop);
        }
      }
    };

    // True when any positive (file) savefile slot holds data.
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

    // Touch parity for the [N] key. Two-stage so a hold stays unambiguous
    // next to "tap = load/save": hold an unhighlighted row to highlight it,
    // hold the highlighted one to open the editor. Either way the gesture is
    // consumed - MouseControl.js reads `_lpFired` on release and suppresses
    // the tap - so a hold never also loads or saves the file.
    Scene_File.prototype._pointInListWindow = function (x, y) {
      var w = this._listWindow;
      if (!w) return false;
      return x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height;
    };
    Scene_File.prototype._updateAnnotateLongPress = function () {
      // Desktop uses the key (and a held mouse button should not annotate).
      if (!_isMobile || typeof TouchInput === "undefined") {
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
          lw.select(hit);
          SoundManager.playCursor();
        } else {
          this._handleAnnotate(this.savefileId());
        }
      }
    };

    // The note is display-only metadata in savenotes.json, never written into
    // the save. Committing must NOT load the game, so the list window is
    // deactivated and the Enter/Esc keydown is swallowed before it can reach
    // the engine's Input handler.
    Scene_File.prototype._handleAnnotate = function (savefileId) {
      if (this._annotateOpen) return;
      if (!fileExists(savePath(savefileId))) {
        SoundManager.playBuzzer();
        return;
      }
      var label = saveLabel(savefileId);
      var current = getNote(savefileId);
      // The default note is a locale timestamp that can be wider than the
      // row's display budget. Editing must not be capped below what's
      // already stored, so give the editor room for the full timestamp.
      var maxLen = Math.max(noteMax(label), current.length, 24);

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

    // A hidden, focused <input> drives native text entry (typing, paste,
    // IME, selection); the row renders the text + caret itself. Positioned
    // over the row's note area so an IME composition anchors there.
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
      // renders the text + caret itself, and opacity:0 also hides the
      // input's native selection highlight. Still focusable/typeable.
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
        } catch (e) {
          /* the row still renders the buffer; typing just needs focus */
        }
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
      var st = inp.style;
      st.left = r.left + gx * sx + "px";
      st.top = r.top + gy * sy + "px";
      st.width = fw * sx + "px";
      st.height = fh * sy + "px";
      st.fontSize = Math.max(8, Math.floor(fh * sy * 0.6)) + "px";
    };

    // Poll the hidden input each frame, mirror its value/caret into the edit
    // state, and repaint the row (text on change, caret on blink). A tap
    // outside the edited row commits (touch has no Esc); the field itself
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
      var val = (this._noteInputEl ? this._noteInputEl.value : ne.text)
        .replace(/\s+$/, "")
        .slice(0, ne.maxLen);
      setNote(ne.id, val);
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

    // Leaving the scene mid-edit (a scene change from elsewhere) must not
    // leave the hidden input and the capture handler behind.
    var _origSceneFileTerminate = Scene_File.prototype.terminate;
    Scene_File.prototype.terminate = function () {
      if (this._annotateOpen) this._endNoteEdit();
      if (_origSceneFileTerminate) _origSceneFileTerminate.call(this);
    };
  }

  // Section 9 helpers, kept outside its guard: pure, and unit-tested alone.

  // A snapshot that is essentially black is the hallmark of a save captured
  // during a cutscene fade, where the map would be far more useful than a
  // void. Coarse grid off one readback, and >=99% dark, so a genuinely dim
  // scene (a night tint, a shadowed room) is kept as it is.
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

  // Strips the three darkening sources of a full-black cutscene frame: the
  // blackout tint swapInSavedState keeps as a lasting tone, the brightness
  // fade, and a full-screen black picture used as a manual fade. Only called
  // once the snapshot already tested >=99% black, so there is no meaningful
  // picture to lose. The returned restore fn is NOT optional: the screen
  // lives on the shared _saveContentsCache, so leaving it de-blacked would
  // hide the blackout from the next visit's first snap.
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

  // Set by the Continue load (section 10) for the one Scene_Map that
  // follows; cleared by that scene's start.
  var _skipLoadFadeIn = false;

  // 9. Continue preview

  // The map id comes from the save; the two image hashes come from the map
  // JSON's note field, e.g. "<ground:bab183cf848588f3><par:6bfa4133bda1b1bd>".
  // Falls back to ground + parallax when no full snapshot can be produced,
  // and to the default background when neither resolves.
  //
  // Gated to a Scene_Load reached FROM the title (isPreviousScene), so the
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

    function fetchMapBgNote(mapId, cb) {
      if (!mapId) {
        cb(null);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(_mapBgNoteCache, mapId)) {
        cb(_mapBgNoteCache[mapId]);
        return;
      }
      loadMapJson(mapId, function (data) {
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
      });
    }

    // The ground / parallax art is loaded exactly as OrangeOverlay loads the
    // same layers (its "Organized Folders" option picks img/overlays/<kind>/
    // over the flat img/parallaxes/), through the game's own redirect +
    // decrypt. The bitmap state is polled (load listeners fire on success
    // only) so a missing or errored image resolves to null instead of
    // hanging the pending count.
    function loadMapBgImage(kind, hash, cb) {
      if (!hash) {
        cb(null);
        return;
      }
      var key = kind + ":" + hash;
      if (Object.prototype.hasOwnProperty.call(_mapBgImgCache, key)) {
        cb(_mapBgImgCache[key]);
        return;
      }
      var bmp = null;
      try {
        var P =
          window.Hudell &&
          window.Hudell.OrangeOverlay &&
          window.Hudell.OrangeOverlay.Param;
        bmp =
          P && P.organizedFolders
            ? ImageManager.loadBitmap("img/overlays/" + kind + "/", hash)
            : ImageManager.loadParallax(hash);
      } catch (e) {
        bmp = null;
      }
      if (!bmp) {
        _mapBgImgCache[key] = null;
        cb(null);
        return;
      }
      var tries = 0;
      (function poll() {
        if (bmp.isReady() && !(bmp.isError && bmp.isError())) {
          var ok = bmp.width > 1 ? bmp : null;
          _mapBgImgCache[key] = ok;
          cb(ok);
        } else if ((bmp.isError && bmp.isError()) || tries++ > 300) {
          _mapBgImgCache[key] = null;
          cb(null);
        } else {
          setTimeout(poll, 16);
        }
      })();
    }

    // Reconstruct the saved game objects, build a real Spriteset_Map and
    // render one frame to a Bitmap: what the game looked like at the instant
    // of saving. Cached per savefileId; null when it cannot be produced and
    // the caller falls back to ground/parallax.
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

    function renderSaveSceneSnapshot(savefileId, cb) {
      if (Object.prototype.hasOwnProperty.call(_sceneSnapCache, savefileId)) {
        cb(_sceneSnapCache[savefileId]);
        return;
      }
      if (
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
        contents = ns.saveContents(savefileId);
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
      loadMapJson(mapId, function (dataMap) {
        if (!dataMap) {
          finish(null);
          return;
        }
        buildAndSnapScene(contents, dataMap, finish);
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
      // gatherFollowers puts followers on the player's exact tile, where they
      // render stacked under the avatar and read as a duplicate of the
      // controlled character. Blank only the co-located ones; the save is a
      // throwaway parsed copy, so the live party is untouched.
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
      // A save captured mid-fade (an autosave during a map transfer leaves
      // _brightness 0) would preview as a black sprite, so the fade, flash
      // and shake overlays are reset; the lasting tone and zoom are kept.
      //
      // Unless a CG is visible on top of the black, where the fade IS the
      // intended backdrop: clearing it would reveal the map under the CG.
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
      // contents.message (section 6, pure-text lines only). Stand in a deep copy so the preview can render the actual
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

    // TCOAAL's dialogue is not one self-contained window: three plugins put
    // pieces on the SCENE, so each has to be redirected at the snapshot stage
    // rather than the live one.
    //   - YEP_MessageCore.createSubWindows does SceneManager._scene.addChild
    //     for the speaker name box. Built against the live scene it lands on
    //     Scene_Load, above the menu, and is never removed between rows.
    //   - GALV_MessageBackground draws the message box itself as a scene
    //     sprite (msgimg_*); the window's own skin is forced transparent.
    //   - Irina_VisualNovelBusts: the in-dialogue body bust hangs off the
    //     window, but standalone \BUST[n] busts resolve through
    //     $bust(n) = SceneManager._scene._spriteset._messageBustSprites[n],
    //     so the stage is shimmed with _spriteset/_messageWindow. Busts start
    //     at opacity 0 and fade in from their own update(), which nothing
    //     drives here, so fillSnapshotMessageWindow settles them. The body
    //     bust is lifted out of the window onto its own layer, or it renders
    //     bundled with (and dimmed by) the box.
    //
    // Called inside the swapped span, so startMessage reserves the face/bust
    // and windowskin bitmaps in time for the shared waitReady loop. Stage
    // order, bottom to top: spriteset -> pictures -> body bust -> GALV
    // background -> speaker name -> message text. Null when there is no text
    // or a plugin throws, and the snapshot is then the map without dialogue.
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
        console.warn("[ImprovedLoader] snapshot message build failed:", e);
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

    // Irina keeps no bust state in the save and only the speaking bust is
    // reconstructable from $gameMessage, so the non-speaker would be missing
    // without the $gameSystem._vnBusts section 6 stamps. Slot 0 is skipped:
    // the message rebuild already drives it from the [BUST] faceName. Runs
    // inside the scene-shimmed span so $bust(n) resolves to the snapshot's
    // busts, with opacity and transform forced (no fade).
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
        console.warn("[ImprovedLoader] snapshot bust restore failed:", e);
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
        console.warn("[ImprovedLoader] snapshot message render failed:", e);
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
          typeof Scene_Base.prototype.createPicturesForCameraCore === "function"
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
        console.warn("[ImprovedLoader] scene preview build failed:", buildErr);
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
          console.warn("[ImprovedLoader] scene preview snap failed:", e);
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
      var mapId = ns.saveMapId(savefileId);
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
      var mapId = ns.saveMapId(savefileId);
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
          loadMapBgImage("grounds", info.ground, function (b) {
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
          loadMapBgImage("pars", info.par, function (b) {
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

    // 10. Fast load

    // The hovered slot already renders the map Scene_Map is about to show, so
    // the normal success path runs (sound, audio fade-out, version reload,
    // goto) with its black visual fade neutralized and only the menu chrome
    // dissolving over the snapshot.
    //
    // Only when a snapshot is actually showing for the selected slot. A
    // blackout-origin slot keeps the stock fade on purpose: there the
    // fade-to-black is what is wanted, so the previewed map fades out instead
    // of flashing straight to black.
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
      _skipLoadFadeIn = true;
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

  // 10. Fast load, the Scene_Map half

  // Suppress Scene_Map's from-black fade-in for the seamless Continue load
  // (set by Scene_Load.onLoadSuccess). Only consumed for a non-transfer load
  // coming straight from Scene_Load; a version-mismatch reload (_transfer) or
  // any other entry keeps the stock fade. The flag is always cleared after
  // start so it can never leak into a later scene change.
  if (typeof Scene_Map !== "undefined") {
    var _origMapNeedsFadeIn = Scene_Map.prototype.needsFadeIn;
    Scene_Map.prototype.needsFadeIn = function () {
      if (
        _skipLoadFadeIn &&
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
      _skipLoadFadeIn = false;
    };
  }

  // 11. Quick save

  // A quick save is a normal *file* save: the shortcut for menu -> save ->
  // pick a slot. File slots use positive ids and are uncapped (section 4);
  // the game's autosaves (ids <= 0) are managed by the engine and untouched.
  // Exposes window.__quickSave (VirtualController.js's on-screen button
  // forwards to it) and binds the 'M' key globally. A 1 s cooldown debounces
  // both paths.
  var QS_COOLDOWN = 1000;
  var _qsLastAt = 0;
  var _qsToastEl = null;
  var _qsToastTimer = null;

  // Saving is only meaningful on the map with saving enabled: the same gate
  // the engine's Scene_Save enforces before DataManager.saveGame.
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

  // Transient feedback toast, plain DOM over the canvas. The font size is
  // clamp(13px, 3.4vw, 18px) computed here: the game's NW.js (Chromium 65)
  // drops a declaration that uses clamp().
  function qsToast(msg) {
    if (typeof document === "undefined" || !document.body) return;
    if (!_qsToastEl) {
      var vw = typeof window !== "undefined" ? window.innerWidth || 0 : 0;
      var fontPx = Math.round(Math.min(18, Math.max(13, vw * 0.034)));
      _qsToastEl = document.createElement("div");
      _qsToastEl.id = "qs-toast";
      _qsToastEl.style.cssText = [
        "position:fixed;left:50%;top:12%;transform:translateX(-50%)",
        "z-index:100001;pointer-events:none;white-space:nowrap",
        "background:rgba(20,20,26,0.82);color:#f4f4f4;padding:8px 16px",
        "border:2px solid rgba(255,255,255,0.32);border-radius:18px",
        "font-family:Arial,Helvetica,sans-serif;font-weight:bold",
        "font-size:" + fontPx + "px",
        "text-shadow:0 1px 2px rgba(0,0,0,0.8)",
        "opacity:0;transition:opacity 0.18s",
      ].join(";");
      document.body.appendChild(_qsToastEl);
    }
    _qsToastEl.textContent = msg;
    void _qsToastEl.offsetWidth; // restart the fade if already visible
    _qsToastEl.style.opacity = "1";
    if (_qsToastTimer) clearTimeout(_qsToastTimer);
    _qsToastTimer = setTimeout(function () {
      if (_qsToastEl) _qsToastEl.style.opacity = "0";
    }, 1400);
  }

  function quickSave() {
    var now = Date.now();
    if (now - _qsLastAt < QS_COOLDOWN) return;
    _qsLastAt = now;

    // Best-effort: dim VirtualController's save button if it's on screen
    // (no-op when that plugin isn't installed).
    var btn =
      typeof document !== "undefined" && document.querySelector
        ? document.querySelector("#vc-overlay .vc-save")
        : null;
    if (btn) {
      btn.classList.add("vc-cooldown");
      setTimeout(function () {
        btn.classList.remove("vc-cooldown");
      }, QS_COOLDOWN);
    }

    if (!canQuickSave()) {
      if (typeof SoundManager !== "undefined") SoundManager.playBuzzer();
      return;
    }
    var id = firstAvailableSlot();
    $gameSystem.onBeforeSave();
    if (DataManager.saveGame(id)) {
      if (typeof StorageManager !== "undefined" && StorageManager.cleanBackup) {
        StorageManager.cleanBackup(id);
      }
      SoundManager.playSave();
      qsToast("Saved: slot " + id);
    } else {
      SoundManager.playBuzzer();
      qsToast("Save failed");
    }
  }

  if (typeof window !== "undefined" && !window.__quickSave) {
    window.__quickSave = quickSave;
    // 'M' quick-saves from the keyboard. Ignore auto-repeat and presses
    // while typing into a field (the save-note input) so it never fires
    // twice or steals a keystroke.
    if (typeof window.addEventListener === "function") {
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
    }
  }

  ns.pad3 = pad3;
  ns.detectEpisode = detectEpisode;
  ns.compareVersionText = compareVersionText;
  ns.saveVersion = saveVersion;
  ns.currentGameVersionText = currentGameVersionText;
  ns.formatSaveTimestamp = formatSaveTimestamp;
  ns.loadMapJson = loadMapJson;
  ns.createNoteStore = createNoteStore;
  ns.readTextFile = readTextFile;
  ns.fileExists = fileExists;
  ns.savePath = savePath;
  ns.saveBasename = saveBasename;
  ns.saveMapId = saveMapId;
  ns.saveContents = saveContents;
  ns.invalidateSaveCaches = invalidateSaveCaches;
  ns.getNote = getNote;
  ns.setNote = setNote;
  ns.isAutoNote = isAutoNote;
  ns.applyDefaultSaveNote = applyDefaultSaveNote;
  ns.saveLabel = saveLabel;
  ns.highestSaveSlot = highestSaveSlot;
  ns.captureVnBusts = captureVnBusts;
  ns.noteMax = noteMax;
  ns.isBitmapMostlyBlack = isBitmapMostlyBlack;
  ns.neutralizeBlackout = neutralizeBlackout;
  ns.saveHasVisiblePicture = saveHasVisiblePicture;
  ns.firstAvailableSlot = firstAvailableSlot;
  ns.quickSave = quickSave;
  ns.qsToast = qsToast;

  if (typeof window !== "undefined") window.ImprovedLoader = ns;
  else if (typeof globalThis !== "undefined") globalThis.ImprovedLoader = ns;
})();

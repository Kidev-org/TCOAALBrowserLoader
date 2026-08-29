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
 * Steam achievement replacement for The Coffin of Andy and Leyley.
 *
 * The browser has no Steamworks. browser-shim.js routes Steam.awardAchievement,
 * Steam.activateAchievement and Steam.setAchievement to __achvUnlock(id), which
 * this file defines. Unlocks persist to localStorage, show a corner toast with
 * a fanfare sound, and are browsable from a new "Achievements" title menu item.
 *
 * Exposes:
 *   window.__achvUnlock(id)         -> register an unlock (idempotent)
 *   window.__achvIsUnlocked(id)     -> bool
 *   window.__achvList()             -> [{id,name,description,unlocked,unlockedAt}]
 *   window.__achvShimHookBoot()     -> called from index.html after DRM boots
 */
(function () {
  "use strict";

  // Registry

  // Canonical IDs extracted from the game's plugin-command data
  // (`achv <ID>` in Map*.json events). Order mirrors achievements.md.
  //
  // This is the ONLY list of achievements in the project. Its order is also
  // the BIT ORDER of the mask POSTed to /api/achv (index i is bit `1 << i`),
  // and the counter Worker reads this very array out of this very file at
  // runtime (achievementIds() in worker/src/index.js) rather than keeping a
  // copy -- so adding an achievement here is the whole change, with no second
  // list to update and no Worker redeploy.
  //
  // APPEND-ONLY. Reordering remaps the masks already recorded by deployed
  // clients onto the wrong achievements, with no way to detect or undo it
  // afterwards. New achievements go on the end.
  //
  // Two shape constraints that parser relies on: the declaration must stay a
  // top-level `var` of this name opening an array literal, and each entry must
  // carry a literal id in UPPER_SNAKE double quotes. Both are covered by the
  // "Achievement registry <-> counter Worker contract" tests in tools/test.js.
  var ACHIEVEMENTS = [
    {
      id: "EP1_CLEAR",
      name: "Episode 1 Clear",
      description: "Cleared episode 1.",
    },
    {
      id: "EP2_CLEAR",
      name: "Episode 2 Clear",
      description: "Cleared episode 2.",
    },
    {
      id: "HITMAN_WINS",
      name: "Hitman Wins!",
      description: "Found the hitman.",
    },
    { id: "WARDEN_WINS", name: "Warden Wins", description: "Got caught." },
    {
      id: "NO_WITNESSES",
      name: "No Witnesses",
      description: "Left no witnesses.",
    },
    { id: "PRESENT", name: "Present", description: "Found a present." },
    {
      id: "VISION_WATCHER",
      name: "Vision Watcher",
      description: "Found an unexpected spectator.",
    },
    {
      id: "EP3D_CLEAR",
      name: "Decaying Along",
      description: "Survived Episode 3: Decay.",
    },
    {
      id: "MATH",
      name: "Little Mathematician",
      description: "Did Leyley's homework right.",
    },
    {
      id: "LEYLEYWINS_END",
      name: "_____ in a Box",
      description: "Don't grow a spine.",
    },
    {
      id: "SUMMON_LU",
      name: "Unknown Summon",
      description: "Summoned an unknown entity.",
    },
    {
      id: "TIME_CAPSULE",
      name: "Time Capsule",
      description: "Found a time capsule.",
    },
    {
      id: "HAPPY_END",
      name: "Happy end!",
      description: "The ending you deserve.",
    },
    {
      id: "SPLAT",
      name: "Splat!",
      description: "Reached the Deadest of Dead-ends End.",
    },
    {
      id: "PROPHECY_FULFILLER",
      name: "Prophecy Fulfiller",
      description: "Win at tag, just as the prophecy foretold!",
    },
    {
      id: "SHOTSEND",
      name: "Shots and Such",
      description: "Reached the Shots and Such ending.",
    },
    {
      id: "FULL_MARKS",
      name: "Full marks!",
      description: "Got full marks on a... test?",
    },
    {
      id: "UNDETECTED",
      name: "Undetected",
      description: "Left the gas stop relatively unnoticed.",
    },
    {
      id: "SISTER_SLAUGHTERER",
      name: "Sister Slaughterer",
      description: "Ran out of Ashleys.",
    },
    {
      id: "TRUEEND",
      name: "Cleared Burial",
      description: "Reached the Truest of True-ends ending.",
    },
  ];

  var STORAGE_KEY = "_achievements";
  // Same-origin paths: images are fetched from Steam CDN during the GitHub
  // Actions deploy (see .github/workflows/deploy.yml). Local dev falls back
  // to the placeholder rectangles below.
  var IMG_UNLOCKED_URL = "img/achievement-unlocked.jpg";
  var IMG_LOCKED_URL = "img/achievement-locked.jpg";
  var SOUND_PATH = "audio/me/313d5ade731cde57.ogg";

  // Persistence

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function findRegistryEntry(id) {
    var up = String(id || "").toUpperCase();
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      if (ACHIEVEMENTS[i].id === up) return ACHIEVEMENTS[i];
    }
    console.warn("[achv] unknown achievement ID:", up);
    return null;
  }

  function isUnlocked(id) {
    if (id == null) return false;
    return !!loadState()[String(id).toUpperCase()];
  }

  function unlock(id) {
    if (id == null) return false;
    var key = String(id).toUpperCase();
    var entry = findRegistryEntry(key);
    if (!entry) return false;
    var state = loadState();
    if (state[key]) return false;
    state[key] = { t: Date.now() };
    saveState(state);
    reportUnlocks();
    showToast(entry);
    playSound();
    return true;
  }

  window.__achvUnlock = unlock;
  window.__achvIsUnlocked = isUnlocked;
  window.__achvList = function () {
    var state = loadState();
    return ACHIEVEMENTS.map(function (a) {
      var rec = state[a.id];
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        unlocked: !!rec,
        unlockedAt: rec ? rec.t : null,
      };
    });
  };

  // Global stats (player count + per-achievement completion rate)
  //
  // Two halves, both talking to the Worker in worker/src/index.js:
  //   report -> POST /api/achv/{mask}[?new=1], at most once per event per
  //             browser, so the totals mean "how many people" and not "how
  //             many times a page loaded".
  //   read   -> GET /api/achv, once per session, to draw the menu.
  //
  // Deliberately public and unaudited, exactly like the mod install counts:
  // cheatable by clearing site data, which is effort spent to make a
  // popularity figure slightly wrong.

  // What this browser has already told the API about. Both keys are spared by
  // our own "Clear browser data" buttons (INSTALL_FLAG_RE in index.html and
  // loader.html) -- surviving a clear is the entire point, since a browser
  // that forgets is a browser that counts itself as a second player. Only the
  // browser's native site-data controls reset them.
  var ACHV_PLAYER_KEY = "_achvPlayerCounted";
  var ACHV_REPORTED_KEY = "_achvReported";

  // Hard ceiling on the ACHIEVEMENTS registry, mirroring MAX_ACHIEVEMENTS in
  // worker/src/index.js. JavaScript's bitwise operators coerce to 32-bit
  // SIGNED integers: bit 31 is the sign bit (1 << 31 is negative, which the
  // Worker rejects) and bit 32 wraps silently onto bit 0, which would inflate
  // the FIRST achievement's count instead of failing. 31 usable bits (0..30)
  // is the honest limit of a single-number mask; there are 20 today.
  //
  // Growing past this needs a real wire change on both sides (a second mask,
  // or a list of ids). Until then, refuse to report the overflow rather than
  // corrupt a live counter, and say so once in the console.
  var MAX_ACHIEVEMENTS = 31;
  var _warnedOverflow = false;

  /** Bitmask of everything currently unlocked, in ACHIEVEMENTS order. */
  function unlockedMask() {
    var state = loadState();
    var n = ACHIEVEMENTS.length;
    if (n > MAX_ACHIEVEMENTS) {
      n = MAX_ACHIEVEMENTS;
      if (!_warnedOverflow) {
        _warnedOverflow = true;
        console.error(
          "[achv] registry has " +
            ACHIEVEMENTS.length +
            " achievements; only the first " +
            MAX_ACHIEVEMENTS +
            " can be reported through a 32-bit mask. " +
            "The /api/achv wire format must change before adding more.",
        );
      }
    }
    var mask = 0;
    for (var i = 0; i < n; i++) {
      if (state[ACHIEVEMENTS[i].id]) mask |= 1 << i;
    }
    return mask;
  }

  /** Bitmask of what we have already counted. 0 on anything unparseable. */
  function reportedMask() {
    try {
      var n = parseInt(localStorage.getItem(ACHV_REPORTED_KEY) || "0", 10);
      return n >= 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  function setReportedMask(mask) {
    try {
      localStorage.setItem(ACHV_REPORTED_KEY, String(mask));
    } catch (e) {
      // Private mode / quota: worst case this browser reports again later.
    }
  }

  function isPlayerCounted() {
    try {
      return localStorage.getItem(ACHV_PLAYER_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  /**
   * Count this browser's unreported unlocks, and itself as a player the first
   * time. Fire-and-forget: called at boot (to flush anything unlocked while
   * offline, or before this feature existed) and after every unlock.
   *
   * A browser with no player flag is new: it adds 1 to the player total and
   * whatever it has unlocked right now, in one POST. After that it only ever
   * adds achievements, never players again -- which is what makes a
   * percentage meaningful rather than a ratio of two unrelated numbers.
   */
  function reportUnlocks() {
    try {
      if (typeof fetch !== "function") return;
      // Offline: nothing is lost. The flags are unchanged, so the next boot
      // (or the next unlock while online) reports the same backlog.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }
      var isNew = !isPlayerCounted();
      var already = reportedMask();
      var delta = unlockedMask() & ~already;
      if (!isNew && delta === 0) return;

      // Mark BEFORE the response lands, and roll back only on a failure we
      // actually observe -- the same trade as trackModInstall in lang-shim.js.
      // The page can go away mid-flight (a scene change, a reload, closing the
      // tab) while `keepalive` still delivers the POST, so an unobserved
      // outcome is overwhelmingly a success: assume it, and correct only what
      // we are told about. Double-counting a player is worse than missing a
      // rare achievement.
      if (isNew) {
        try {
          localStorage.setItem(ACHV_PLAYER_KEY, "1");
        } catch (e) {}
      }
      setReportedMask(already | delta);

      // Reflect it locally so the menu shows this user's own contribution
      // immediately, instead of waiting out the session memo and the Worker's
      // edge cache. Suppressed while _stats is null, where inventing numbers
      // would be worse than drawing none.
      if (_stats) {
        if (isNew) _stats.players++;
        for (var i = 0; i < ACHIEVEMENTS.length; i++) {
          if (delta & (1 << i)) {
            var id = ACHIEVEMENTS[i].id;
            _stats.counts[id] = (_stats.counts[id] || 0) + 1;
          }
        }
      }

      fetch("/api/achv/" + delta + (isNew ? "?new=1" : ""), {
        method: "POST",
        keepalive: true,
      })
        .then(function (res) {
          if (res && res.ok) return;
          // A response we actually received that says no (400/429/5xx): undo
          // exactly what this call claimed, so a later attempt can retry it.
          if (isNew) {
            try {
              localStorage.removeItem(ACHV_PLAYER_KEY);
            } catch (e) {}
            if (_stats) _stats.players--;
          }
          setReportedMask(reportedMask() & ~delta);
          if (_stats) {
            for (var j = 0; j < ACHIEVEMENTS.length; j++) {
              if (delta & (1 << j)) {
                var k = ACHIEVEMENTS[j].id;
                if (_stats.counts[k]) _stats.counts[k]--;
              }
            }
          }
        })
        .catch(function () {
          // Deliberately NOT a rollback: a rejected promise here usually means
          // the page went away, not that the POST failed (keepalive still
          // delivers it). See the marking comment above.
        });
    } catch (e) {
      // Counting must never break an unlock that already happened.
    }
  }

  // {players, counts} once loaded, null until then. Read once per session:
  // the numbers move slowly, reportUnlocks keeps our own contribution live
  // locally, and the menu simply draws no percentages while this is null.
  var _stats = null;
  var _statsLoaded = false;
  var _statsInFlight = false;
  var _statsWaiters = [];

  /** Load the global stats, coalescing concurrent callers onto one request. */
  function loadStats(callback) {
    if (_statsLoaded) {
      if (callback) callback(_stats);
      return;
    }
    if (callback) _statsWaiters.push(callback);
    if (_statsInFlight) return;
    if (typeof fetch !== "function") {
      settleStats(null);
      return;
    }
    _statsInFlight = true;
    fetch("/api/achv", { credentials: "same-origin" })
      .then(function (res) {
        return res && res.ok ? res.json() : null;
      })
      .then(function (data) {
        settleStats(
          data && typeof data.players === "number"
            ? { players: data.players, counts: data.counts || {} }
            : null,
        );
      })
      .catch(function () {
        // Offline or the API is down: the menu drops the percentages and the
        // player count, and is otherwise fully usable.
        settleStats(null);
      });
  }

  function settleStats(stats) {
    _stats = stats;
    _statsLoaded = true;
    _statsInFlight = false;
    var waiters = _statsWaiters;
    _statsWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      try {
        waiters[i](_stats);
      } catch (e) {}
    }
  }

  /**
   * Share of players holding this achievement, as a display string, or "" when
   * unknown. Guarded on players > 0 so a fresh (or unreachable) database can
   * never divide by zero or print a fictional 100%.
   *
   * Precision follows the magnitude, because the rare achievements are the
   * interesting ones and a fixed number of decimals either wastes digits at
   * the top or collapses the bottom onto "0%":
   *
   *   everyone   100%
   *   >= 10%     15.5%     1 decimal
   *   >= 1%      4.59%     2 decimals
   *   > 0%       0.777%    3 decimals
   *   nobody     0%
   */
  function completionText(id) {
    if (!_stats || !(_stats.players > 0)) return "";
    var n = _stats.counts[id] || 0;
    // Exact ends get exact labels: "100%" only when literally every counted
    // player has it, "0%" rather than a row of zeroes when nobody does.
    if (n <= 0) return "0%";
    if (n >= _stats.players) return "100%";

    var pct = (n / _stats.players) * 100;
    var digits = pct >= 10 ? 1 : pct >= 1 ? 2 : 3;
    var text = pct.toFixed(digits);
    // toFixed rounds both ways, and both ends can lie:
    //   99.97  -> "100.0%", claiming every player holds it when some do not
    //   0.0001 -> "0.000%", indistinguishable from the nobody-has-it "0%"
    // Clamp to the nearest value this band can honestly show instead.
    var step = Math.pow(10, -digits);
    if (parseFloat(text) >= 100) return (100 - step).toFixed(digits) + "%";
    if (parseFloat(text) === 0) return "<" + step.toFixed(digits) + "%";
    return text + "%";
  }

  /**
   * The same figure spelled out, for the held row: "(4/1,203)". Answers
   * "out of how many?", which a percentage alone never does.
   */
  function completionDetail(id) {
    if (!_stats || !(_stats.players > 0)) return "";
    var n = _stats.counts[id] || 0;
    return (
      "(" + n.toLocaleString() + "/" + _stats.players.toLocaleString() + ")"
    );
  }

  // Toast (DOM overlay: works regardless of scene / WebGL state)

  var _toastQueue = [];
  var _toastBusy = false;
  var _toastEl = null;

  function ensureToastEl() {
    if (_toastEl) return _toastEl;
    var d = document.createElement("div");
    d.id = "__achv-toast";
    d.style.cssText = [
      "position:fixed",
      "right:20px",
      "bottom:24px",
      "z-index:100000",
      "display:flex",
      "align-items:center",
      "background:rgba(10,10,14,0.92)",
      "border:1px solid #6a5a44",
      "border-radius:6px",
      "padding:10px 14px",
      "font-family:Georgia,serif",
      "color:#e8d7b9",
      "width:360px",
      "max-width:calc(100vw - 40px)",
      "box-shadow:0 6px 24px rgba(0,0,0,0.7)",
      "transform:translateX(calc(100% + 40px))",
      "opacity:0",
      "transition:transform 0.35s ease-out, opacity 0.35s ease-out",
      "pointer-events:none",
    ].join(";");
    d.innerHTML =
      '<img id="__achv-toast-img" alt="" ' +
      'style="width:56px;height:56px;border-radius:4px;margin-right:12px;object-fit:cover;flex-shrink:0;background:#1a1a1a">' +
      '<div style="min-width:0;flex:1">' +
      '<div style="font-size:11px;letter-spacing:0.15em;color:#b5a178;text-transform:uppercase;margin-bottom:3px">Achievement Unlocked</div>' +
      '<div id="__achv-toast-name" style="font-size:16px;font-weight:bold;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>' +
      '<div id="__achv-toast-desc" style="font-size:12px;color:#c0b095;opacity:0.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>' +
      "</div>";
    document.body.appendChild(d);
    _toastEl = d;
    return d;
  }

  function showToast(entry) {
    _toastQueue.push(entry);
    if (!_toastBusy) runToastQueue();
  }

  function runToastQueue() {
    if (_toastQueue.length === 0) {
      _toastBusy = false;
      return;
    }
    _toastBusy = true;
    var entry = _toastQueue.shift();
    var d = ensureToastEl();
    var img = document.getElementById("__achv-toast-img");
    img.src = IMG_UNLOCKED_URL;
    document.getElementById("__achv-toast-name").textContent = entry.name;
    document.getElementById("__achv-toast-desc").textContent =
      entry.description || "";
    // Force reflow to reset the transition before each show
    void d.offsetWidth;
    requestAnimationFrame(function () {
      d.style.transform = "translateX(0)";
      d.style.opacity = "1";
    });
    setTimeout(function () {
      d.style.transform = "translateX(calc(100% + 40px))";
      d.style.opacity = "0";
      setTimeout(runToastQueue, 420);
    }, 4200);
  }

  function playSound() {
    try {
      var a = new Audio(SOUND_PATH);
      a.volume = 0.8;
      var p = a.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {}
  }

  // Icon preloading for the Achievements scene.
  // Served same-origin, so Bitmap.load is sufficient (no WebGL taint).

  var _iconUnlockedBmp = null;
  var _iconLockedBmp = null;
  var _iconsStarted = false;

  // Load an icon without escalating a failure to the engine's blocking
  // "Loading error" dialog. The achievement images are bundled app assets,
  // but if one is missing (e.g. offline before the shell precache landed)
  // the stock Bitmap.load path would route the failure through
  // ResourceHandler -> Graphics.printLoadingError + SceneManager.stop(),
  // freezing the Achievements scene. Instead we build the bitmap from a raw
  // Image and, on error, leave it unloaded so drawItem falls back to the
  // placeholder rectangle.
  function _loadSafeIcon(url) {
    var bitmap = Object.create(Bitmap.prototype);
    bitmap._defer = true;
    bitmap.initialize();
    bitmap._url = url;
    bitmap._loadingState = "requesting";
    var image = new Image();
    image.addEventListener("load", function () {
      bitmap._image = image;
      bitmap._loadingState = "requestCompleted";
      try {
        bitmap.decode();
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

  function _preloadIcon(url, setter) {
    if (typeof Bitmap === "undefined") return;
    var bmp = _loadSafeIcon(url);
    setter(bmp);
    bmp.addLoadListener(function () {
      var sc = typeof SceneManager !== "undefined" && SceneManager._scene;
      if (sc && sc._listWindow && sc._listWindow.refresh) {
        sc._listWindow.refresh();
      }
    });
  }

  function ensureIcons() {
    if (_iconsStarted) return;
    _iconsStarted = true;
    _preloadIcon(IMG_UNLOCKED_URL, function (b) {
      _iconUnlockedBmp = b;
    });
    _preloadIcon(IMG_LOCKED_URL, function (b) {
      _iconLockedBmp = b;
    });
  }

  // Scene / Window patches (deferred: DRM defines these in plugins)

  var _patchesApplied = false;

  function applyPatches() {
    if (_patchesApplied) return;
    _patchesApplied = true;

    // Achievements are a base-game feature (the DRM's ending/gallery system).
    // They make no sense under an overhaul mod, which rewrites the dataset, so
    // the entry is hidden whenever an overhaul is active. The base game and its
    // translations leave _activeMod empty (translations are a separate
    // _activeLang overlay now), so an empty / translation-valued _activeMod
    // means "base context" -> show.
    function isBaseContext() {
      try {
        var m = localStorage.getItem("_activeMod");
        return !m || m.indexOf("translation_") === 0;
      } catch (e) {
        return true;
      }
    }

    // Title menu command injection. The DRM payload's makeCommandList
    // filters strictly to MenuOptions.labels(): we wrap AFTER it and
    // insert "Achievements" before Mods/Quit (base context only).
    if (typeof Window_TitleCommand !== "undefined") {
      var _orig_makeCmdList = Window_TitleCommand.prototype.makeCommandList;
      Window_TitleCommand.prototype.makeCommandList = function () {
        _orig_makeCmdList.call(this);
        if (!isBaseContext()) return;
        var insertIdx = this._list.length;
        for (var i = 0; i < this._list.length; i++) {
          var sym = this._list[i].symbol;
          var nm = this._list[i].name;
          if (
            sym === "mods" ||
            sym === "quit" ||
            sym === "exitGame" ||
            nm === "Quit Game"
          ) {
            insertIdx = i;
            break;
          }
        }
        this._list.splice(insertIdx, 0, {
          name: "Achievements",
          symbol: "achievements",
          enabled: true,
          ext: null,
        });
      };

      // Widen the title command window so "Achievements" fits with its icon.
      Window_TitleCommand.prototype.windowWidth = function () {
        return 280;
      };
    }

    // Register the Achievements icon with the DRM's MenuOptions so the
    // title menu draws it next to the label (same pattern as Mods).
    if (
      typeof MenuOptions !== "undefined" &&
      MenuOptions.iconImages &&
      typeof ImageManager !== "undefined" &&
      typeof Bitmap !== "undefined"
    ) {
      var achvSheet = ImageManager.loadNormalBitmap("img/achievements.png", 0);
      var achvIcon = new Bitmap(26, 26);
      achvSheet.addLoadListener(function () {
        achvIcon.blt(
          achvSheet,
          0,
          0,
          achvSheet.width,
          achvSheet.height,
          0,
          0,
          26,
          26,
        );
        achvIcon._loadingState = "loaded";
        achvIcon._callLoadListeners();
        if (
          typeof SceneManager !== "undefined" &&
          SceneManager._scene &&
          SceneManager._scene._commandWindow
        ) {
          SceneManager._scene._commandWindow.refresh();
        }
      });
      MenuOptions.iconImages["Achievements"] = achvIcon;
    }

    if (typeof Scene_Title !== "undefined") {
      var _orig_ccw = Scene_Title.prototype.createCommandWindow;
      Scene_Title.prototype.createCommandWindow = function () {
        _orig_ccw.call(this);
        this._commandWindow.setHandler(
          "achievements",
          this.commandAchievements.bind(this),
        );
      };

      Scene_Title.prototype.commandAchievements = function () {
        this._commandWindow.close();
        SceneManager.push(Scene_Achievements);
      };
    }

    defineScenes();
    ensureIcons();
    // Flush anything unlocked while offline, plus the whole existing set for a
    // browser that played before this feature shipped (which also counts it as
    // a player). A no-op once there is nothing new to say.
    reportUnlocks();
  }

  function defineScenes() {
    if (typeof Scene_MenuBase === "undefined") return;

    // Scene_Achievements

    window.Scene_Achievements = function () {
      this.initialize.apply(this, arguments);
    };

    Scene_Achievements.prototype = Object.create(Scene_MenuBase.prototype);
    Scene_Achievements.prototype.constructor = Scene_Achievements;

    Scene_Achievements.prototype.create = function () {
      Scene_MenuBase.prototype.create.call(this);
      this.createHelpWindow();
      this.createListWindow();
    };

    // Plain stock help window: title on the left and nothing else. It is drawn
    // once, at creation, and never redrawn -- which matters, because the Mouse
    // Control mod draws its own "<- Back" label straight onto these contents
    // exactly once (drawBackButton in MouseControl.js, which early-exits while
    // _mcBackRect is set). Any later contents.clear() here would erase that
    // label for good while leaving its click rect live.
    //
    // The player total lives on the rows instead: pressing and holding an
    // achievement's percentage shows its "(count/players)", which is the same
    // information where it is actually being asked for.
    Scene_Achievements.prototype.createHelpWindow = function () {
      this._helpWindow = new Window_Help(1);
      var list = window.__achvList();
      var nUnlocked = 0;
      for (var i = 0; i < list.length; i++) if (list[i].unlocked) nUnlocked++;
      this._helpWindow.setText(
        "Achievements  " + nUnlocked + " / " + list.length,
      );
      this.addWindow(this._helpWindow);
      // Stats may already be memoized from an earlier visit, in which case
      // this runs synchronously and the redraw is a no-op.
      var self = this;
      loadStats(function () {
        if (self._listWindow) self._listWindow.refresh();
      });
    };

    Scene_Achievements.prototype.createListWindow = function () {
      var y = this._helpWindow.height;
      var w = Graphics.boxWidth;
      var h = Graphics.boxHeight - y;
      this._listWindow = new Window_AchievementList(0, y, w, h);
      this._listWindow.setHandler("cancel", this.popScene.bind(this));
      this.addWindow(this._listWindow);
    };

    // Window_AchievementList

    window.Window_AchievementList = function () {
      this.initialize.apply(this, arguments);
    };

    Window_AchievementList.prototype = Object.create(
      Window_Selectable.prototype,
    );
    Window_AchievementList.prototype.constructor = Window_AchievementList;

    Window_AchievementList.prototype.initialize = function (x, y, w, h) {
      this._items = window.__achvList();
      this._holdIndex = -1;
      Window_Selectable.prototype.initialize.call(this, x, y, w, h);
      this.refresh();
      this.select(0);
      this.activate();
    };

    // Press-and-hold on a percentage swaps it for the "(count/players)" it was
    // computed from. Deliberately not tied to the cursor or to hover: the
    // fraction is an on-demand detail, so it costs a deliberate gesture and
    // never appears while merely moving through the list.
    //
    // The hit region is the percentage's own drawn text box and nothing else,
    // recomputed from pctRect() rather than cached, so a scroll or a stats
    // update can never leave a stale rect behind. Only the press that starts
    // on a percentage arms the hold; sliding onto one mid-drag does not.
    Window_AchievementList.prototype.update = function () {
      Window_Selectable.prototype.update.call(this);
      this.updateHold();
    };

    Window_AchievementList.prototype.updateHold = function () {
      var held = -1;
      if (this.isOpenAndActive() && TouchInput.isPressed()) {
        held =
          this._holdIndex >= 0
            ? this._holdIndex
            : TouchInput.isTriggered()
              ? this.hitPctIndex(TouchInput.x, TouchInput.y)
              : -1;
      }
      if (held !== this._holdIndex) {
        this._holdIndex = held;
        if (this.contents) this.refresh();
      }
    };

    // Index whose percentage covers the given canvas point, or -1. Only the
    // rows actually on screen are tested; an off-page row has no drawn text to
    // press.
    Window_AchievementList.prototype.hitPctIndex = function (cx, cy) {
      var x = this.canvasToLocalX(cx) - this.padding;
      var y = this.canvasToLocalY(cy) - this.padding;
      if (x < 0 || y < 0) return -1;
      if (x >= this.contentsWidth() || y >= this.contentsHeight()) return -1;
      var top = this.topRow();
      var end = Math.min(top + this.maxPageItems(), this.maxItems());
      for (var i = top; i < end; i++) {
        var r = this.pctRect(i);
        if (!r) continue;
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
          return i;
        }
      }
      return -1;
    };

    // Box the percentage occupies, in contents coordinates. Measured from the
    // percentage even while the fraction is showing in its place: the fraction
    // is wider and only ever grows leftward, so the point that armed the hold
    // stays inside the region for as long as the finger is down.
    Window_AchievementList.prototype.pctRect = function (index) {
      var a = this._items[index];
      if (!a) return null;
      var text = completionText(a.id);
      if (!text) return null;
      var rect = this.itemRectForText(index);
      var prev = this.contents.fontSize;
      this.contents.fontSize = 18;
      var w = this.textWidth(text);
      this.contents.fontSize = prev;
      return {
        x: rect.x + rect.width - w,
        y: rect.y + this.lineHeight() - 4,
        width: w,
        height: this.lineHeight(),
      };
    };

    Window_AchievementList.prototype.maxItems = function () {
      return this._items.length;
    };

    Window_AchievementList.prototype.maxVisibleItems = function () {
      return 6;
    };

    Window_AchievementList.prototype.itemHeight = function () {
      var inner = this.height - this.padding * 2;
      return Math.floor(inner / this.maxVisibleItems());
    };

    Window_AchievementList.prototype.isCurrentItemEnabled = function () {
      return false;
    };

    Window_AchievementList.prototype.playOkSound = function () {};

    Window_AchievementList.prototype._formatDate = function (t) {
      if (!t) return "";
      var d = new Date(t);
      var pad = function (n) {
        return n < 10 ? "0" + n : "" + n;
      };
      return (
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      );
    };

    Window_AchievementList.prototype.drawItem = function (index) {
      var a = this._items[index];
      if (!a) return;
      var rect = this.itemRectForText(index);
      var lh = this.lineHeight();

      var iconH = rect.height - 6;
      var iconW = iconH;
      var iconX = rect.x;
      var iconY = rect.y + 3;

      var src = a.unlocked ? _iconUnlockedBmp : _iconLockedBmp;
      if (src && src.isReady && src.isReady() && src.width > 1) {
        var scale = Math.min(iconW / src.width, iconH / src.height);
        var dw = Math.floor(src.width * scale);
        var dh = Math.floor(src.height * scale);
        var ix = iconX + Math.floor((iconW - dw) / 2);
        var iy = iconY + Math.floor((iconH - dh) / 2);
        this.contents.blt(src, 0, 0, src.width, src.height, ix, iy, dw, dh);
      } else {
        // Fallback placeholder
        var color = a.unlocked ? "#5a7a4a" : "#4a4a4a";
        this.contents.fillRect(iconX, iconY, iconW, iconH, color);
      }

      var tx = iconX + iconW + 12;
      var tw = rect.width - (tx - rect.x);

      this.resetTextColor();
      this.contents.textColor = a.unlocked ? "#f0dfbb" : "#888275";
      this.drawText(a.name, tx, rect.y, tw);

      this.contents.fontSize = 18;
      // Share of all players holding this one, drawn on the description line's
      // right edge. Always shown, locked or not: how rare an achievement is is
      // exactly the hint a locked row wants to give. "" while the API has not
      // answered, in which case the description keeps the full width.
      //
      // Pressing and holding the percentage itself swaps it for the raw
      // "(count/players)" it came from, so the denominator is available on
      // demand without a permanent header spending space on it.
      var held = index === this._holdIndex;
      var pct = held ? completionDetail(a.id) : completionText(a.id);
      var pctW = pct ? this.textWidth(pct) + 12 : 0;
      if (pct) {
        this.contents.textColor = held ? "#c8d8b0" : "#8fa87c";
        this.drawText(pct, tx, rect.y + lh - 4, tw, "right");
      }

      this.contents.textColor = a.unlocked ? "#c8b895" : "#6a6458";
      var desc = a.unlocked
        ? a.description
        : a.description
          ? a.description
          : "Locked";
      this.drawText(desc, tx, rect.y + lh - 4, tw - pctW);

      if (a.unlocked && a.unlockedAt) {
        this.contents.fontSize = 14;
        this.contents.textColor = "#aaaa88";
        this.drawText(
          this._formatDate(a.unlockedAt),
          rect.x,
          rect.y + 4,
          rect.width,
          "right",
        );
      }
      this.contents.fontSize = this.standardFontSize();
      this.resetTextColor();
    };
  }

  function hookSceneBoot() {
    if (typeof Scene_Boot === "undefined") return;
    var _orig_start = Scene_Boot.prototype.start;
    Scene_Boot.prototype.start = function () {
      applyPatches();
      return _orig_start.apply(this, arguments);
    };
  }

  window.__achvShimHookBoot = hookSceneBoot;
})();

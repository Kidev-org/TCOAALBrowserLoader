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
 * VirtualController: on-screen game controller overlay for touch play.
 *
 *   Left   : 4-direction D-pad (up / down / left / right).
 *   Right  : 4 action buttons arranged like a gamepad (A / B / X / Y).
 *   Top-R  : a quick-save button + a menu/escape button (Start-style), in a
 *            row above the action buttons. The quick-save button just forwards
 *            to lang-shim's window.__quickSave (the core quick-save feature,
 *            also bound to the 'M' key there, so it works without this mod).
 *            The menu button opens the game menu; HOLDING it opens the
 *            layout editor (see "Customizing" below).
 *
 * Each control feeds RPG Maker MV's Input system by toggling
 * Input._currentState[<button>] on press / release. The engine's own
 * Input.update() (rpg_core.js) then derives triggered / repeated / pressed
 * exactly as it does for the keyboard, so virtual presses get key-repeat in
 * menus, continuous movement on the map, and hold semantics for free.
 *
 * Button -> logical name mapping (see Input.keyMapper / gamepadMapper):
 *   A    -> 'ok'      confirm / interact
 *   B    -> 'cancel'  back (cancels the current menu)
 *   X    -> 'shift'   dash / run
 *   Y    -> 'control' secondary action
 *   Menu -> 'escape'  opens the menu on the map and backs out of menus
 *                     ('escape' is escape-compatible, so it satisfies both
 *                      Input.isTriggered('menu') and isTriggered('cancel'))
 *
 * The overlay is plain DOM layered above the game canvas: the container is
 * click-through (pointer-events:none) and only the buttons capture pointers,
 * so it never blocks taps on the rest of the screen. It is independent of the
 * active scene and survives scene transitions.
 *
 * Cinematic auto-hide: while a dialogue/message is on screen or a foreground
 * event (cutscene / CG) is running on the map, every control is hidden so it
 * never covers the art. To keep "tap to continue" working in that state, a
 * fullscreen tap layer momentarily presses 'ok' on tap -- but only when the
 * Mouse Control mod is inactive (the base game's DisableMouse plugin neuters
 * clicks, so without Mouse Control nothing else would advance the text). When
 * Mouse Control is active it already routes taps to the game, so the layer
 * stays off and taps pass straight through. Both mods are usually active
 * together, which is the common path.
 *
 * Customizing: holding the menu button for LONG_PRESS_MS opens a layout
 * editor over the game. Each cluster (arrows, actions, menu row) is dragged
 * where the player wants it; a panel sets the size and the opacity, swaps A
 * and B (confirm at the bottom or on the right), turns the arrows into an
 * analog stick (still four arrow presses to the game, dominant axis wins),
 * and resets everything. Done closes it. The layout is kept in localStorage
 * (CONFIG_KEY). Offsets are stored as fractions of the viewport and every
 * cluster is kept fully on screen, so a layout survives a rotation.
 *
 * Written for Chromium 65 as well (plugins/VirtualController.js shares this
 * code and runs in the game's NW.js): no inset/min/max/clamp/env/gap in the
 * editor's CSS, ES5 in the script.
 */

(function () {
  "use strict";

  // Guard against double-injection. The mod system can re-run plugin scripts
  // (live enable, or a reload that re-walks _activePlugins); build the overlay
  // once per page.
  if (window.__virtualControllerLoaded) return;
  window.__virtualControllerLoaded = true;

  if (typeof Input === "undefined") return;

  var DPAD = [
    { name: "up", glyph: "▲", cls: "vc-up" },
    { name: "left", glyph: "◀", cls: "vc-left" },
    { name: "right", glyph: "▶", cls: "vc-right" },
    { name: "down", glyph: "▼", cls: "vc-down" },
  ];

  var ACTIONS = [
    { name: "control", glyph: "Y", cls: "vc-y" },
    { name: "shift", glyph: "X", cls: "vc-x" },
    { name: "ok", glyph: "A", cls: "vc-a" },
    { name: "cancel", glyph: "B", cls: "vc-b" },
  ];

  // Dedicated menu/escape button, sitting in the top row above the actions.
  var MENU = { name: "escape", glyph: "☰", cls: "vc-menu" };

  // Layout editor

  var CONFIG_KEY = "tcoaal.virtualController";
  var LONG_PRESS_MS = 600;
  // Within this share of the stick's radius, no arrow is held.
  var STICK_DEAD = 0.3;
  // The clusters a layout moves, and the corner each one grows from.
  var CLUSTERS = ["dpad", "actions", "menubar"];

  function clampNum(v, lo, hi, dflt) {
    v = Number(v);
    return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  }

  function defaultConfig() {
    var pos = {};
    CLUSTERS.forEach(function (k) {
      pos[k] = { x: 0, y: 0 };
    });
    return { scale: 1, opacity: 1, swapAB: false, stick: false, pos: pos };
  }

  // Whatever is stored, a valid layout comes out: a hand-edited or older
  // value can only fall back to the defaults, never break the overlay.
  function loadConfig() {
    var c = null;
    try {
      c = JSON.parse(localStorage.getItem(CONFIG_KEY));
    } catch (e) {}
    var out = defaultConfig();
    if (!c || typeof c !== "object") return out;
    out.scale = clampNum(c.scale, 0.5, 1.6, 1);
    out.opacity = clampNum(c.opacity, 0.2, 1, 1);
    out.swapAB = c.swapAB === true;
    out.stick = c.stick === true;
    CLUSTERS.forEach(function (k) {
      var p = c.pos && c.pos[k];
      if (p) out.pos[k] = { x: clampNum(p.x, -1, 1, 0), y: clampNum(p.y, -1, 1, 0) };
    });
    return out;
  }

  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (e) {}
  }

  var config = loadConfig();
  var editing = false;
  // Filled by build(): the overlay and the elements a layout touches.
  var ui = null;

  // Input bridge

  // Track which logical buttons this overlay is holding so we can release
  // them cleanly (and recover from the engine's Input.clear() wiping state on
  // window blur, which would otherwise leave our DOM buttons looking stuck).
  var held = {};

  function press(name) {
    if (held[name]) return;
    held[name] = true;
    Input._currentState[name] = true;
  }

  function release(name) {
    if (!held[name]) return;
    held[name] = false;
    Input._currentState[name] = false;
  }

  function releaseAll() {
    for (var name in held) {
      if (held[name]) release(name);
    }
  }

  // Quick save is a core feature owned by lang-shim (window.__quickSave): it
  // performs the save, the 1s cooldown, the toast, and binds the 'M' key
  // globally so the shortcut works even without this mod. The on-screen button
  // below just forwards to it.
  function quickSave() {
    if (typeof window.__quickSave === "function") window.__quickSave();
  }

  // Cinematic gating

  // True while a dialogue/message is on screen or a foreground event (cutscene
  // / CG) is running on the map. Scoped to Scene_Map on purpose: menus, the
  // title screen and battles still need the on-screen controller.
  function isCinematic() {
    try {
      if (typeof SceneManager === "undefined") return false;
      var scene = SceneManager._scene;
      if (
        !scene ||
        typeof Scene_Map === "undefined" ||
        !(scene instanceof Scene_Map)
      )
        return false;
      if (
        typeof $gameMessage !== "undefined" &&
        $gameMessage &&
        $gameMessage.isBusy()
      )
        return true;
      if (
        typeof $gameMap !== "undefined" &&
        $gameMap &&
        $gameMap.isEventRunning()
      )
        return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  // Whether the Mouse Control mod is active (lang-shim tracks active plugin
  // mods in localStorage._activePlugins). When active, taps already reach the
  // game as 'ok' so our fallback tap layer stays off; when inactive, the base
  // game's DisableMouse plugin kills clicks, so we supply tap-to-continue.
  function isMouseControlActive() {
    try {
      var raw = localStorage.getItem("_activePlugins");
      if (!raw) return false;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.indexOf("_mouseControl") >= 0;
    } catch (e) {
      return false;
    }
  }

  // DOM

  var STYLE = [
    "#vc-overlay{position:fixed;inset:0;z-index:100000;pointer-events:none;",
    "  font-family:Arial,Helvetica,sans-serif;user-select:none;",
    "  -webkit-user-select:none;touch-action:none;}",
    "#vc-overlay .vc-pad{position:absolute;bottom:max(18px,env(safe-area-inset-bottom));}",
    "#vc-overlay .vc-dpad{left:max(18px,env(safe-area-inset-left));",
    "  width:min(38vw,168px);height:min(38vw,168px);}",
    "#vc-overlay .vc-actions{right:max(18px,env(safe-area-inset-right));",
    "  width:min(38vw,168px);height:min(38vw,168px);}",
    "#vc-overlay .vc-btn{position:absolute;display:flex;align-items:center;",
    "  justify-content:center;box-sizing:border-box;pointer-events:auto;",
    "  cursor:pointer;color:#f4f4f4;background:rgba(20,20,26,0.42);",
    "  border:2px solid rgba(255,255,255,0.32);border-radius:14px;",
    "  font-size:clamp(18px,5vw,26px);line-height:1;font-weight:bold;",
    "  text-shadow:0 1px 2px rgba(0,0,0,0.8);",
    "  transition:background 0.05s,transform 0.05s;",
    "  -webkit-tap-highlight-color:transparent;}",
    "#vc-overlay .vc-btn.vc-active{background:rgba(120,160,255,0.62);",
    "  transform:scale(0.92);border-color:rgba(255,255,255,0.7);}",
    // D-pad: a 3x3 grid expressed with absolute spans.
    "#vc-overlay .vc-up{left:33.34%;top:0;width:33.33%;height:33.33%;",
    "  border-bottom-left-radius:4px;border-bottom-right-radius:4px;}",
    "#vc-overlay .vc-down{left:33.34%;bottom:0;width:33.33%;height:33.33%;",
    "  border-top-left-radius:4px;border-top-right-radius:4px;}",
    "#vc-overlay .vc-left{left:0;top:33.34%;width:33.33%;height:33.33%;",
    "  border-top-right-radius:4px;border-bottom-right-radius:4px;}",
    "#vc-overlay .vc-right{right:0;top:33.34%;width:33.33%;height:33.33%;",
    "  border-top-left-radius:4px;border-bottom-left-radius:4px;}",
    // Action cluster: diamond layout (A bottom, B right, X left, Y top).
    "#vc-overlay .vc-actions .vc-btn{width:38%;height:38%;border-radius:50%;}",
    "#vc-overlay .vc-y{left:31%;top:0;}",
    "#vc-overlay .vc-x{left:0;top:31%;}",
    "#vc-overlay .vc-b{right:0;top:31%;}",
    "#vc-overlay .vc-a{left:31%;bottom:0;}",
    "#vc-overlay .vc-a{color:#bfe9bf;}",
    "#vc-overlay .vc-b{color:#f0b9b9;}",
    "#vc-overlay .vc-x{color:#bcd2f5;}",
    "#vc-overlay .vc-y{color:#f0e3a8;}",
    // Top control row: quick-save + menu/escape, sitting above the action
    // cluster on the right (clear of the gap between the two clusters). The row
    // spans the action cluster's width and the two pills split it, so each is
    // narrower than the old single menu button.
    "#vc-overlay .vc-menubar{position:absolute;",
    "  right:max(18px,env(safe-area-inset-right));",
    "  bottom:calc(max(18px,env(safe-area-inset-bottom)) + min(38vw,168px) + 26px);",
    "  width:min(38vw,168px);display:flex;gap:8px;pointer-events:none;}",
    "#vc-overlay .vc-menubar .vc-btn{position:relative;flex:1 1 0;min-width:0;",
    "  height:clamp(30px,7vw,42px);border-radius:22px;",
    "  font-size:clamp(15px,4vw,22px);pointer-events:auto;}",
    "#vc-overlay .vc-menubar .vc-btn svg{width:1.45em;height:1.45em;display:block;}",
    // Quick-save cooldown: dim and ignore presses for the 1s debounce window
    // (lang-shim's window.__quickSave toggles .vc-cooldown on this button).
    "#vc-overlay .vc-save.vc-cooldown{opacity:0.4;pointer-events:none;}",
    // Fullscreen tap-to-continue layer, shown from JS only during cinematic
    // states with Mouse Control inactive. Transparent and pointer-events:auto
    // so it captures taps without altering the visible art.
    "#vc-overlay .vc-tap{position:absolute;inset:0;display:none;",
    "  pointer-events:auto;background:transparent;",
    "  -webkit-tap-highlight-color:transparent;}",
    // Cinematic state (dialogue / cutscene / CG): hide every control so the
    // art underneath is unobstructed.
    "#vc-overlay.vc-cinematic .vc-pad,",
    "#vc-overlay.vc-cinematic .vc-menubar{display:none;}",
  ].join("");

  // The layout's own rules, shared with plugins/VirtualController.js and so
  // written for Chromium 65 (see the header).
  var EDITOR_STYLE = [
    // Every cluster grows from the corner it is anchored to.
    "#vc-overlay .vc-dpad{-webkit-transform-origin:0 100%;transform-origin:0 100%;}",
    "#vc-overlay .vc-actions,#vc-overlay .vc-menubar{",
    "  -webkit-transform-origin:100% 100%;transform-origin:100% 100%;}",
    // Swapped: B at the bottom, A on the right.
    "#vc-overlay .vc-swapab .vc-a{left:auto;right:0;top:31%;bottom:auto;}",
    "#vc-overlay .vc-swapab .vc-b{right:auto;left:31%;top:auto;bottom:0;}",
    // The analog stick, in the arrows' place.
    "#vc-overlay .vc-stick-base{position:absolute;top:0;left:0;width:100%;",
    "  height:100%;box-sizing:border-box;border-radius:50%;pointer-events:auto;",
    "  background:rgba(20,20,26,0.42);border:2px solid rgba(255,255,255,0.32);",
    "  -webkit-tap-highlight-color:transparent;}",
    "#vc-overlay .vc-stick-knob{position:absolute;left:30%;top:30%;width:40%;",
    "  height:40%;box-sizing:border-box;border-radius:50%;pointer-events:none;",
    "  background:rgba(235,235,240,0.45);border:2px solid rgba(255,255,255,0.6);}",
    "#vc-overlay .vc-stick-base.vc-active{border-color:rgba(255,255,255,0.7);}",
    "#vc-overlay .vc-stick-base.vc-active .vc-stick-knob{",
    "  background:rgba(120,160,255,0.75);}",
    // Editing: a dim backdrop that keeps taps from the game, clusters that
    // drag as a whole, and the panel.
    "#vc-overlay .vc-editbg{position:absolute;top:0;left:0;right:0;bottom:0;",
    "  display:none;pointer-events:auto;background:rgba(0,0,0,0.5);}",
    "#vc-overlay.vc-editing .vc-editbg{display:block;}",
    "#vc-overlay.vc-editing .vc-pad,#vc-overlay.vc-editing .vc-menubar{",
    "  pointer-events:auto;cursor:move;outline:2px dashed rgba(255,255,255,0.7);",
    "  outline-offset:6px;}",
    "#vc-overlay.vc-editing .vc-btn,#vc-overlay.vc-editing .vc-stick-base{",
    "  pointer-events:none;}",
    "#vc-overlay .vc-panel{position:absolute;left:50%;top:10px;width:280px;",
    "  margin-left:-140px;max-height:92%;overflow-y:auto;box-sizing:border-box;",
    "  display:none;pointer-events:auto;touch-action:pan-y;padding:12px 14px;",
    "  border-radius:14px;background:rgba(16,16,22,0.94);color:#eee;",
    "  border:1px solid rgba(255,255,255,0.25);font-size:14px;line-height:1.3;}",
    "#vc-overlay.vc-editing .vc-panel{display:block;}",
    "#vc-overlay .vc-p-title{font-weight:bold;font-size:16px;}",
    "#vc-overlay .vc-p-hint{opacity:0.7;font-size:12px;margin:2px 0 6px;}",
    "#vc-overlay .vc-p-row{display:flex;align-items:center;margin:9px 0;}",
    "#vc-overlay .vc-p-label{flex:0 0 74px;}",
    "#vc-overlay .vc-p-row input{flex:1 1 auto;min-width:0;margin:0 8px 0 0;}",
    "#vc-overlay .vc-p-val{flex:0 0 42px;text-align:right;}",
    "#vc-overlay .vc-p-seg{display:flex;flex:1 1 auto;}",
    "#vc-overlay .vc-p-opt{flex:1 1 0;text-align:center;padding:7px 4px;",
    "  cursor:pointer;border:1px solid rgba(255,255,255,0.3);}",
    "#vc-overlay .vc-p-opt:first-child{border-radius:8px 0 0 8px;}",
    "#vc-overlay .vc-p-opt + .vc-p-opt{border-left:none;border-radius:0 8px 8px 0;}",
    "#vc-overlay .vc-p-opt.vc-on{background:rgba(120,160,255,0.55);}",
    "#vc-overlay .vc-p-foot{display:flex;margin-top:12px;}",
    "#vc-overlay .vc-p-btn{flex:1 1 0;text-align:center;padding:9px 4px;",
    "  cursor:pointer;border-radius:9px;background:rgba(255,255,255,0.12);",
    "  border:1px solid rgba(255,255,255,0.3);}",
    "#vc-overlay .vc-p-btn + .vc-p-btn{margin-left:10px;}",
    "#vc-overlay .vc-p-done{background:rgba(120,160,255,0.55);}",
  ].join("");

  // Classic floppy-disk "save" glyph as inline SVG (crisp + monochrome,
  // inheriting the button's text colour, unlike a coloured emoji).
  var SAVE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' +
    '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
    '<polyline points="17 21 17 13 7 13 7 21"/>' +
    '<polyline points="7 3 7 8 15 8"/></svg>';

  function bindButton(el, name) {
    function down(e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("vc-active");
      press(name);
      if (el.setPointerCapture && e.pointerId != null) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (ex) {}
      }
    }
    function up(e) {
      if (e) e.preventDefault();
      el.classList.remove("vc-active");
      release(name);
    }
    if (window.PointerEvent) {
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
    } else {
      el.addEventListener("touchstart", down, { passive: false });
      el.addEventListener("touchend", up);
      el.addEventListener("touchcancel", up);
      el.addEventListener("mousedown", down);
      el.addEventListener("mouseup", up);
      el.addEventListener("mouseleave", up);
    }
  }

  // Like bindButton, but for a one-shot action (fires once on release rather
  // than holding an Input key down). Used by the quick-save button.
  function bindTap(el, fn) {
    function down(e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("vc-active");
      if (el.setPointerCapture && e.pointerId != null) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (ex) {}
      }
    }
    function up(e) {
      if (e) e.preventDefault();
      var fired = el.classList.contains("vc-active");
      el.classList.remove("vc-active");
      if (fired) fn();
    }
    function cancel() {
      el.classList.remove("vc-active");
    }
    if (window.PointerEvent) {
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", cancel);
      el.addEventListener("lostpointercapture", cancel);
    } else {
      el.addEventListener("touchstart", down, { passive: false });
      el.addEventListener("touchend", up);
      el.addEventListener("touchcancel", cancel);
      el.addEventListener("mousedown", down);
      el.addEventListener("mouseup", up);
      el.addEventListener("mouseleave", cancel);
    }
  }

  function makeCluster(className, defs) {
    var pad = document.createElement("div");
    pad.className = "vc-pad " + className;
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      var btn = document.createElement("div");
      btn.className = "vc-btn " + def.cls;
      btn.textContent = def.glyph;
      bindButton(btn, def.name);
      pad.appendChild(btn);
    }
    return pad;
  }

  // Pointer tracking for the stick, the long press and the editor's drags:
  // pointer events where there are any, touch + mouse otherwise. `h.down`
  // returns false to leave the event alone (not captured, not stopped).
  function point(e) {
    var t = e.changedTouches && e.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX, y: e.clientY };
  }

  function track(el, h) {
    var active = false;
    function down(e) {
      if (active || h.down(e, point(e)) === false) return;
      e.preventDefault();
      e.stopPropagation();
      active = true;
      if (el.setPointerCapture && e.pointerId != null) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (ex) {}
      }
    }
    function move(e) {
      if (!active) return;
      e.preventDefault();
      if (h.move) h.move(e, point(e));
    }
    function end(cancelled) {
      return function (e) {
        if (!active) return;
        active = false;
        if (h.up) h.up(e, point(e), cancelled);
      };
    }
    if (window.PointerEvent) {
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end(false));
      el.addEventListener("pointercancel", end(true));
      el.addEventListener("lostpointercapture", end(true));
    } else {
      el.addEventListener("touchstart", down, { passive: false });
      el.addEventListener("touchmove", move, { passive: false });
      el.addEventListener("touchend", end(false));
      el.addEventListener("touchcancel", end(true));
      el.addEventListener("mousedown", down);
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end(false));
    }
  }

  // The menu button: a tap is 'escape' (held for a few frames, so the engine
  // sees it triggered), holding it opens the layout editor instead.
  function bindMenu(el) {
    var timer = null;
    track(el, {
      down: function () {
        if (editing) return false;
        el.classList.add("vc-active");
        timer = setTimeout(function () {
          timer = null;
          el.classList.remove("vc-active");
          if (navigator.vibrate) {
            try {
              navigator.vibrate(25);
            } catch (e) {}
          }
          openEditor();
        }, LONG_PRESS_MS);
      },
      up: function (e, p, cancelled) {
        el.classList.remove("vc-active");
        if (timer === null) return; // the long press already fired
        clearTimeout(timer);
        timer = null;
        if (cancelled) return;
        press(MENU.name);
        setTimeout(function () {
          release(MENU.name);
        }, 100);
      },
    });
  }

  // An analog stick in the arrows' place. The game still gets arrow keys:
  // the direction held is the dominant axis past the dead zone, and the
  // current axis is kept until the other one clearly leads, so a thumb
  // resting near a diagonal does not flicker between two arrows.
  function makeStick() {
    var pad = document.createElement("div");
    pad.className = "vc-pad vc-dpad vc-stick";
    var base = document.createElement("div");
    base.className = "vc-stick-base";
    var knob = document.createElement("div");
    knob.className = "vc-stick-knob";
    base.appendChild(knob);
    pad.appendChild(base);
    var dir = null;
    function hold(next) {
      if (next === dir) return;
      if (dir) release(dir);
      dir = next;
      if (dir) press(dir);
    }
    function update(p) {
      var r = base.getBoundingClientRect();
      var radius = r.width / 2;
      if (!radius) return;
      var dx = p.x - (r.left + radius);
      var dy = p.y - (r.top + radius);
      var d = Math.sqrt(dx * dx + dy * dy);
      var k = d > radius ? radius / d : 1;
      // The knob moves in the base's own pixels, before the layout's scale.
      var s = r.width / (base.offsetWidth || r.width);
      knob.style.transform =
        "translate(" + (dx * k) / s + "px," + (dy * k) / s + "px)";
      if (d < radius * STICK_DEAD) return hold(null);
      var ax = Math.abs(dx);
      var ay = Math.abs(dy);
      var horiz;
      if (dir === "left" || dir === "right") horiz = ay <= ax * 1.25;
      else if (dir === "up" || dir === "down") horiz = ax > ay * 1.25;
      else horiz = ax >= ay;
      hold(horiz ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down");
    }
    track(base, {
      down: function (e, p) {
        if (editing) return false;
        base.classList.add("vc-active");
        update(p);
      },
      move: function (e, p) {
        update(p);
      },
      up: function () {
        base.classList.remove("vc-active");
        knob.style.transform = "";
        hold(null);
      },
    });
    return pad;
  }

  // In the editor, a whole cluster drags. The offset is kept as a share of
  // the viewport and read back from what layout() applied, so it can never
  // be stored off screen.
  function bindDrag(key, el) {
    var from = null;
    track(el, {
      down: function (e, p) {
        if (!editing) return false;
        var cur = config.pos[key];
        from = {
          x: p.x,
          y: p.y,
          dx: cur.x * window.innerWidth,
          dy: cur.y * window.innerHeight,
        };
      },
      move: function (e, p) {
        config.pos[key] = {
          x: (from.dx + p.x - from.x) / window.innerWidth,
          y: (from.dy + p.y - from.y) / window.innerHeight,
        };
        layout();
        // What was drawn, so a drag past the edge is not stored past it.
        if (applied[key]) config.pos[key] = applied[key];
      },
      up: function () {
        saveConfig();
      },
    });
  }

  // Where every cluster is drawn: its CSS anchor, scaled from its corner,
  // moved by the stored offset, and clamped so all of it stays on screen.
  // The stored offset itself is left alone (a rotation to a smaller screen
  // must not lose it); `applied` is what was drawn.
  var applied = {};
  function layout() {
    if (!ui) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var s = config.scale;
    CLUSTERS.forEach(function (key) {
      var el = key === "dpad" ? (config.stick ? ui.stick : ui.dpad) : ui[key];
      var W = el.offsetWidth;
      var H = el.offsetHeight;
      if (!W || !H) return; // hidden (a cinematic): laid out when it shows
      var fromRight = key !== "dpad";
      var left = el.offsetLeft + (fromRight ? W * (1 - s) : 0);
      var top = el.offsetTop + H * (1 - s);
      // The menu row sits above the actions: it follows their growth.
      var lift = key === "menubar" ? -ui.actions.offsetHeight * (s - 1) : 0;
      var pos = config.pos[key];
      var dx = Math.min(vw - (left + W * s), Math.max(-left, pos.x * vw));
      var dy = Math.min(
        vh - (el.offsetTop + H + lift),
        Math.max(-(top + lift), pos.y * vh)
      );
      applied[key] = { x: dx / vw, y: dy / vh };
      var t =
        "translate(" + dx + "px," + (dy + lift) + "px) scale(" + s + ")";
      el.style.webkitTransform = t;
      el.style.transform = t;
      el.style.opacity = String(config.opacity);
    });
  }

  // Everything the layout decides that is not a position.
  function applyConfig() {
    if (!ui) return;
    ui.dpad.style.display = config.stick ? "none" : "";
    ui.stick.style.display = config.stick ? "" : "none";
    ui.actions.classList.toggle("vc-swapab", config.swapAB);
    releaseAll();
    layout();
    paintPanel();
  }

  function makePanel() {
    var panel = document.createElement("div");
    panel.className = "vc-panel";
    panel.innerHTML =
      '<div class="vc-p-title">Controller layout</div>' +
      '<div class="vc-p-hint">Drag the controls to move them.</div>' +
      '<div class="vc-p-row"><span class="vc-p-label">Size</span>' +
      '<input type="range" min="50" max="160" step="5" data-k="scale">' +
      '<span class="vc-p-val" data-v="scale"></span></div>' +
      '<div class="vc-p-row"><span class="vc-p-label">Opacity</span>' +
      '<input type="range" min="20" max="100" step="5" data-k="opacity">' +
      '<span class="vc-p-val" data-v="opacity"></span></div>' +
      '<div class="vc-p-row"><span class="vc-p-label">Arrows</span>' +
      '<div class="vc-p-seg">' +
      '<div class="vc-p-opt" data-k="stick" data-o="0">Buttons</div>' +
      '<div class="vc-p-opt" data-k="stick" data-o="1">Stick</div></div></div>' +
      '<div class="vc-p-row"><span class="vc-p-label">Confirm</span>' +
      '<div class="vc-p-seg">' +
      '<div class="vc-p-opt" data-k="swapAB" data-o="0">A bottom</div>' +
      '<div class="vc-p-opt" data-k="swapAB" data-o="1">A right</div></div></div>' +
      '<div class="vc-p-foot">' +
      '<div class="vc-p-btn vc-p-reset">Reset</div>' +
      '<div class="vc-p-btn vc-p-done">Done</div></div>';
    var ranges = panel.querySelectorAll("input[type=range]");
    Array.prototype.forEach.call(ranges, function (input) {
      input.addEventListener("input", function () {
        config[input.getAttribute("data-k")] = Number(input.value) / 100;
        layout();
        paintPanel();
      });
      input.addEventListener("change", saveConfig);
    });
    var opts = panel.querySelectorAll(".vc-p-opt");
    Array.prototype.forEach.call(opts, function (opt) {
      opt.addEventListener("click", function () {
        config[opt.getAttribute("data-k")] = opt.getAttribute("data-o") === "1";
        applyConfig();
        saveConfig();
      });
    });
    panel.querySelector(".vc-p-reset").addEventListener("click", function () {
      config = defaultConfig();
      applyConfig();
      saveConfig();
    });
    panel.querySelector(".vc-p-done").addEventListener("click", closeEditor);
    return panel;
  }

  function paintPanel() {
    if (!ui) return;
    var panel = ui.panel;
    ["scale", "opacity"].forEach(function (k) {
      var pct = Math.round(config[k] * 100);
      panel.querySelector('input[data-k="' + k + '"]').value = String(pct);
      panel.querySelector('[data-v="' + k + '"]').textContent = pct + "%";
    });
    var opts = panel.querySelectorAll(".vc-p-opt");
    Array.prototype.forEach.call(opts, function (opt) {
      var on = !!config[opt.getAttribute("data-k")] === (opt.getAttribute("data-o") === "1");
      opt.classList.toggle("vc-on", on);
    });
  }

  function openEditor() {
    if (!ui || editing) return;
    editing = true;
    releaseAll();
    ui.overlay.classList.remove("vc-cinematic");
    ui.tapLayer.style.display = "none";
    ui.overlay.classList.add("vc-editing");
    applyConfig();
  }

  function closeEditor() {
    if (!editing) return;
    editing = false;
    ui.overlay.classList.remove("vc-editing");
    // A slider keeps the focus, and with it the arrow keys the game reads.
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    saveConfig();
    layout();
  }

  function build() {
    if (document.getElementById("vc-overlay")) return;

    var style = document.createElement("style");
    style.id = "vc-style";
    style.textContent = STYLE + EDITOR_STYLE;
    document.head.appendChild(style);

    var overlay = document.createElement("div");
    overlay.id = "vc-overlay";

    // First, so every control paints above it.
    var editBg = document.createElement("div");
    editBg.className = "vc-editbg";
    overlay.appendChild(editBg);

    var dpad = makeCluster("vc-dpad", DPAD);
    var stick = makeStick();
    var actions = makeCluster("vc-actions", ACTIONS);
    overlay.appendChild(dpad);
    overlay.appendChild(stick);
    overlay.appendChild(actions);

    // Top row above the action cluster: quick-save (one-shot) + menu/escape.
    var menubar = document.createElement("div");
    menubar.className = "vc-menubar";

    var saveBtn = document.createElement("div");
    saveBtn.className = "vc-btn vc-save";
    saveBtn.innerHTML = SAVE_SVG;
    bindTap(saveBtn, quickSave);
    menubar.appendChild(saveBtn);

    var menuBtn = document.createElement("div");
    menuBtn.className = "vc-btn " + MENU.cls;
    menuBtn.textContent = MENU.glyph;
    bindMenu(menuBtn);
    menubar.appendChild(menuBtn);

    overlay.appendChild(menubar);

    // Fullscreen tap-to-continue layer for cinematic states. Hidden by
    // default; the watch loop below shows it only while a dialogue/cutscene is
    // up AND Mouse Control is inactive. A tap holds 'ok' (like the A button),
    // so text advances and CG prompts proceed. Its events bubble to the
    // overlay's swallow handlers below, so they don't leak to the game.
    var tapLayer = document.createElement("div");
    tapLayer.className = "vc-tap";
    bindButton(tapLayer, "ok");
    overlay.appendChild(tapLayer);

    var panel = makePanel();
    overlay.appendChild(panel);

    ui = {
      overlay: overlay,
      dpad: dpad,
      stick: stick,
      actions: actions,
      menubar: menubar,
      tapLayer: tapLayer,
      panel: panel,
    };
    bindDrag("dpad", dpad);
    bindDrag("dpad", stick);
    bindDrag("actions", actions);
    bindDrag("menubar", menubar);

    // Stop button input from reaching the game underneath. The engine's
    // TouchInput listeners (and the Mouse Control mod, which rides on the same
    // TouchInput state) are all bubble-phase on `document`. The buttons stop
    // their own pointer events, but a touch/click on a button also fires
    // *compatibility* mouse/touch events that the buttons don't bind, so they
    // bubble to document and the game reads them as a tap on the map/menu:
    // moving the character to the spot under the button, or counting it as a
    // "tap outside the menu" and closing it. Swallowing those events here at
    // the overlay (an ancestor of every button, so it sees them during bubble,
    // after the buttons' own handlers have run) blocks them without breaking
    // the buttons, independent of plugin load order. The overlay container is
    // pointer-events:none, so only button-originated events bubble through it.
    function swallow(e) {
      e.stopPropagation();
    }
    function swallowPassive(e) {
      // touchstart/touchmove additionally need preventDefault to suppress the
      // synthesised mouse events and any page scrolling/zoom. Not inside the
      // editor's panel: its sliders and its scrolling are default actions.
      if (!panel.contains(e.target)) e.preventDefault();
      e.stopPropagation();
    }
    [
      "mousedown",
      "mouseup",
      "mousemove",
      "click",
      "dblclick",
      "contextmenu",
      "pointerdown",
      "pointerup",
      "pointermove",
      "touchend",
      "touchcancel",
      "wheel",
    ].forEach(function (type) {
      overlay.addEventListener(type, swallow, false);
    });
    ["touchstart", "touchmove"].forEach(function (type) {
      overlay.addEventListener(type, swallowPassive, { passive: false });
    });

    document.body.appendChild(overlay);
    applyConfig();

    // A rotation or a resized window: the same layout, re-clamped to the new
    // viewport. Measured on the next frame, once the anchors have moved.
    function relayout() {
      requestAnimationFrame(layout);
    }
    window.addEventListener("resize", relayout);
    window.addEventListener("orientationchange", relayout);

    // Safety: drop any held buttons when focus is lost or the page is hidden,
    // mirroring the engine's own Input.clear() on blur so a button can never
    // stay logically pressed after the pointer is gone.
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) releaseAll();
    });

    // Watch for cinematic states (dialogue / cutscene / CG) and hide the whole
    // controller while one is up, dropping any held buttons so the character
    // doesn't keep walking into it. The tap-to-continue layer is enabled only
    // when Mouse Control is inactive (checked at each entry, so a live toggle
    // is respected on the next cinematic). Never while the editor is open: it
    // shows every control.
    var lastCinematic = false;
    (function watch() {
      var cine = !editing && isCinematic();
      if (cine !== lastCinematic) {
        lastCinematic = cine;
        overlay.classList.toggle("vc-cinematic", cine);
        if (cine) {
          releaseAll();
          tapLayer.style.display = isMouseControlActive() ? "none" : "block";
        } else {
          tapLayer.style.display = "none";
          layout();
        }
      }
      requestAnimationFrame(watch);
    })();

    window.VirtualController = {
      openEditor: openEditor,
      closeEditor: closeEditor,
      config: function () {
        return JSON.parse(JSON.stringify(config));
      },
    };
  }

  if (document.body) {
    build();
  } else {
    document.addEventListener("DOMContentLoaded", build);
  }
})();

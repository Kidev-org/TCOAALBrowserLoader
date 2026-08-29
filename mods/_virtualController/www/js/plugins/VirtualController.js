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
 *            The menu button opens the game menu.
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

  function build() {
    if (document.getElementById("vc-overlay")) return;

    var style = document.createElement("style");
    style.id = "vc-style";
    style.textContent = STYLE;
    document.head.appendChild(style);

    var overlay = document.createElement("div");
    overlay.id = "vc-overlay";
    overlay.appendChild(makeCluster("vc-dpad", DPAD));
    overlay.appendChild(makeCluster("vc-actions", ACTIONS));

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
    bindButton(menuBtn, MENU.name);
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
      // synthesised mouse events and any page scrolling/zoom.
      e.preventDefault();
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
    // is respected on the next cinematic).
    var lastCinematic = false;
    (function watch() {
      var cine = isCinematic();
      if (cine !== lastCinematic) {
        lastCinematic = cine;
        overlay.classList.toggle("vc-cinematic", cine);
        if (cine) {
          releaseAll();
          tapLayer.style.display = isMouseControlActive() ? "none" : "block";
        } else {
          tapLayer.style.display = "none";
        }
      }
      requestAnimationFrame(watch);
    })();
  }

  if (document.body) {
    build();
  } else {
    document.addEventListener("DOMContentLoaded", build);
  }
})();

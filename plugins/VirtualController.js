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
 * @plugindesc On-screen touch controller: d-pad, A/B/X/Y, menu and quick-save buttons (TCOAAL).
 * @author kidev
 *
 * @help
 * Standalone build of the Browser Player's Virtual Controller mod. Feeds
 * Input._currentState so the engine derives press/trigger/repeat itself.
 * Hidden during dialogue and cutscenes. The quick-save button appears only
 * when ImprovedLoader.js is installed (it provides the quick save).
 *
 * Install: copy to www/js/plugins/ and add
 *   {"name":"VirtualController","status":true,"description":"","parameters":{}}
 * to www/js/plugins.js AFTER the AudioStreaming entry (and after
 * MouseControl and ImprovedLoader when those are used).
 */
/*
 * Controls feed Input._currentState[<button>] rather than synthesising key
 * events, so the engine's own Input.update() derives triggered / repeated /
 * pressed exactly as it does for the keyboard: key-repeat in menus,
 * continuous movement on the map and hold semantics all come for free.
 *
 * Button -> logical name (Input.keyMapper / gamepadMapper):
 *   A -> 'ok'   B -> 'cancel'   X -> 'shift' (dash)   Y -> 'control'
 *   Menu -> 'escape', which is escape-compatible and so satisfies both
 *   Input.isTriggered('menu') and isTriggered('cancel').
 *
 * During a dialogue or cutscene every control hides so it never covers the
 * art, and a fullscreen tap layer presses 'ok' instead - but only when
 * MouseControl.js is absent. The base game's DisableMouse plugin neuters
 * clicks, so without Mouse Control nothing else would advance the text; with
 * it, taps already reach the game and the layer would double them.
 */

(function () {
  "use strict";

  // A plugin listed twice, or a loader that re-runs plugin scripts.
  if (window.__virtualControllerLoaded) return;
  window.__virtualControllerLoaded = true;

  if (typeof Input === "undefined") return;

  var DPAD = [
    { name: "up", glyph: "\u25b2", cls: "vc-up" },
    { name: "left", glyph: "\u25c0", cls: "vc-left" },
    { name: "right", glyph: "\u25b6", cls: "vc-right" },
    { name: "down", glyph: "\u25bc", cls: "vc-down" },
  ];

  var ACTIONS = [
    { name: "control", glyph: "Y", cls: "vc-y" },
    { name: "shift", glyph: "X", cls: "vc-x" },
    { name: "ok", glyph: "A", cls: "vc-a" },
    { name: "cancel", glyph: "B", cls: "vc-b" },
  ];

  var MENU = { name: "escape", glyph: "\u2630", cls: "vc-menu" };

  // What the overlay is holding, so a button cannot stay logically pressed
  // after the engine's Input.clear() wipes the state on window blur.
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

  // ImprovedLoader.js owns the quick save (the cooldown, the toast, the 'M'
  // key); this button only forwards, and is built only when it is there.
  function hasQuickSave() {
    return typeof window.__quickSave === "function";
  }
  function quickSave() {
    if (hasQuickSave()) window.__quickSave();
  }

  // Scoped to Scene_Map on purpose: menus, the title screen and battles
  // still need the on-screen controller.
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

  // MouseControl.js sets Imported.MouseControl at load.
  function isMouseControlActive() {
    return !!(window.Imported && window.Imported.MouseControl);
  }

  window.VirtualController = {
    isMouseControlActive: isMouseControlActive,
    hasQuickSave: hasQuickSave,
    get STYLE() {
      return STYLE;
    },
  };

  // The game runs on NW.js 0.29 (Chromium 65): no `inset`, `min()`, `max()`,
  // `clamp()`, `env()` or flex `gap`; a declaration using one is dropped
  // whole, so every size below is a plain value with media queries standing
  // in for the clamps (pads: 168px, or 38vw under 443px of width).
  var STYLE = [
    "#vc-overlay{position:fixed;top:0;left:0;right:0;bottom:0;",
    "  z-index:100000;pointer-events:none;",
    "  font-family:Arial,Helvetica,sans-serif;user-select:none;",
    "  -webkit-user-select:none;touch-action:none;}",
    "#vc-overlay .vc-pad{position:absolute;bottom:18px;}",
    "#vc-overlay .vc-dpad{left:18px;width:168px;height:168px;}",
    "#vc-overlay .vc-actions{right:18px;width:168px;height:168px;}",
    "#vc-overlay .vc-btn{position:absolute;display:flex;align-items:center;",
    "  justify-content:center;box-sizing:border-box;pointer-events:auto;",
    "  cursor:pointer;color:#f4f4f4;background:rgba(20,20,26,0.42);",
    "  border:2px solid rgba(255,255,255,0.32);border-radius:14px;",
    "  font-size:26px;line-height:1;font-weight:bold;",
    "  text-shadow:0 1px 2px rgba(0,0,0,0.8);",
    "  transition:background 0.05s,transform 0.05s;",
    "  -webkit-tap-highlight-color:transparent;}",
    "#vc-overlay .vc-btn.vc-active{background:rgba(120,160,255,0.62);",
    "  transform:scale(0.92);border-color:rgba(255,255,255,0.7);}",
    "#vc-overlay .vc-up{left:33.34%;top:0;width:33.33%;height:33.33%;",
    "  border-bottom-left-radius:4px;border-bottom-right-radius:4px;}",
    "#vc-overlay .vc-down{left:33.34%;bottom:0;width:33.33%;height:33.33%;",
    "  border-top-left-radius:4px;border-top-right-radius:4px;}",
    "#vc-overlay .vc-left{left:0;top:33.34%;width:33.33%;height:33.33%;",
    "  border-top-right-radius:4px;border-bottom-right-radius:4px;}",
    "#vc-overlay .vc-right{right:0;top:33.34%;width:33.33%;height:33.33%;",
    "  border-top-left-radius:4px;border-bottom-left-radius:4px;}",
    "#vc-overlay .vc-actions .vc-btn{width:38%;height:38%;border-radius:50%;}",
    "#vc-overlay .vc-y{left:31%;top:0;}",
    "#vc-overlay .vc-x{left:0;top:31%;}",
    "#vc-overlay .vc-b{right:0;top:31%;}",
    "#vc-overlay .vc-a{left:31%;bottom:0;}",
    "#vc-overlay .vc-a{color:#bfe9bf;}",
    "#vc-overlay .vc-b{color:#f0b9b9;}",
    "#vc-overlay .vc-x{color:#bcd2f5;}",
    "#vc-overlay .vc-y{color:#f0e3a8;}",
    // bottom = 18px pad margin + pad height + 26px.
    "#vc-overlay .vc-menubar{position:absolute;right:18px;bottom:212px;",
    "  width:168px;display:flex;pointer-events:none;}",
    "#vc-overlay .vc-menubar .vc-btn{position:relative;flex:1 1 0;min-width:0;",
    "  height:42px;border-radius:22px;",
    "  font-size:22px;pointer-events:auto;}",
    "#vc-overlay .vc-menubar .vc-btn + .vc-btn{margin-left:8px;}",
    "#vc-overlay .vc-menubar .vc-btn svg{width:1.45em;height:1.45em;display:block;}",
    // window.__quickSave toggles .vc-cooldown for its debounce window.
    "#vc-overlay .vc-save.vc-cooldown{opacity:0.4;pointer-events:none;}",
    "#vc-overlay .vc-tap{position:absolute;top:0;left:0;right:0;bottom:0;",
    "  display:none;pointer-events:auto;background:transparent;",
    "  -webkit-tap-highlight-color:transparent;}",
    "#vc-overlay.vc-cinematic .vc-pad,",
    "#vc-overlay.vc-cinematic .vc-menubar{display:none;}",
    // The viewport-relative halves of the clamps. Each query only lowers what
    // the one before it set, so order matters.
    "@media (max-width:599px){#vc-overlay .vc-menubar .vc-btn{height:7vw;}}",
    "@media (max-width:549px){#vc-overlay .vc-menubar .vc-btn{font-size:4vw;}}",
    "@media (max-width:519px){#vc-overlay .vc-btn{font-size:5vw;}}",
    "@media (max-width:442px){",
    "  #vc-overlay .vc-dpad,#vc-overlay .vc-actions{width:38vw;height:38vw;}",
    "  #vc-overlay .vc-menubar{width:38vw;bottom:calc(44px + 38vw);}}",
    "@media (max-width:428px){#vc-overlay .vc-menubar .vc-btn{height:30px;}}",
    "@media (max-width:374px){#vc-overlay .vc-menubar .vc-btn{font-size:15px;}}",
    "@media (max-width:359px){#vc-overlay .vc-btn{font-size:18px;}}",
  ].join("");

  // Inline SVG, not an emoji: it inherits the button's text colour.
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

  // One-shot: fires on release instead of holding an Input key down.
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

    var menubar = document.createElement("div");
    menubar.className = "vc-menubar";

    if (hasQuickSave()) {
      var saveBtn = document.createElement("div");
      saveBtn.className = "vc-btn vc-save";
      saveBtn.innerHTML = SAVE_SVG;
      bindTap(saveBtn, quickSave);
      menubar.appendChild(saveBtn);
    }

    var menuBtn = document.createElement("div");
    menuBtn.className = "vc-btn " + MENU.cls;
    menuBtn.textContent = MENU.glyph;
    bindButton(menuBtn, MENU.name);
    menubar.appendChild(menuBtn);

    overlay.appendChild(menubar);

    // Shown by the watch loop below, never by default.
    var tapLayer = document.createElement("div");
    tapLayer.className = "vc-tap";
    bindButton(tapLayer, "ok");
    overlay.appendChild(tapLayer);

    // The engine's TouchInput listeners (and Mouse Control, which rides on
    // the same state) are all bubble-phase on `document`. A touch or click on
    // a button also fires COMPATIBILITY mouse/touch events the buttons never
    // bind, and those reach document: the game then reads a tap on the map
    // under the button, or a "tap outside the menu" that closes it. Swallowing
    // them at the overlay - an ancestor, so it runs after the buttons' own
    // handlers - blocks them regardless of plugin load order. The container is
    // pointer-events:none, so only button-originated events get this far.
    function swallow(e) {
      e.stopPropagation();
    }
    function swallowPassive(e) {
      // preventDefault as well, to suppress the synthesised mouse events and
      // any page scroll or zoom.
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

    // Mirror the engine's own Input.clear() on blur, so a button cannot stay
    // logically pressed after the pointer is gone.
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) releaseAll();
    });

    // Held buttons are dropped on entry so the character does not keep
    // walking, and Mouse Control is re-checked each time so a live toggle is
    // respected on the next cinematic.
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

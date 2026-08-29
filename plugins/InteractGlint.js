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
 * @plugindesc Periodic glint on every interactable on the map (TCOAAL).
 * @author kidev
 *
 * @help
 * Standalone build of the Browser Player's Interact Glint mod. Marks every
 * event whose active page runs on the Action Button with a small periodic
 * glint, the way the old Resident Evil games hinted at items. Follows the
 * game's "UI Hints" option.
 *
 * Install: copy to www/js/plugins/ and add
 *   {"name":"InteractGlint","status":true,"description":"","parameters":{}}
 * to www/js/plugins.js AFTER the AudioStreaming entry.
 */
/*
 * What counts as interactable is what the game's own interact balloon
 * (Hint.process in the DRM payload) opens on: an Action Button page whose
 * payload-defined isEnabled() passes - the "enabled: <switch|var|item> ..."
 * comment on the page's first line, which is how the story retires an object
 * once it has been used. Player Touch events (room exits) are left alone.
 *
 * Most interactables are events with NO graphic, placed over the parallax
 * art, so there is no sprite to brighten and the glint is a sprite of its
 * own. The layer is a child of the tilemap, so scrolling and
 * SRD_CameraCore's zoom apply to it for free.
 *
 * The pure parts are exposed on the InteractGlint namespace for tools/test.js.
 */

(function () {
  "use strict";

  if (typeof Game_Event === "undefined" || typeof Spriteset_Map === "undefined")
    return;

  var PERIOD = 3.2; // seconds between two twinkles of one event
  var TWINKLE = 0.7; // seconds one twinkle lasts, at the end of the period
  var PEAK_ALPHA = 0.5;
  var PEAK_SCALE = 1.25;
  var SIZE = 32; // glint bitmap side, px
  // Characters end at z 5 and the stock engine tops out at 9, but
  // OrangeOverlay parks its depth-illusion parallax at 20 (shadow 21, fog 22,
  // light 23), and a glint under that draws behind the furniture it marks.
  // The game lifts its own balloons and animations to 30; sit with them.
  var LAYER_Z = 30;

  // Hint's isEnabled() checks this before its comment rule, and it is the
  // whole rule when the payload is absent.
  function pageHasCommands(event) {
    var data = event.event && event.event();
    var page = data && data.pages && data.pages[event._pageIndex];
    if (!page || !page.list) return false;
    var list = page.list;
    if (list.length < 1) return false;
    if (list.length === 1 && list[0].code === 0) return false;
    return true;
  }

  function isEnabled(event) {
    if (typeof event.isEnabled === "function") return !!event.isEnabled();
    return pageHasCommands(event);
  }

  function qualifies(event) {
    if (!event || typeof event.isTriggerIn !== "function") return false;
    if (!event.isTriggerIn([0])) return false;
    if (typeof event.isTransparent === "function" && event.isTransparent())
      return false;
    return isEnabled(event);
  }

  // Weyl sequence (golden ratio), so neighbouring ids land far apart and a
  // room full of objects does not blink in lockstep.
  function phaseFor(id) {
    var p = (id * 0.6180339887498949) % 1;
    return p < 0 ? p + 1 : p;
  }

  // The twinkle occupies the last TWINKLE seconds of every PERIOD; a
  // half-sine gives a soft in and out.
  function envelope(t, phase) {
    var local = (t - (phase || 0) * PERIOD) % PERIOD;
    if (local < 0) local += PERIOD;
    var start = PERIOD - TWINKLE;
    if (local < start) return { alpha: 0, scale: 1, rotation: 0 };
    var u = (local - start) / TWINKLE; // 0..1 across the twinkle
    var k = Math.sin(u * Math.PI); // 0 -> 1 -> 0
    return {
      alpha: PEAK_ALPHA * k,
      scale: 1 + (PEAK_SCALE - 1) * k,
      rotation: u * (Math.PI / 2),
    };
  }

  // Tile-space center of the event's OrangeEventHitboxes box, or of its tile.
  function anchorFor(event) {
    var x = event._x;
    var y = event._y;
    var hx = typeof event.hitboxX === "number" ? event.hitboxX : 0;
    var hy = typeof event.hitboxY === "number" ? event.hitboxY : 0;
    var hw = typeof event.hitboxWidth === "number" ? event.hitboxWidth : 1;
    var hh = typeof event.hitboxHeight === "number" ? event.hitboxHeight : 1;
    return { x: x + hx + hw / 2, y: y + hy + hh / 2 };
  }

  function shouldShow(state) {
    if (!state.inputHint) return false;
    if (state.eventRunning) return false;
    if (state.messageBusy) return false;
    return true;
  }

  // A radial glow and a thin four-point star, for additive blending at low
  // alpha.
  var _bitmap = null;

  function glintBitmap() {
    if (_bitmap) return _bitmap;
    var bmp = new Bitmap(SIZE, SIZE);
    var ctx = bmp.context || bmp._context;
    if (ctx) {
      var c = SIZE / 2;
      var glow = ctx.createRadialGradient(c, c, 0, c, c, c);
      glow.addColorStop(0, "rgba(255, 244, 214, 0.9)");
      glow.addColorStop(0.35, "rgba(255, 236, 190, 0.35)");
      glow.addColorStop(1, "rgba(255, 230, 170, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Two thin diamonds, one per axis.
      var arm = c - 1;
      var half = 1.2;
      ctx.fillStyle = "rgba(255, 250, 235, 0.95)";
      ctx.beginPath();
      ctx.moveTo(c, c - arm);
      ctx.lineTo(c + half, c);
      ctx.lineTo(c, c + arm);
      ctx.lineTo(c - half, c);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(c - arm, c);
      ctx.lineTo(c, c - half);
      ctx.lineTo(c + arm, c);
      ctx.lineTo(c, c + half);
      ctx.closePath();
      ctx.fill();
    }
    if (typeof bmp._setDirty === "function") bmp._setDirty();
    _bitmap = bmp;
    return bmp;
  }

  // One glint sprite per qualifying event, pooled by event id.
  function Sprite_GlintLayer() {
    this.initialize.apply(this, arguments);
  }
  Sprite_GlintLayer.prototype = Object.create(Sprite.prototype);
  Sprite_GlintLayer.prototype.constructor = Sprite_GlintLayer;

  Sprite_GlintLayer.prototype.initialize = function () {
    Sprite.prototype.initialize.call(this);
    this.z = LAYER_Z;
    this._glints = {}; // eventId -> Sprite
    this._time = 0;
  };

  Sprite_GlintLayer.prototype.update = function () {
    Sprite.prototype.update.call(this);
    var dt =
      typeof SceneManager !== "undefined" && SceneManager._deltaTime > 0
        ? SceneManager._deltaTime
        : 1 / 60;
    this._time += dt;

    var show = shouldShow({
      inputHint: !!(
        typeof ConfigManager !== "undefined" && ConfigManager.inputHint
      ),
      eventRunning: !!($gameMap && $gameMap.isEventRunning()),
      messageBusy: !!($gameMessage && $gameMessage.isBusy()),
    });
    this.visible = show;
    if (!show) return;

    var tw = $gameMap.tileWidth();
    var th = $gameMap.tileHeight();
    var alive = {};
    var events = $gameMap.events();
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!qualifies(ev)) continue;
      var id = ev._eventId;
      alive[id] = true;
      var sprite = this._glints[id];
      if (!sprite) {
        sprite = new Sprite(glintBitmap());
        sprite.anchor.x = 0.5;
        sprite.anchor.y = 0.5;
        sprite.blendMode = PIXI.BLEND_MODES.ADD;
        sprite.alpha = 0;
        this._glints[id] = sprite;
        this.addChild(sprite);
      }
      var a = anchorFor(ev);
      sprite.x = Math.round($gameMap.adjustX(a.x) * tw);
      sprite.y = Math.round($gameMap.adjustY(a.y) * th);
      var e = envelope(this._time, phaseFor(id));
      sprite.alpha = e.alpha;
      sprite.scale.x = e.scale;
      sprite.scale.y = e.scale;
      sprite.rotation = e.rotation;
    }
    for (var key in this._glints) {
      if (!alive[key]) {
        this.removeChild(this._glints[key]);
        delete this._glints[key];
      }
    }
  };

  var _createCharacters = Spriteset_Map.prototype.createCharacters;
  Spriteset_Map.prototype.createCharacters = function () {
    _createCharacters.call(this);
    this._glintLayer = new Sprite_GlintLayer();
    this._tilemap.addChild(this._glintLayer);
  };

  // Tilemap.update() drives the layer: nothing else needs hooking.

  var ns = {
    PERIOD: PERIOD,
    TWINKLE: TWINKLE,
    PEAK_ALPHA: PEAK_ALPHA,
    qualifies: qualifies,
    phaseFor: phaseFor,
    envelope: envelope,
    anchorFor: anchorFor,
    shouldShow: shouldShow,
    Sprite_GlintLayer: Sprite_GlintLayer,
  };
  if (typeof window !== "undefined") window.InteractGlint = ns;
  else if (typeof globalThis !== "undefined") globalThis.InteractGlint = ns;
})();

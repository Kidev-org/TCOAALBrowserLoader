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
 * @plugindesc Centered camera, cross-faded door transfers and next-room previews (TCOAAL).
 * @author kidev
 *
 * @help
 * Standalone build of the Browser Player's Seamless Maps mod. Keeps the
 * player centered, cross-dissolves ordinary door transfers instead of
 * fading to black, and fades the neighbouring room's art into the void past
 * a map edge as you approach its door. Cross-boundary click-to-move needs
 * MouseControl.js.
 *
 * Install: copy to www/js/plugins/ and add
 *   {"name":"SeamlessMaps","status":true,"description":"","parameters":{}}
 * to www/js/plugins.js AFTER the AudioStreaming entry.
 */
/*
 * TCOAAL is built from many small maps wired together with Transfer Player
 * events, and RPG Maker has no global layout, so two maps can never be
 * stitched together permanently with correct geometry. At a transfer, though,
 * the destination IS the real next room: snapshot the room being left, build
 * the new centered map underneath, and cross-dissolve the snapshot away.
 *
 * The approach preview fetches the neighbour's own <ground>/<par> parallax
 * art (through the game's redirect + decrypt, see loadMapJson; cached once per
 * session) plus its events at their current graphic, and composites ground ->
 * events -> par into ONE bitmap faded as ONE sprite: fading the layers
 * separately superposes their alphas over the void and ghosts. It sits behind
 * the current map's ground layer, so it shows only through the void at an
 * edge and a door in the middle of a room reveals nothing.
 *
 * Fades: ordinary "normal" (black, fadeType 0) transfers get the crossfade.
 * Some doors bake their own Fadeout/Fadein around the transfer, and those are
 * classified by what sits between the fade-out and the transfer - a "plain"
 * door (no scripted motion, animation or pictures) has its manual fade skipped
 * and crossfades too, while a "scripted" one is left exactly as authored and
 * the crossfade stands down rather than fight it. White fades (fadeType 1) and
 * bare instant swaps are left alone, and the centering steps aside while a
 * scripted Scroll Map runs.
 *
 * Everything here is an additive prototype override; no engine file changes.
 */

(function () {
  "use strict";

  if (
    typeof Game_Player === "undefined" ||
    typeof Game_Map === "undefined" ||
    typeof Scene_Map === "undefined" ||
    typeof Graphics === "undefined"
  ) {
    return;
  }

  // Tunables

  // Tiles the camera may drift past a map edge. Larger keeps the player more
  // perfectly centered but shows more void around small rooms.
  var OVERSCROLL_MARGIN = 4.0;

  // Frames (60 fps), matched to the engine's stock fade so pacing is unchanged.
  var TRANSITION_FRAMES = 30;

  // 0 is the black fade ordinary doors use. 1 (white) and 2 (none) are left
  // alone on purpose.
  var HANDLED_FADE_TYPES = [0];

  var RECOVER_FRAMES = 18;

  var DEBUG = false;
  function dbg() {
    if (DEBUG && typeof console !== "undefined") {
      console.log.apply(
        console,
        ["[SeamlessMaps]"].concat([].slice.call(arguments)),
      );
    }
  }

  var PREVIEW_RANGE = 2.0;

  var PREVIEW_FADE = 0.22;

  // The engine clears the walk destination on every frame the map-touch is
  // not OK (the transfer settle), so one setDestination is lost. Re-assert the
  // carried click until the player moves or this window expires.
  var CROSS_RESUME_FRAMES = 60;

  // A self-walked transfer is one where the player was moving under their own
  // control (not a forced route) this recently. The stamp is refreshed every
  // self-moving frame, so this only has to absorb the player-touch trigger and
  // the scene-stop settle.
  var WALK_THROUGH_GRACE = 20;

  // Carries the snapshot + direction across the teardown/rebuild a transfer
  // performs (old Scene_Map.stop -> new Scene_Map.start).
  var SM = {
    pending: false, // a handled transfer is in flight; suppress engine fades
    snap: null, // Bitmap of the room being left
    seamScreenX: 0, // player's on-screen tile position in the outgoing frame
    seamScreenY: 0, // (so the incoming frame can start matching it exactly)
    camOffX: 0, // extra display offset (tiles) applied to the incoming map
    camOffY: 0,
    camOffX0: 0, // the offset's starting magnitude (eases to 0)
    camOffY0: 0,
    dispX0: 0, // the incoming map's display pos at transition start (snapshot pin)
    dispY0: 0,
    forceSeamlessNext: false, // a plain manual-fade door -> crossfade it anyway
    manualScriptedFade: false, // a scripted manual fade -> leave it, no crossfade
    // A click landed in a neighbour preview: carry the destination across.
    pendingCross: null, // { mapId, tx, ty }
    // Step the player one tile further on arrival so they clear the overlap.
    walkThrough: false,
    walkThroughDir: 0, // the travel direction to step (captured pre-transfer)
    // Translate the player across the seam instead of fading it. Armed in
    // stop() only when the player was dropped from the snapshot, so no ghost
    // is left behind; carries the pixel position the glide starts from.
    playerGlide: false,
    playerScreenX0: 0,
    playerScreenY0: 0,
    resume: null, // { tx, ty, frames }
  };

  // Beyond this the seam is not a real adjacency (a long jump dressed as a
  // black fade), so cross-dissolve in place instead of panning.
  var MAX_SEAM_PAN = 4.0;

  // A manual fade with any of these between it and the Transfer it wraps is
  // hiding real setup, so it is cinematic and left alone.
  var HEAVY_CMDS = {};
  [
    203, 204, 205, 212, 213, 223, 224, 225, 231, 232, 233, 234, 235, 236, 282,
    283, 284, 285, 505,
  ].forEach(function (c) {
    HEAVY_CMDS[c] = true;
  });

  // Classify a Fadeout Screen (221) at list[idx] by scanning forward:
  //   'plain'    -> a Transfer follows with no heavy command in between
  //   'scripted' -> a Transfer follows but heavy setup is hidden by the fade
  //   'none'     -> not a transfer fade (a fade-in or another fade-out first,
  //                 or no transfer nearby)
  function classifyFade(list, idx) {
    if (!list) return "none";
    var heavy = false;
    var limit = Math.min(list.length, idx + 1 + 60);
    for (var k = idx + 1; k < limit; k++) {
      var c = list[k].code;
      if (c === 201) return heavy ? "scripted" : "plain";
      if (c === 221 || c === 222) return "none";
      if (HEAVY_CMDS[c]) heavy = true;
    }
    return "none";
  }

  if (typeof Game_Interpreter !== "undefined") {
    var _command221 = Game_Interpreter.prototype.command221;
    Game_Interpreter.prototype.command221 = function () {
      var cls = classifyFade(this._list, this._index);
      if (cls === "plain") {
        // Skip the manual black fade; the seamless crossfade replaces it.
        SM.forceSeamlessNext = true;
        return true;
      }
      if (cls === "scripted") {
        // Cinematic fade hiding setup: keep it, and stand down the crossfade.
        SM.manualScriptedFade = true;
      }
      return _command221.call(this);
    };

    // The paired Fade-in still waits out its duration on an already-bright
    // screen, which freezes the player for a beat after arriving.
    var _command222 = Game_Interpreter.prototype.command222;
    Game_Interpreter.prototype.command222 = function () {
      if (
        typeof $gameScreen !== "undefined" &&
        $gameScreen.brightness() >= 255
      ) {
        return true;
      }
      return _command222.call(this);
    };
  }

  function isHandledFade(fadeType) {
    return HANDLED_FADE_TYPES.indexOf(fadeType) >= 0;
  }

  function disposeSnap() {
    if (SM.snap) {
      SM.snap = null;
    }
  }

  // Soft-centered camera

  // Clamp a desired top-left display coordinate (in tiles) so the player is
  // centered, while never revealing more than OVERSCROLL_MARGIN tiles of void
  // past a map edge. For maps smaller than the screen, fall back to centering
  // the map itself (classic behaviour) rather than the player.
  function softTarget(desired, mapSize, screenTiles) {
    var end = mapSize - screenTiles; // top-left at the far edge (may be < 0)
    var lo = -OVERSCROLL_MARGIN;
    var hi = end + OVERSCROLL_MARGIN;
    if (lo > hi) {
      // Map (plus both margins) is narrower than the screen: center the map.
      return end / 2;
    }
    return desired.clamp(lo, hi);
  }

  // Write the display position directly, bypassing setDisplayPos's hard clamp
  // (which would re-pin the camera to the map edges and defeat centering).
  function applyDisplay(map, x, y) {
    map._displayX = x;
    map._parallaxX = x;
    map._displayY = y;
    map._parallaxY = y;
  }

  var _Game_Player_updateScroll = Game_Player.prototype.updateScroll;
  Game_Player.prototype.updateScroll = function (lastScrolledX, lastScrolledY) {
    var map = $gameMap;

    // A Scroll Map cutscene owns the camera while it runs.
    if (map.isLoopHorizontal() || map.isLoopVertical() || map.isScrolling()) {
      this._smRecover = RECOVER_FRAMES;
      return _Game_Player_updateScroll.call(this, lastScrolledX, lastScrolledY);
    }

    var tx = softTarget(
      this._realX - this.centerX(),
      map.width(),
      map.screenTileX(),
    );
    var ty = softTarget(
      this._realY - this.centerY(),
      map.height(),
      map.screenTileY(),
    );

    if (this._smRecover > 0) {
      this._smRecover--;
      var f = 0.18;
      tx = map._displayX + (tx - map._displayX) * f;
      ty = map._displayY + (ty - map._displayY) * f;
    }

    // Intentionally beyond the overscroll margin: the pan pushes the incoming
    // map off-screen and eases it in.
    applyDisplay(map, tx + SM.camOffX, ty + SM.camOffY);
  };

  // Re-stamped every frame the player moves without a forced route, so the
  // stamp stays fresh right up to the step that lands on the door whatever the
  // walk speed. A cutscene transfer either leaves the player standing or moves
  // them by forced route, so neither stamps: that is what separates a
  // self-walked door from a scripted one.
  var _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if (this.isMoving() && !this.isMoveRouteForcing()) {
      this._smWalkFrame = Graphics.frameCount;
    }
  };

  // Used to drop the player from the room snapshot (no frozen ghost) and to
  // drive the glide sprite that translates it across the seam.
  function findPlayerSprite(spriteset) {
    if (!spriteset || !spriteset._characterSprites) return null;
    var arr = spriteset._characterSprites;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i]._character === $gamePlayer) return arr[i];
    }
    return null;
  }

  // Suppress the stock black/white transfer fades while we own the transition.
  var _fadeOutForTransfer = Scene_Map.prototype.fadeOutForTransfer;
  Scene_Map.prototype.fadeOutForTransfer = function () {
    if (SM.pending) return;
    _fadeOutForTransfer.call(this);
  };

  var _fadeInForTransfer = Scene_Map.prototype.fadeInForTransfer;
  Scene_Map.prototype.fadeInForTransfer = function () {
    if (SM.pending) return;
    _fadeInForTransfer.call(this);
  };

  // stop() runs before any fade is applied, so the snapshot is the unfaded
  // room, and performTransfer runs later in the NEW scene, so the facing here
  // is still the direction the player walked into the door.
  var _Scene_Map_stop = Scene_Map.prototype.stop;
  Scene_Map.prototype.stop = function () {
    var transferring =
      SceneManager.isNextScene(Scene_Map) && $gamePlayer.isTransferring();
    // Never when a scripted manual fade is in play: it already blacked the
    // screen and is hiding setup.
    var doSeamless =
      transferring &&
      !SM.manualScriptedFade &&
      (isHandledFade($gamePlayer.fadeType()) || SM.forceSeamlessNext);
    SM.forceSeamlessNext = false; // consume the per-transfer flags
    SM.manualScriptedFade = false;

    // Captured at click time; keep it only if it targets the map being entered.
    if (transferring && SM.pendingCross) {
      dbg(
        "transfer: pendingCross",
        SM.pendingCross,
        "newMap",
        $gamePlayer._newMapId,
      );
      if (SM.pendingCross.mapId !== $gamePlayer._newMapId)
        SM.pendingCross = null;
    }

    // Arm a one-tile step-through so a self-walked door does not stop the
    // player dead on the shared overlap tile. Mouse cross-clicks are excluded:
    // they carry their own resume.
    SM.walkThrough = false;
    SM.walkThroughDir = 0;
    if (doSeamless && !SM.pendingCross) {
      var wf = $gamePlayer._smWalkFrame;
      if (wf != null && Graphics.frameCount - wf <= WALK_THROUGH_GRACE) {
        SM.walkThrough = true;
        // Capture it now: performTransfer re-faces the player to the door's
        // arrival direction, which may be anything (often blocked, which is
        // why the step looked like it did nothing).
        SM.walkThroughDir = $gamePlayer.direction();
      }
    }

    // Prime the JSON fetch for the room being left, so the new scene's
    // return-preview has no flash gap. Its bitmaps are already loaded.
    if (transferring) loadNeighbor($gameMap.mapId(), function () {});
    SM.playerGlide = false;
    if (doSeamless) {
      try {
        // No frozen player ghost in the snapshot: the glide sprite is then the
        // only player drawn during the transition. The pixel position is still
        // in the old map's framing here, which is what it glides from.
        SM.playerScreenX0 = $gamePlayer.screenX();
        SM.playerScreenY0 = $gamePlayer.screenY();
        var pSprite = findPlayerSprite(this._spriteset);
        var pVis = pSprite ? pSprite.visible : true;
        if (pSprite) {
          pSprite.visible = false;
          SM.playerGlide = true;
        }
        SM.snap = SceneManager.snap();
        if (pSprite) pSprite.visible = pVis;
        // Anchor to the door, not the raw player position: that makes the seam
        // coincide with the approach preview already drawn, so the next room
        // does not jump as the snapshot fades.
        var door = this.findUsedDoor();
        var anchorX = door ? door.ev.x : $gamePlayer._realX;
        var anchorY = door ? door.ev.y : $gamePlayer._realY;
        SM.seamScreenX = anchorX - $gameMap.displayX();
        SM.seamScreenY = anchorY - $gameMap.displayY();
        SM.pending = true;
      } catch (e) {
        // If snapshotting fails for any reason, fall back to the stock fade.
        SM.pending = false;
        disposeSnap();
      }
    }
    _Scene_Map_stop.call(this);
  };

  var _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this); // fadeInForTransfer is suppressed while pending

    // Resume walking toward a tile clicked in this map's preview before the
    // transfer, so the player does not stop dead on the seam.
    var cross = SM.pendingCross;
    SM.pendingCross = null;
    var walkStyle = false;
    if (cross && this._transfer && cross.mapId === $gameMap.mapId()) {
      // updateDestination runs at the TOP of each Scene_Map.update and clears
      // the destination on any frame the map-touch is not OK, so one
      // setDestination here is wiped before moveByInput ever reads it.
      $gameTemp.setDestination(cross.tx, cross.ty);
      SM.resume = { tx: cross.tx, ty: cross.ty, frames: CROSS_RESUME_FRAMES };
      walkStyle = true; // walk-into-next-room visual instead of a dissolve
      dbg("resume cross -> dest", cross.tx + "," + cross.ty, "walkStyle");
    } else {
      SM.resume = null;
      if (this._transfer && typeof $gameTemp !== "undefined") {
        // Don't carry a stale click target (an old-map tile) across a transfer.
        $gameTemp.clearDestination();
      }
    }

    // performTransfer put the player on the shared overlap tile; step one
    // further so they end in the new room proper.
    var stepThroughDir = 0;
    if (SM.walkThrough && this._transfer && !cross) {
      walkStyle = true; // walk-into-next-room visual, like the mouse cross move
      stepThroughDir = SM.walkThroughDir; // travel dir captured pre-transfer
    }
    SM.walkThrough = false;
    SM.walkThroughDir = 0;

    if (SM.pending && SM.snap) {
      this._smTime = 0;
      this._smWalkStyle = walkStyle;

      // Seed the incoming camera so the player lands on the on-screen spot it
      // occupied in the outgoing frame, then ease the offset to 0. camOff is
      // added to the display in Game_Player.updateScroll.
      var map = $gameMap;
      var targetX = softTarget(
        $gamePlayer._realX - $gamePlayer.centerX(),
        map.width(),
        map.screenTileX(),
      );
      var targetY = softTarget(
        $gamePlayer._realY - $gamePlayer.centerY(),
        map.height(),
        map.screenTileY(),
      );
      var displayX0 = $gamePlayer._realX - SM.seamScreenX;
      var displayY0 = $gamePlayer._realY - SM.seamScreenY;
      SM.camOffX0 = displayX0 - targetX;
      SM.camOffY0 = displayY0 - targetY;
      if (Math.abs(SM.camOffX0) > MAX_SEAM_PAN) SM.camOffX0 = 0;
      if (Math.abs(SM.camOffY0) > MAX_SEAM_PAN) SM.camOffY0 = 0;
      SM.camOffX = SM.camOffX0;
      SM.camOffY = SM.camOffY0;
      // The snapshot is pinned to this so it stays world-aligned as the camera
      // moves, from the seam ease or from the player walking.
      SM.dispX0 = targetX + SM.camOffX0;
      SM.dispY0 = targetY + SM.camOffY0;

      this._smSnapSprite = new Sprite(SM.snap);
      if (this._smWalkStyle) {
        // The old room sits underneath as a static base and the live new map
        // fades in over it, so the player stays on top and visible. The
        // spriteset's opaque black backdrop is dropped, or the old room shows
        // as a black band through the seam void.
        this.addChildAt(
          this._smSnapSprite,
          this.children.indexOf(this._spriteset),
        );
        if (this._spriteset) {
          this._spriteset.opacity = 0;
          if (this._spriteset._blackScreen) {
            this._smBlackWasOn = this._spriteset._blackScreen.opacity;
            this._spriteset._blackScreen.opacity = 0;
          }
        }
      } else {
        // Default: lay the outgoing room's snapshot OVER the spriteset and
        // dissolve it away, revealing the new map (pinned, so the already-drawn
        // next-room region never blinks).
        this.addChildAt(
          this._smSnapSprite,
          this.children.indexOf(this._spriteset) + 1,
        );
      }

      this._smActive = true;

      // Player glide: a full-opacity sprite that mirrors the live player and is
      // drawn on TOP of the room transition (above both the snapshot and the
      // fading-in spriteset). It translates from the outgoing on-screen spot
      // (SM.playerScreenX0/Y0) to the player's settled position; the real player
      // sprite is hidden for the transition so only this one shows. Covers both
      // the 0-block case (stays put, visible) and the 1-block case (glides over).
      this._smRealPlayerSprite = null;
      this._smPlayerSprite = null;
      this._smGlideOffX = null;
      if (SM.playerGlide) {
        var pps = findPlayerSprite(this._spriteset);
        if (pps) {
          this._smRealPlayerSprite = pps;
          var gs = new Sprite();
          gs.anchor.x = 0.5;
          gs.anchor.y = 1; // bottom-centre, like Sprite_Character
          this.addChild(gs); // top-most child
          this._smPlayerSprite = gs;
        }
      }
      SM.playerGlide = false;

      SM.pending = false; // re-enable fades for any subsequent normal transfer
    }

    if (stepThroughDir) this.performSeamWalkThrough(stepThroughDir);
  };

  // Take one extra step in the travel direction right after a self-walked seam
  // transfer, so the player clears the shared overlap tile instead of stopping
  // on it. Uses the same path as a normal input step (executeMove -> moveStraight
  // -> increaseSteps), so followers, encounters and step-events behave exactly
  // as a walked tile. Passability-guarded: if the next tile is blocked, the
  // player simply stays on the seam tile (no spurious turn). If the player keeps
  // the key held they continue past this automatically.
  Scene_Map.prototype.performSeamWalkThrough = function (dir) {
    var p = $gamePlayer;
    if (!p || !p.canMove() || p.isMoving()) return;
    if (typeof $gameMessage !== "undefined" && $gameMessage.isBusy()) return;
    if (!p.canPass(p.x, p.y, dir)) return; // blocked -> stay on the seam tile
    p.executeMove(dir);
    dbg("walk-through: +1 step dir", dir, "->", p.x + "," + p.y);
  };

  function easeInOutSine(t) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  Scene_Map.prototype.updateSeamlessTransition = function () {
    if (!this._smActive) return;

    this._smTime++;
    var k = Math.min(this._smTime / TRANSITION_FRAMES, 1);
    var e = easeInOutSine(k);

    // Ease the incoming map's camera offset to 0 (the settle-to-center pan).
    SM.camOffX = SM.camOffX0 * (1 - e);
    SM.camOffY = SM.camOffY0 * (1 - e);

    var map = $gameMap;
    // Keeps the snapshot world-aligned through the ease and any walking.
    if (this._smSnapSprite) {
      this._smSnapSprite.x = (SM.dispX0 - map.displayX()) * map.tileWidth();
      this._smSnapSprite.y = (SM.dispY0 - map.displayY()) * map.tileHeight();
    }

    if (this._smWalkStyle) {
      if (this._spriteset) this._spriteset.opacity = Math.round(255 * e);
    } else {
      if (this._smSnapSprite) {
        this._smSnapSprite.opacity = Math.round(255 * (1 - e));
      }
    }

    // The real player sprite is held hidden, re-asserted each frame in case the
    // engine reshows it, so only this glide sprite is seen.
    if (this._smPlayerSprite && this._smRealPlayerSprite) {
      var rp = this._smRealPlayerSprite;
      rp.visible = false;
      var gp = this._smPlayerSprite;
      gp.bitmap = rp.bitmap; // no-op when unchanged (Sprite setter guards)
      if (rp._frame) {
        gp.setFrame(
          rp._frame.x,
          rp._frame.y,
          rp._frame.width,
          rp._frame.height,
        );
      }
      var liveX = $gamePlayer.screenX();
      var liveY = $gamePlayer.screenY();
      if (this._smGlideOffX === null) {
        this._smGlideOffX = SM.playerScreenX0 - liveX;
        this._smGlideOffY = SM.playerScreenY0 - liveY;
      }
      gp.x = liveX + this._smGlideOffX * (1 - e);
      gp.y = liveY + this._smGlideOffY * (1 - e);
      gp.opacity = 255;
    }

    if (k >= 1) {
      this.endSeamlessTransition();
    }
  };

  Scene_Map.prototype.endSeamlessTransition = function () {
    if (this._smSnapSprite) {
      if (this._smSnapSprite.parent) {
        this._smSnapSprite.parent.removeChild(this._smSnapSprite);
      }
      this._smSnapSprite = null;
    }
    if (this._smPlayerSprite) {
      if (this._smPlayerSprite.parent) {
        this._smPlayerSprite.parent.removeChild(this._smPlayerSprite);
      }
      this._smPlayerSprite.bitmap = null; // shared with the real sprite -> just drop ref
      this._smPlayerSprite = null;
    }
    if (this._smRealPlayerSprite) {
      this._smRealPlayerSprite.visible = true; // hand the player back to the engine
      this._smRealPlayerSprite = null;
    }
    this._smGlideOffX = null;
    if (this._spriteset) {
      this._spriteset.opacity = 255; // restore in case walk-style faded it in
      if (this._spriteset._blackScreen && this._smBlackWasOn != null) {
        this._spriteset._blackScreen.opacity = this._smBlackWasOn;
      }
    }
    this._smBlackWasOn = null;
    this._smWalkStyle = false;
    this._smActive = false;
    SM.camOffX = 0;
    SM.camOffY = 0;
    disposeSnap();
  };

  // Has to happen at click time: the engine clears the click destination
  // before the transfer hook runs. A click in a neighbour's preview is
  // remembered as an absolute tile in that neighbour's coords.
  Scene_Map.prototype.captureCrossIntent = function () {
    if (typeof TouchInput === "undefined" || !TouchInput.isTriggered()) return;
    var x = $gameMap.canvasToMapX(TouchInput.x);
    var y = $gameMap.canvasToMapY(TouchInput.y);
    var inBounds = this.isRoomOpaqueAt(x, y);
    var rb = this.roomBounds();
    var t =
      typeof this.resolveVoidTarget === "function"
        ? this.resolveVoidTarget(x, y)
        : null;
    dbg(
      "click tile",
      x + "," + y,
      "canvas",
      Math.round(TouchInput.x) + "," + Math.round(TouchInput.y),
      "inBounds",
      inBounds,
      "previews",
      this._neighborSprites
        ? Object.keys(this._neighborSprites).join("|")
        : "-",
      "cross",
      t ? t.mapId + "@" + t.tx + "," + t.ty : null,
      "room",
      rb
        ? rb.w + "x" + rb.h
        : "null(arr " + $gameMap.width() + "x" + $gameMap.height() + ")",
      "roomDiag",
      this._roomBoundsDiag,
    );
    if (!this.isActive()) return;
    if (typeof $gameMessage !== "undefined" && $gameMessage.isBusy()) return;

    if (!t) {
      SM.pendingCross = null;
      return;
    }

    // Carry the absolute target (arrival + (click - door)) across the transfer.
    SM.pendingCross = { mapId: t.mapId, tx: t.tx, ty: t.ty };

    var door = t.pt;
    if (!door || typeof $gamePlayer === "undefined" || !$gamePlayer.canMove())
      return;

    if ($gamePlayer.x === door.ev.x && $gamePlayer.y === door.ev.y) {
      // Already standing ON the door: walking further is blocked by the map
      // edge, so the player-touch transfer can never fire and it is reserved
      // directly. The resume target already encodes the "one block in" minimum.
      this.startCrossTransfer(door);
      dbg(
        "on-door cross: reserve",
        door.mapId,
        door.bx + "," + door.by,
        "-> resume",
        t.tx + "," + t.ty,
      );
    } else {
      // Not on the door. The engine set the destination to an unreachable void
      // tile, which the stock 12-node search cannot route to, so steer the full
      // BFS at the door itself: stepping onto it fires the transfer.
      if (typeof $gameTemp !== "undefined") {
        $gameTemp.setDestination(door.ev.x, door.ev.y);
      }
      dbg(
        "walk-to-door cross: dest",
        door.ev.x + "," + door.ev.y,
        "-> resume",
        t.tx + "," + t.ty,
      );
    }
  };

  // Mirrors the 201 Transfer Player command, using the door's own arrival
  // tile, facing and fade, so the seam behaves as a walked transfer would.
  Scene_Map.prototype.startCrossTransfer = function (door) {
    if (typeof $gameTemp !== "undefined") $gameTemp.clearDestination();
    $gamePlayer.reserveTransfer(
      door.mapId,
      door.bx,
      door.by,
      door.dir || 0,
      door.fadeType || 0,
    );
  };

  // Runs at the END of the scene update, after updateDestination has cleared
  // the destination for this frame, so the target is present at the TOP of the
  // next one when updateDestination/moveByInput read it.
  Scene_Map.prototype.updateCrossResume = function () {
    var r = SM.resume;
    if (!r) return;
    if (typeof TouchInput !== "undefined" && TouchInput.isTriggered()) {
      SM.resume = null;
      return;
    }
    if (typeof $gamePlayer !== "undefined" && $gamePlayer.isMoving()) {
      // moveByInput re-paths each tile from here, so the engine keeps it alive.
      SM.resume = null;
      return;
    }
    if (--r.frames < 0) {
      SM.resume = null;
      return;
    }
    if (!this.isActive()) return;
    if (typeof $gamePlayer === "undefined" || !$gamePlayer.canMove()) return;
    if (typeof $gameMessage !== "undefined" && $gameMessage.isBusy()) return;
    if (typeof $gameTemp !== "undefined") {
      $gameTemp.setDestination(r.tx, r.ty);
    }
  };

  // processMapTouch runs BEFORE moveByInput each frame, so correcting here
  // means an on-door click reserves the transfer before the player can take a
  // wrong step toward the void on the old map.
  var _Scene_Map_updateDestination = Scene_Map.prototype.updateDestination;
  Scene_Map.prototype.updateDestination = function () {
    _Scene_Map_updateDestination.call(this);
    try {
      this.captureCrossIntent();
    } catch (e) {
      /* never let cross handling break the game loop */
    }
  };

  var _Scene_Map_update = Scene_Map.prototype.update;
  Scene_Map.prototype.update = function () {
    _Scene_Map_update.call(this);
    this.updateSeamlessTransition();
    try {
      this.updateCrossResume();
      this.updateNeighborPreviews();
    } catch (e) {
      /* never let a preview hiccup break the game loop */
    }
  };

  // A teardown mid-pan (chained transfer, menu) must not leak the snapshot or
  // a stale camera offset.
  var _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    if (this._smActive) {
      this.endSeamlessTransition();
    }
    SM.resume = null; // don't carry a resume across an unrelated scene change
    _Scene_Map_terminate.call(this);
  };

  // Neighbour-map preview on approach

  // Keyed by map id, for the session: each neighbour is parsed once.
  var neighborCache = {}; // mapId -> { ground: Bitmap|null, par: Bitmap|null }
  var neighborPending = {}; // mapId -> [callback]

  function mapDataPath(mapId) {
    var s = String(mapId);
    while (s.length < 3) s = "0" + s;
    return "data/Map" + s + ".json";
  }

  // In the shipped game a map lives under a hashed name and is TCOAAL-wrapped,
  // so this goes through App.redirect + Crypto.dekit exactly as
  // DataManager.loadDataFile does. A plain project fetches the logical path.
  function loadMapJson(mapId, cb) {
    var logical = mapDataPath(mapId);
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

  function ooParam() {
    return (
      (window.Hudell && Hudell.OrangeOverlay && Hudell.OrangeOverlay.Param) ||
      null
    );
  }

  // Mirrors OrangeOverlay's default layer naming (bare <ground>/<par> with no
  // explicit value resolves to "<filename><mapId>").
  function defaultOverlayName(kind, mapId) {
    var P = ooParam();
    var base =
      kind === "ground"
        ? (P && P.groundLayerFileName) || "ground"
        : (P && P.parallaxLayerFileName) || "par";
    return base + mapId;
  }

  // Mirrors OrangeOverlay.loadBitmap: organized folders vs. flat parallaxes.
  function loadOverlayBitmap(folder, name) {
    var P = ooParam();
    if (P && P.organizedFolders) {
      return ImageManager.loadBitmap("img/overlays/" + folder + "/", name);
    }
    return ImageManager.loadParallax(name);
  }

  function parseOverlayNames(note, mapId) {
    note = note || "";
    var res = { ground: null, par: null };
    var mg = /<ground(?::([^>]*))?>/i.exec(note);
    if (mg) {
      res.ground =
        mg[1] && mg[1].trim()
          ? mg[1].trim()
          : defaultOverlayName("ground", mapId);
    }
    var mp = /<par(?::([^>]*))?>/i.exec(note);
    if (mp) {
      res.par =
        mp[1] && mp[1].trim() ? mp[1].trim() : defaultOverlayName("par", mapId);
    }
    return res;
  }

  // The active page is picked exactly as Game_Event.findProperPageIndex does
  // (the LAST page whose conditions hold), against the live game state, which
  // is global and valid for any map id. So a chest already opened, or an NPC
  // who has left, previews in its current state rather than its first page.

  function eventMeetsConditions(page, mapId, eventId) {
    var c = page && page.conditions;
    if (!c) return true;
    if (
      c.switch1Valid &&
      (typeof $gameSwitches === "undefined" ||
        !$gameSwitches.value(c.switch1Id))
    )
      return false;
    if (
      c.switch2Valid &&
      (typeof $gameSwitches === "undefined" ||
        !$gameSwitches.value(c.switch2Id))
    )
      return false;
    if (
      c.variableValid &&
      (typeof $gameVariables === "undefined" ||
        $gameVariables.value(c.variableId) < c.variableValue)
    )
      return false;
    if (c.selfSwitchValid) {
      if (typeof $gameSelfSwitches === "undefined") return false;
      if ($gameSelfSwitches.value([mapId, eventId, c.selfSwitchCh]) !== true)
        return false;
    }
    if (c.itemValid) {
      if (
        typeof $gameParty === "undefined" ||
        typeof $dataItems === "undefined"
      )
        return false;
      if (!$gameParty.hasItem($dataItems[c.itemId])) return false;
    }
    if (c.actorValid) {
      if (
        typeof $gameParty === "undefined" ||
        typeof $gameActors === "undefined"
      )
        return false;
      if ($gameParty.members().indexOf($gameActors.actor(c.actorId)) < 0)
        return false;
    }
    return true;
  }

  function findActivePage(ev, mapId) {
    var pages = ev.pages || [];
    for (var i = pages.length - 1; i >= 0; i--) {
      if (eventMeetsConditions(pages[i], mapId, ev.id)) return pages[i];
    }
    return null;
  }

  // Skips events with no graphic (empty trigger regions and the like).
  function collectNeighborEventGraphics(data, mapId) {
    var out = [];
    var evs = (data && data.events) || [];
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (!ev || !ev.pages) continue;
      var page = findActivePage(ev, mapId);
      var img = page && page.image;
      if (!img) continue;
      if (!img.characterName && !(img.tileId > 0)) continue;
      out.push({
        x: ev.x,
        y: ev.y,
        tileId: img.tileId || 0,
        characterName: img.characterName || "",
        characterIndex: img.characterIndex || 0,
        direction: img.direction || 2,
        pattern: img.pattern == null ? 1 : img.pattern,
      });
    }
    return out;
  }

  function loadNeighbor(mapId, cb) {
    if (neighborCache[mapId]) {
      cb(neighborCache[mapId]);
      return;
    }
    if (neighborPending[mapId]) {
      neighborPending[mapId].push(cb);
      return;
    }
    neighborPending[mapId] = [cb];
    var done = function (entry) {
      neighborCache[mapId] = entry;
      var q = neighborPending[mapId] || [];
      delete neighborPending[mapId];
      q.forEach(function (f) {
        f(entry);
      });
    };
    loadMapJson(mapId, function (data) {
      var entry = {
        ground: null,
        par: null,
        w: 0,
        h: 0,
        tilesetId: 0,
        events: [],
      };
      if (data) {
        try {
          // Lets a void click resolve even before this preview is on screen.
          entry.w = data.width || 0;
          entry.h = data.height || 0;
          entry.tilesetId = data.tilesetId || 0;
          var names = parseOverlayNames(data.note, mapId);
          if (names.ground)
            entry.ground = loadOverlayBitmap("grounds", names.ground);
          if (names.par) entry.par = loadOverlayBitmap("pars", names.par);
          entry.events = collectNeighborEventGraphics(data, mapId);
        } catch (e) {
          /* leave entry empty -> no preview for this neighbour */
        }
      }
      done(entry);
    });
  }

  // Collect this map's transfer points once per scene: each event whose active
  // page has a direct (non-variable) Transfer Player command.
  Scene_Map.prototype.buildTransferPoints = function () {
    var pts = [];
    var events = $gameMap.events();
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev) continue;
      var page = ev.page ? ev.page() : null;
      if (!page || !page.list) continue;
      for (var j = 0; j < page.list.length; j++) {
        var c = page.list[j];
        if (c.code === 201 && c.parameters[0] === 0) {
          pts.push({
            ev: ev,
            mapId: c.parameters[1],
            bx: c.parameters[2],
            by: c.parameters[3],
            dir: c.parameters[4], // facing on arrival (0 = retain)
            fadeType: c.parameters[5], // 0 black, 1 white, 2 none
          });
          break; // one preview per event
        }
      }
    }
    this._transferPoints = pts;
    // Up front, so a void click can resolve onto a valid neighbour tile before
    // that door's approach preview has appeared.
    var warmed = {};
    for (var w = 0; w < pts.length; w++) {
      var mid = pts[w].mapId;
      if (!warmed[mid]) {
        warmed[mid] = true;
        loadNeighbor(mid, function () {});
      }
    }
  };

  // The door actually being used. Null for variable-target or non-event
  // transfers, where the seam falls back to anchoring on the player.
  Scene_Map.prototype.findUsedDoor = function () {
    if (!this._transferPoints) this.buildTransferPoints();
    var pts = this._transferPoints;
    var px = $gamePlayer._realX;
    var py = $gamePlayer._realY;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (
        p.mapId === $gamePlayer._newMapId &&
        p.bx === $gamePlayer._newX &&
        p.by === $gamePlayer._newY
      ) {
        var dd = (p.ev.x - px) * (p.ev.x - px) + (p.ev.y - py) * (p.ev.y - py);
        if (dd < bestDist) {
          bestDist = dd;
          best = p;
        }
      }
    }
    return best;
  };

  // One preview per destination map id. `pt` is the door that first brought
  // the neighbour into range; its arrival tile anchors the placement and stays
  // fixed for the preview's lifetime, so multiple doors to the same room never
  // spawn offset duplicates and the origin never jumps.
  Scene_Map.prototype.ensureNeighborSprite = function (mapId, pt) {
    if (!this._neighborSprites) this._neighborSprites = {};
    if (this._neighborSprites[mapId]) return;
    var scene = this;
    // On a respawn the player appears already within range, so the room they
    // came from should simply be there rather than fade in. A normal approach
    // enters range at ~0 opacity, where this is invisible either way.
    var slot = { sprite: null, pt: pt, snapNext: true };
    this._neighborSprites[mapId] = slot;
    loadNeighbor(mapId, function (entry) {
      if (!scene._neighborSprites || scene._neighborSprites[mapId] !== slot)
        return;
      var container = scene._spriteset && scene._spriteset._tilemap;
      if (!container) return;
      buildCompositePreview(entry, function (bmp) {
        if (!scene._neighborSprites || scene._neighborSprites[mapId] !== slot)
          return;
        if (!bmp) return;
        var sp = new Sprite(bmp);
        sp.z = -20; // behind the current map's ground (z = 1) and tiles
        sp.opacity = 0;
        container.addChild(sp);
        slot.sprite = sp;
      });
    });
  };


  // The drawable backing of a Bitmap (loaded image or its canvas), for drawImage.
  function drawableSource(bmp) {
    if (!bmp) return null;
    if (bmp._image) return bmp._image;
    if (bmp._canvas) return bmp._canvas;
    try {
      return bmp.canvas; // lazy getter realizes a canvas in some MV builds
    } catch (e) {
      return null;
    }
  }

  // The source-frame math needs the sheet size, so it waits for draw time.
  function eventDrawSpec(spec, entry) {
    if (spec.tileId > 0) {
      var tileset =
        typeof $dataTilesets !== "undefined" && entry.tilesetId
          ? $dataTilesets[entry.tilesetId]
          : null;
      if (!tileset) return null;
      var name = tileset.tilesetNames[5 + Math.floor(spec.tileId / 256)];
      if (!name) return null;
      return { spec: spec, bmp: ImageManager.loadTileset(name), kind: "tile" };
    }
    if (spec.characterName) {
      return {
        spec: spec,
        bmp: ImageManager.loadCharacter(spec.characterName),
        kind: "char",
      };
    }
    return null;
  }

  // Bottom-centre anchored like Sprite_Character; the source frame mirrors the
  // engine's block/pattern and updateTileFrame math.
  function drawEvent(ctx, e, tw, th) {
    var src = drawableSource(e.bmp);
    if (!src) return;
    var spec = e.spec;
    var sx, sy, pw, ph;
    if (e.kind === "tile") {
      pw = tw;
      ph = th;
      var t = spec.tileId;
      sx = ((Math.floor(t / 128) % 2) * 8 + (t % 8)) * pw;
      sy = (Math.floor((t % 256) / 8) % 16) * ph;
    } else {
      if (!e.bmp.width || !e.bmp.height) return;
      var big = ImageManager.isBigCharacter(spec.characterName);
      pw = e.bmp.width / (big ? 3 : 12);
      ph = e.bmp.height / (big ? 4 : 8);
      var n = big ? 0 : spec.characterIndex;
      var blockX = big ? 0 : (n % 4) * 3;
      var blockY = big ? 0 : Math.floor(n / 4) * 4;
      var px = spec.pattern < 3 ? spec.pattern : 1; // standing frame
      var py = (spec.direction - 2) / 2; // 2/4/6/8 -> 0/1/2/3
      sx = (blockX + px) * pw;
      sy = (blockY + py) * ph;
    }
    var destX = spec.x * tw + tw / 2;
    var destY = spec.y * th + th;
    try {
      ctx.drawImage(src, sx, sy, pw, ph, destX - pw / 2, destY - ph, pw, ph);
    } catch (_) {
      /* tainted/oversized source -> skip this one event */
    }
  }

  // The canvas spans the ground rect (the neighbour's map area), so event
  // tiles index straight into it and one Sprite at the door-anchored origin
  // lines the whole thing up. Waits for every source bitmap to load.
  function buildCompositePreview(entry, cb) {
    var tw = $gameMap.tileWidth();
    var th = $gameMap.tileHeight();
    var waits = [];
    if (entry.ground) waits.push(entry.ground);
    if (entry.par) waits.push(entry.par);
    var draws = [];
    var evs = entry.events || [];
    for (var i = 0; i < evs.length; i++) {
      var d = eventDrawSpec(evs[i], entry);
      if (!d) continue;
      draws.push(d);
      if (d.bmp) waits.push(d.bmp);
    }

    var pending = waits.length;
    var fired = false;
    function composite() {
      var W = 0;
      var H = 0;
      if (entry.ground) {
        W = Math.max(W, entry.ground.width);
        H = Math.max(H, entry.ground.height);
      }
      if (entry.par) {
        W = Math.max(W, entry.par.width);
        H = Math.max(H, entry.par.height);
      }
      if (!W || !H) {
        // No parallax art: fall back to the map array's pixel size.
        W = (entry.w || 0) * tw;
        H = (entry.h || 0) * th;
      }
      if (!W || !H) {
        cb(null);
        return;
      }
      var bmp = new Bitmap(W, H);
      var ctx = bmp._context;
      var gs = drawableSource(entry.ground);
      if (gs) ctx.drawImage(gs, 0, 0);
      for (var k = 0; k < draws.length; k++) drawEvent(ctx, draws[k], tw, th);
      var ps = drawableSource(entry.par);
      if (ps) ctx.drawImage(ps, 0, 0);
      if (bmp._setDirty) bmp._setDirty();
      if (bmp._baseTexture) bmp._baseTexture.update();
      cb(bmp);
    }
    function ready() {
      if (fired) return;
      if (--pending <= 0) {
        fired = true;
        composite();
      }
    }
    if (waits.length === 0) {
      composite();
      return;
    }
    for (var w = 0; w < waits.length; w++) {
      var b = waits[w];
      if ((b.isReady && b.isReady()) || (b.isError && b.isError())) ready();
      else if (b.addLoadListener) b.addLoadListener(ready);
      else ready();
    }
  }

  function moveOverlaySprite(sprite, x, y, targetOpacity, snap) {
    if (!sprite) return;
    sprite.x = x;
    sprite.y = y;
    if (snap) sprite.opacity = targetOpacity;
    else sprite.opacity += (targetOpacity - sprite.opacity) * PREVIEW_FADE;
  }

  function removeOverlaySprite(sprite) {
    if (sprite && sprite.parent) sprite.parent.removeChild(sprite);
  }

  Scene_Map.prototype.updateNeighborPreviews = function () {
    if (!this._neighborSprites) this._neighborSprites = {};
    if (!this._transferPoints) this.buildTransferPoints();

    var map = $gameMap;
    var tw = map.tileWidth();
    var th = map.tileHeight();
    var px = $gamePlayer._realX;
    var py = $gamePlayer._realY;
    // Kept alive through dialogue and the cross-dissolve on purpose: the
    // old-room preview has to be present and aligned under the fading snapshot
    // or the void empties for a frame and the old room flashes back in.
    var active = this.isActive();

    // One preview per destination map, opacity from its nearest door.
    var byMap = {}; // mapId -> { dist, pt, op }
    if (active) {
      for (var i = 0; i < this._transferPoints.length; i++) {
        var pt = this._transferPoints[i];
        var dx = pt.ev.x - px;
        var dy = pt.ev.y - py;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var op = (PREVIEW_RANGE + 0.5 - dist) / PREVIEW_RANGE;
        if (op <= 0) continue;
        var cur = byMap[pt.mapId];
        if (!cur || dist < cur.dist) {
          byMap[pt.mapId] = { dist: dist, pt: pt, op: Math.min(op, 1) };
        }
      }
    }

    for (var key in byMap) {
      var d = byMap[key];
      this.ensureNeighborSprite(d.pt.mapId, d.pt);
      var slot = this._neighborSprites[key];
      if (!slot) continue;
      // The arrival tile onto the door tile: the exact world position the real
      // transfer produces. Fixed to the slot's chosen door, so it stays put as
      // you approach and lines up with the map you land on.
      var originX = slot.pt.ev.x - slot.pt.bx;
      var originY = slot.pt.ev.y - slot.pt.by;
      var sx = (originX - map.displayX()) * tw;
      var sy = (originY - map.displayY()) * th;
      var op255 = Math.round(255 * d.op);
      var snap = slot.snapNext && slot.sprite;
      if (snap) slot.snapNext = false;
      moveOverlaySprite(slot.sprite, sx, sy, op255, snap);
    }

    for (var key2 in this._neighborSprites) {
      if (byMap[key2]) continue;
      var slot2 = this._neighborSprites[key2];
      var sp2 = slot2.sprite;
      if (sp2) moveOverlaySprite(sp2, sp2.x, sp2.y, 0);
      if (!sp2 || sp2.opacity < 2) {
        removeOverlaySprite(sp2);
        delete this._neighborSprites[key2];
      }
    }
  };

  // Cross-boundary click-to-move

  var ROOM_ALPHA_MIN = 8;

  // MV 1.6 builds loaded-image bitmaps straight into a GPU BaseTexture with no
  // canvas, so Bitmap.getAlphaPixel throws; the image is redrawn into an
  // offscreen canvas instead. Same-origin, so getImageData never taints.
  function alphaSamplerFor(bmp) {
    if (!bmp || !bmp.width || !bmp.height) return null;
    var src = bmp._image || bmp._canvas || null;
    if (!src) {
      try {
        src = bmp.canvas; // lazy getter realizes a canvas in some MV builds
      } catch (e) {
        src = null;
      }
    }
    if (!src) return null;
    try {
      var c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      var ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      return { ctx: ctx, w: bmp.width, h: bmp.height };
    } catch (e) {
      return null;
    }
  }

  // TCOAAL parallax maps are a full rectangle with TRANSPARENT areas where the
  // void shows through, laid over a much larger tile array, so neither the
  // array dims nor the parallax rectangle bound the (often non-rectangular)
  // room. Sampling the art's alpha does. Memoized per map id.
  Scene_Map.prototype.roomLayers = function () {
    var mapId = $gameMap.mapId();
    if (this._roomLayersId === mapId && this._roomLayers)
      return this._roomLayers;
    var layers = null;
    var diag = { names: null, g: null, p: null };
    try {
      var note =
        typeof $dataMap !== "undefined" && $dataMap ? $dataMap.note : "";
      var names = parseOverlayNames(note, mapId);
      diag.names = names;
      var g = names.ground ? loadOverlayBitmap("grounds", names.ground) : null;
      var p = names.par ? loadOverlayBitmap("pars", names.par) : null;
      diag.g = g ? g.width + "x" + g.height : "none";
      diag.p = p ? p.width + "x" + p.height : "none";
      var gs = g && g.width && g.height ? alphaSamplerFor(g) : null;
      var ps = p && p.width && p.height ? alphaSamplerFor(p) : null;
      if (gs || ps) layers = { ground: gs, par: ps };
    } catch (e) {
      diag.err = String(e);
    }
    this._roomBoundsDiag = diag;
    if (layers) {
      this._roomLayers = layers;
      this._roomLayersId = mapId;
    }
    return layers;
  };

  Scene_Map.prototype.roomBounds = function () {
    var L = this.roomLayers();
    if (!L) return null;
    var tw = $gameMap.tileWidth();
    var th = $gameMap.tileHeight();
    var w = 0;
    var h = 0;
    if (L.ground) {
      w = Math.max(w, L.ground.w / tw);
      h = Math.max(h, L.ground.h / th);
    }
    if (L.par) {
      w = Math.max(w, L.par.w / tw);
      h = Math.max(h, L.par.h / th);
    }
    return w && h ? { w: w, h: h } : null;
  };

  // The real "in the current map" test, correct for non-rectangular rooms: is
  // the click on THIS room or on a neighbour showing through a transparent
  // area. Falls back to map-array bounds before any parallax art resolves.
  Scene_Map.prototype.isRoomOpaqueAt = function (x, y) {
    var L = this.roomLayers();
    if (!L) {
      return x >= 0 && x < $gameMap.width() && y >= 0 && y < $gameMap.height();
    }
    var tw = $gameMap.tileWidth();
    var th = $gameMap.tileHeight();
    var px = Math.floor(x * tw + tw / 2); // sample the tile centre
    var py = Math.floor(y * th + th / 2);
    // par is foreground overlay and can hang over the void, so it is only
    // consulted when there is no ground layer at all.
    var s = L.ground || L.par;
    if (!s) return false;
    if (px < 0 || py < 0 || px >= s.w || py >= s.h) return false;
    try {
      return s.ctx.getImageData(px, py, 1, 1).data[3] > ROOM_ALPHA_MIN;
    } catch (e) {
      // Cannot tell: assume room, rather than mis-fire a transfer on a genuine
      // in-room click.
      return true;
    }
  };

  // The same alpha test isRoomOpaqueAt does, against the NEIGHBOUR's room
  // shape. Keyed by map id; null is cached only with no ground art at all
  // (a bare map), so a not-yet-loaded ground is retried on a later frame.
  var neighborSamplers = {}; // mapId -> {ctx,w,h} | null
  function neighborGroundSampler(mapId) {
    if (neighborSamplers[mapId] !== undefined) return neighborSamplers[mapId];
    var entry = neighborCache[mapId];
    if (!entry) return null; // map data not loaded yet -> don't cache
    var bmp = entry.ground;
    if (!bmp) {
      neighborSamplers[mapId] = null; // no ground art -> permanent "unknown"
      return null;
    }
    if (!bmp.width || !bmp.height || (bmp.isReady && !bmp.isReady()))
      return null; // decoding
    var s = alphaSamplerFor(bmp);
    neighborSamplers[mapId] = s || null;
    return neighborSamplers[mapId];
  }

  // Does neighbour `mapId`'s room cover its tile (tx, ty)?
  //   true  -> the clicked tile is real room of that neighbour (this change
  //            block genuinely leads to the area clicked),
  //   false -> transparent void there (this door does NOT lead to the click),
  //   null  -> can't tell yet (no/again-unloaded ground sampler).
  function neighborOpaqueAt(mapId, tx, ty) {
    var s = neighborGroundSampler(mapId);
    if (!s) return null;
    var tw = $gameMap.tileWidth();
    var th = $gameMap.tileHeight();
    var px = Math.floor(tx * tw + tw / 2); // sample the tile centre
    var py = Math.floor(ty * th + th / 2);
    if (px < 0 || py < 0 || px >= s.w || py >= s.h) return false;
    try {
      return s.ctx.getImageData(px, py, 1, 1).data[3] > ROOM_ALPHA_MIN;
    } catch (e) {
      return null;
    }
  }

  // If (x, y) (current-map tile coords, outside the current room) maps onto a
  // valid tile of one of this map's transfer destinations, return
  // { mapId, tx, ty, pt } in that neighbour's coordinates. Unlike the preview
  // overlay, this considers EVERY door (not just neighbours currently faded into
  // view), so a void click resolves even when the destination isn't visible --
  // the click handler then walks the player to that door first, transfers, and
  // resumes to (tx, ty). Each door anchors its neighbour so the arrival tile
  // (bx, by) sits on the door event (ev), i.e. neighbour tile = click - (ev-b).
  // Selection is by which neighbour's room actually COVERS the clicked tile
  // (opacity), then by the change block nearest the PLAYER -- see below.
  Scene_Map.prototype.resolveVoidTarget = function (x, y) {
    // Only a click NOT on the current room's art can be a neighbour tile (the
    // room is non-rectangular -- see isRoomOpaqueAt).
    if (this.isRoomOpaqueAt(x, y)) return null;
    if (!this._transferPoints) this.buildTransferPoints();
    var pts = this._transferPoints;

    // One candidate door per destination map. CRITICAL for correctness when
    // several overlapping doors lead to the same map: a map that is currently
    // PREVIEWED must be translated with the exact door its preview is anchored to
    // (slot.pt) -- the preview is drawn with that anchor, so any other door's
    // anchor would resolve the click to a tile that doesn't match what the player
    // sees (the off-by-one when standing on an overlapping transition block).
    // Maps with no preview on screen fall back to the door nearest the click.
    var doorByMap = {};
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      var slot = this._neighborSprites && this._neighborSprites[pt.mapId];
      if (slot && slot.pt) {
        doorByMap[pt.mapId] = slot.pt; // rendered anchor wins, unconditionally
        continue;
      }
      var cur = doorByMap[pt.mapId];
      if (!cur) {
        doorByMap[pt.mapId] = pt;
      } else if (!(this._neighborSprites && this._neighborSprites[pt.mapId])) {
        var dCur =
          (cur.ev.x - x) * (cur.ev.x - x) + (cur.ev.y - y) * (cur.ev.y - y);
        var dPt = (pt.ev.x - x) * (pt.ev.x - x) + (pt.ev.y - y) * (pt.ev.y - y);
        if (dPt < dCur) doorByMap[pt.mapId] = pt;
      }
    }

    // Pick the change block that genuinely "leads to the area clicked": the
    // clicked void tile, mapped through a door, must land on an OPAQUE tile of
    // that neighbour's ground art (its real room shape -- not just inside the
    // bounding rectangle, which overlapping change blocks share). Of the doors
    // that qualify, the one nearest the PLAYER wins, so the character walks to
    // the closest qualifying change block (often an overlapping one) rather than
    // simply the closest block, which may lead to a different room. Doors whose
    // neighbour art hasn't loaded yet ("unknown") are a weak fallback used only
    // when no door can be confirmed; a door confirmed transparent there is
    // rejected outright.
    var px = $gamePlayer ? $gamePlayer.x : x;
    var py = $gamePlayer ? $gamePlayer.y : y;
    var bestOpaque = null;
    var bestOpaqueDist = Infinity;
    var bestFallback = null;
    var bestFallbackDist = Infinity;
    for (var key in doorByMap) {
      var door = doorByMap[key];
      var entry = neighborCache[door.mapId];
      if (!entry || !entry.w || !entry.h) continue; // dims not loaded yet
      var tx = x - (door.ev.x - door.bx);
      var ty = y - (door.ev.y - door.by);
      if (tx < 0 || tx >= entry.w || ty < 0 || ty >= entry.h) continue;
      var op = neighborOpaqueAt(door.mapId, tx, ty);
      if (op === false) continue; // confirmed void of this neighbour -> not it
      var pdx = door.ev.x - px;
      var pdy = door.ev.y - py;
      var pd = pdx * pdx + pdy * pdy; // change block -> player distance
      var cand = {
        mapId: door.mapId,
        tx: Math.floor(tx),
        ty: Math.floor(ty),
        pt: door,
      };
      if (op === true) {
        if (pd < bestOpaqueDist) {
          bestOpaqueDist = pd;
          bestOpaque = cand;
        }
      } else if (pd < bestFallbackDist) {
        // op === null: art not loaded -> only used if nothing is confirmed.
        bestFallbackDist = pd;
        bestFallback = cand;
      }
    }
    return bestOpaque || bestFallback;
  };

  window.SeamlessMaps = { loadMapJson: loadMapJson, mapDataPath: mapDataPath };
})();

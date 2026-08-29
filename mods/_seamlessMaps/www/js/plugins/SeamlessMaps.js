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
 * SeamlessMaps: keeps the player centered and cross-fades every door transfer
 * so adjacent maps feel like one continuous space.
 *
 * TCOAAL is built from many small maps wired together with Transfer Player
 * events. By default each transfer hard-cuts to black and rebuilds the next
 * map, which makes the seams obvious. This plugin hides the seams in two ways:
 *
 *   1. Soft-centered camera. The view follows the player so they sit (mostly)
 *      in the middle of the screen instead of the map scrolling to its edges.
 *      A small overscroll margin is allowed so the camera can drift a little
 *      past a map edge; beyond that it stops, so you never see a big empty
 *      void around tiny rooms. Maps smaller than the screen stay centered.
 *
 *   2. Seamless transitions. RPG Maker has no global layout, so two maps can
 *      never be stitched together permanently with correct geometry. But at a
 *      transfer the destination map is already the real next room. So instead
 *      of fading to black, we snapshot the room we are leaving, build the new
 *      (centered) map underneath it, and cross-dissolve the snapshot away. The
 *      two rooms blend in place, with no black gap, so it reads as one space.
 *
 *   3. Approach preview. As the player comes within PREVIEW_RANGE tiles of a
 *      door, the destination map's real background (its <ground>/<par>
 *      parallax art) fades into the void beyond the current map's edge, so you
 *      can see into the next room before crossing. The preview also includes the
 *      next room's contents -- its events (NPCs, item sprites, props), each drawn
 *      with its current graphic (the active page, evaluated against the live game
 *      state). Ground, events and par are composited into a single bitmap in the
 *      true in-game stack order (ground -> events -> par) and faded as ONE sprite,
 *      so the room fades in as one coherent translucent image (fading the layers
 *      separately superposes their alphas over the void and ghosts/darkens).
 *      The preview sits behind the current map's ground layer, so it only ever
 *      shows through the empty void at an edge -- a door in the middle of a room
 *      reveals nothing, which is exactly right. The neighbour map data is fetched
 *      (and decrypted by the Service Worker / server) and cached once per session.
 *
 *   4. Cross-boundary click-to-move. Clicking into a neighbour's preview (the
 *      "dark" past an edge) means "walk into that room and over to there": the
 *      clicked tile is translated into the neighbour's coordinates, the click
 *      still walks you to the door + transfer, and the new scene resumes pathing
 *      to that tile -- so you don't stop on the seam, you land where you pointed
 *      and keep moving. These walked transfers use a "walk into the next room"
 *      visual instead of the dissolve: the live new map (with the player) fades
 *      in over the old room, which sits underneath and scrolls with you (correct
 *      z-order, translates with the player). Needs click-to-move (MouseControl).
 *
 * Fades handled: ordinary "normal" (black, fadeType 0) transfers get the
 * crossfade. Some doors instead bake their own Fadeout/Fadein Screen around the
 * transfer; those are classified by what sits between the fade-out and the
 * transfer -- a "plain" door (no scripted motion/animation/pictures) has its
 * manual fade skipped and crossfades seamlessly too, while a "scripted" door
 * (the fade is hiding teleports, animations, etc.) is left exactly as authored
 * (and the crossfade stands down so it doesn't fight the black fade). White
 * fades (fadeType 1, dramatic cuts) and bare instant swaps are left alone.
 * Scripted camera scrolls (Scroll Map during cutscenes) are respected too: the
 * centering steps aside while one runs and eases back afterwards.
 *
 * No engine files are modified; everything here is an additive prototype
 * override, so the plugin is safe to enable/disable per the mod system.
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

  // How many tiles the camera may drift past a map edge before it stops.
  // Larger = the player stays more perfectly centered but more empty space
  // can show around the map; smaller = tighter to the original framing.
  var OVERSCROLL_MARGIN = 4.0;

  // Length of the seamless cross-fade, in frames (60 fps). Roughly matches the
  // engine's stock fade so pacing feels unchanged.
  var TRANSITION_FRAMES = 30;

  // fadeType values we replace with a seamless pan. 0 = the default black
  // fade used by ordinary door transfers. 1 (white) and 2 (none) are left
  // untouched on purpose.
  var HANDLED_FADE_TYPES = [0];

  // Frames over which the camera glides back to the player after a scripted
  // map scroll releases control, instead of snapping.
  var RECOVER_FRAMES = 18;

  // Set true to log cross-boundary detection/resume to the console (temporary
  // diagnostics while tuning the click-to-move-across-maps behaviour).
  var DEBUG = false;
  function dbg() {
    if (DEBUG && typeof console !== "undefined") {
      console.log.apply(
        console,
        ["[SeamlessMaps]"].concat([].slice.call(arguments)),
      );
    }
  }

  // When the player comes within this many tiles of a transfer (door) area,
  // the destination map's real background fades into the void beyond the edge,
  // so you can see into the next room before crossing.
  var PREVIEW_RANGE = 2.0;

  // Smoothing factor for preview fade in/out (0..1 per frame).
  var PREVIEW_FADE = 0.22;

  // After a cross-boundary transfer, how many frames to keep re-issuing the
  // carried "virtual click" on the new map. The engine clears the walk
  // destination at the top of every frame the map-touch isn't OK (the transfer
  // settle), so a single setDestination is lost; we re-assert until the player
  // starts moving or this grace window expires.
  var CROSS_RESUME_FRAMES = 60;

  // A self-walked door transfer (keyboard, or a direct mouse path onto a door)
  // is recognised by the player having been moving under their OWN control
  // (not a forced move route) within this many frames of the transfer. The walk
  // stamp is refreshed every frame the player is self-moving (see the player
  // update hook), so it stays current right up to the step that lands on the
  // door regardless of walk speed -- this window therefore only has to absorb
  // the player-touch trigger + scene-stop settle, which is a few frames.
  var WALK_THROUGH_GRACE = 20;

  // Shared transition state

  // Carries the snapshot + direction across the scene teardown/rebuild that a
  // transfer performs (old Scene_Map.stop -> new Scene_Map.start).
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
    // Set by the Fadeout Screen interceptor for the upcoming transfer:
    forceSeamlessNext: false, // a plain manual-fade door -> crossfade it anyway
    manualScriptedFade: false, // a scripted manual fade -> leave it, no crossfade
    // Cross-boundary click-to-move: a click landed in a neighbour preview, so
    // carry the intended destination across the transfer and resume walking.
    pendingCross: null, // { mapId, tx, ty }
    // A self-walked seam transfer (keyboard / direct door path) is in flight ->
    // step the player one tile further on arrival so they clear the overlap.
    walkThrough: false,
    walkThroughDir: 0, // the travel direction to step (captured pre-transfer)
    // Player glide: keep the player visible and TRANSLATE it across the seam
    // (instead of fade-out/fade-in). Armed in stop() only when the player was
    // successfully dropped from the room snapshot (so it leaves no ghost), and
    // carries the outgoing on-screen pixel position the glide starts from.
    playerGlide: false,
    playerScreenX0: 0,
    playerScreenY0: 0,
    // Re-asserted virtual click on the freshly entered map (see
    // updateCrossResume / CROSS_RESUME_FRAMES).
    resume: null, // { tx, ty, frames }
  };

  // Beyond this, the seam isn't a real adjacency (a long jump dressed as a
  // black fade): skip the pan and just cross-dissolve in place.
  var MAX_SEAM_PAN = 4.0;

  // Event commands that mean a manual screen fade is hiding real setup (motion,
  // teleports, animations, pictures, tints/shakes). If any of these sit between
  // a Fadeout Screen and the Transfer it wraps, the fade is cinematic and is
  // left alone; otherwise the door is "plain" and gets the seamless treatment.
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

    // When we skipped a plain fade-out, its paired Fade-in still wants to wait
    // out its duration even though the screen is already fully bright. Skip the
    // dead wait so the player isn't frozen for a beat after arriving.
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
      // Bitmaps from Bitmap.snap own a canvas/texture; let GC reclaim it.
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

    // Looping maps and active scripted scrolls keep the stock behaviour: a
    // Scroll Map cutscene owns the camera while it runs.
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

    // After a scripted scroll releases, glide back to the player instead of
    // teleporting the camera.
    if (this._smRecover > 0) {
      this._smRecover--;
      var f = 0.18;
      tx = map._displayX + (tx - map._displayX) * f;
      ty = map._displayY + (ty - map._displayY) * f;
    }

    // The seamless pan pushes the incoming map off-screen and eases it in;
    // this offset is intentionally beyond the overscroll margin.
    applyDisplay(map, tx + SM.camOffX, ty + SM.camOffY);
  };

  // Track the most recent frame the player was moving under their OWN control
  // (input walk or a mouse-destination walk) -- NOT a forced move route. We
  // re-stamp every frame the player is moving and not move-route-forced, so the
  // stamp stays fresh right up to the step that lands on the door, independent
  // of walk speed (a slow step no longer ages it past the grace window) and of
  // whether the key was held or tapped. Cutscene transfers either leave the
  // player standing (an event runs the 201 -> isMoving() false) or move the
  // player via a forced route (isMoveRouteForcing() true), so neither stamps --
  // cleanly separating a self-walked door from a scripted one.
  var _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if (this.isMoving() && !this.isMoveRouteForcing()) {
      this._smWalkFrame = Graphics.frameCount;
    }
  };

  // The live Sprite_Character for the player in a spriteset (the on-screen
  // player), or null. Used to (a) drop the player from the room snapshot so it
  // leaves no frozen ghost, and (b) drive a separate full-opacity glide sprite
  // that translates the player from its outgoing on-screen spot to its settled
  // one instead of fading it out/in across the transfer.
  function findPlayerSprite(spriteset) {
    if (!spriteset || !spriteset._characterSprites) return null;
    var arr = spriteset._characterSprites;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i]._character === $gamePlayer) return arr[i];
    }
    return null;
  }

  // Seamless directional transition

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

  // On the way out of the old map: if this is a handled door transfer, grab a
  // clean snapshot of the room and remember the travel direction. stop() runs
  // before any fade is applied (we just suppressed it), so the snapshot is the
  // unfaded room. performTransfer (which clears isTransferring + moves the
  // player) only runs later, in the NEW scene, so the facing here is still the
  // direction the player walked into the door.
  var _Scene_Map_stop = Scene_Map.prototype.stop;
  Scene_Map.prototype.stop = function () {
    var transferring =
      SceneManager.isNextScene(Scene_Map) && $gamePlayer.isTransferring();
    // Seamless when the engine fade is one we handle, or a plain manual-fade
    // door asked for it -- but never when a scripted manual fade is in play
    // (that already blacked the screen and is hiding setup).
    var doSeamless =
      transferring &&
      !SM.manualScriptedFade &&
      (isHandledFade($gamePlayer.fadeType()) || SM.forceSeamlessNext);
    SM.forceSeamlessNext = false; // consume the per-transfer flags
    SM.manualScriptedFade = false;

    // Cross-boundary intent (SM.pendingCross) is captured at click time (see
    // captureCrossIntent); only keep it if it targets the map we're entering.
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

    // Self-walked seam transfer: the player stepped through a door under their
    // own control (a recent input-driven step) and it's a seamless overlap door
    // not a scripted cutscene and not a mouse cross-click (which carries its
    // own resume). Arm a one-tile step-through so they don't stop dead on the
    // shared overlap tile (A) but continue into the new room (B).
    SM.walkThrough = false;
    SM.walkThroughDir = 0;
    if (doSeamless && !SM.pendingCross) {
      var wf = $gamePlayer._smWalkFrame;
      if (wf != null && Graphics.frameCount - wf <= WALK_THROUGH_GRACE) {
        SM.walkThrough = true;
        // performTransfer (which re-faces the player to the door's arrival
        // direction) runs later, in the NEW scene -- so direction() here is
        // still the way the player WALKED into the door, i.e. the way further
        // into the new room. Capturing it now avoids stepping toward the arrival
        // facing, which a door may set to anything (wrong way, often blocked --
        // the reason the step "did nothing").
        SM.walkThroughDir = $gamePlayer.direction();
      }
    }

    // Warm the cache for the room we're leaving so the new scene can show its
    // return-preview immediately (no flash gap as the snapshot fades). Its
    // parallax bitmaps are already loaded; this just primes the JSON fetch.
    if (transferring) loadNeighbor($gameMap.mapId(), function () {});
    SM.playerGlide = false;
    if (doSeamless) {
      try {
        // Drop the player from the room snapshot so the dissolving / static-base
        // room carries no frozen player ghost -- the glide sprite built in the
        // new scene is then the ONLY player drawn during the transition. Capture
        // the on-screen pixel position it glides FROM (still the old map's
        // framing here -- performTransfer hasn't run).
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
        // Anchor the seam to the door the player is using: the incoming map is
        // framed so its arrival tile lands on the door's on-screen spot, then
        // eases to its natural framing. Anchoring to the door (not the raw
        // player position) makes the seam coincide with the already-drawn
        // approach preview, so the next room never jumps as the snapshot fades.
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

    // Cross-boundary click-to-move: if a click went into this map's preview
    // before we transferred, resume walking toward that tile now so the player
    // doesn't stop dead on the seam (lands 1+ tiles in, keeps pathing).
    var cross = SM.pendingCross;
    SM.pendingCross = null;
    var walkStyle = false;
    if (cross && this._transfer && cross.mapId === $gameMap.mapId()) {
      // Arm a re-asserted "virtual click": the engine's updateDestination runs
      // at the TOP of each Scene_Map.update and clears the destination on any
      // frame the map-touch isn't OK (the transfer settle), so a single
      // setDestination here is usually wiped before moveByInput ever reads it.
      // updateCrossResume re-issues it every frame until the player actually
      // starts walking (or a fresh click / the grace window supersedes it).
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

    // Self-walked (keyboard / direct) seam transfer: performTransfer placed the
    // player on the shared overlap tile (A). Step one tile further in their
    // travel direction so they end in the new room proper (B), the keyboard
    // analog of the mouse cross-move's "one block in" landing. Mouse cross moves
    // (cross) own their own resume, so they're excluded.
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

      // Seed the incoming camera so the player lands on the exact on-screen
      // spot they occupied in the outgoing frame (continuity at the seam),
      // then ease this offset to 0 so the map settles into its natural
      // (soft-clamped, centered) framing. camOff is added to the display in
      // Game_Player.updateScroll.
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
      // A seam wider than a few tiles isn't a real adjacency -> no pan, just a
      // pure cross-dissolve in place.
      if (Math.abs(SM.camOffX0) > MAX_SEAM_PAN) SM.camOffX0 = 0;
      if (Math.abs(SM.camOffY0) > MAX_SEAM_PAN) SM.camOffY0 = 0;
      SM.camOffX = SM.camOffX0;
      SM.camOffY = SM.camOffY0;
      // The incoming map's display position on the first frame; the snapshot is
      // pinned to this so it stays world-aligned as the camera moves (whether
      // from the seam ease or from the player walking during a cross move).
      SM.dispX0 = targetX + SM.camOffX0;
      SM.dispY0 = targetY + SM.camOffY0;

      this._smSnapSprite = new Sprite(SM.snap);
      if (this._smWalkStyle) {
        // Walk-into-next-room: the OLD room sits underneath as a static base
        // and the live NEW map (with the player) fades in over it -- correct
        // z-order (player always on top, visible) and it translates with the
        // player. The snapshot scrolls to stay world-pinned. The spriteset's
        // opaque black backdrop is dropped so the old room shows through the
        // seam void instead of a black band.
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
    // Pin the snapshot to wherever the camera is now, so it stays world-aligned
    // through both the seam ease and any player walking during a cross move.
    if (this._smSnapSprite) {
      this._smSnapSprite.x = (SM.dispX0 - map.displayX()) * map.tileWidth();
      this._smSnapSprite.y = (SM.dispY0 - map.displayY()) * map.tileHeight();
    }

    if (this._smWalkStyle) {
      // New map fades in over the old base.
      if (this._spriteset) this._spriteset.opacity = Math.round(255 * e);
    } else {
      // Old snapshot dissolves to reveal the new map.
      if (this._smSnapSprite) {
        this._smSnapSprite.opacity = Math.round(255 * (1 - e));
      }
    }

    // Player glide: mirror the live player's current frame and keep it crisp on
    // top, translating from the outgoing on-screen spot to its settled one. The
    // real player sprite is held hidden (re-asserted each frame in case the
    // engine reshows it), so only this glide sprite is seen.
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
        // First transition frame: the offset that, decaying to 0, makes the
        // glide begin exactly at the outgoing on-screen position.
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

  // Capture cross-boundary click intent at the moment of the click (the engine
  // clears the click destination before our transfer hook runs, so we can't read
  // it at transfer time). On a fresh click that lands in a neighbour's preview
  // (the void past an edge), remember the absolute target tile in that
  // neighbour's coords; a fresh in-bounds map click clears it.
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
      // A normal in-bounds click; let the engine path-find as usual.
      SM.pendingCross = null;
      return;
    }

    // The click landed in a neighbour's preview (the void past an edge). Carry
    // the absolute target tile (= arrival + (click - door)) across the transfer
    // so the new scene resumes walking there without a re-click.
    SM.pendingCross = { mapId: t.mapId, tx: t.tx, ty: t.ty };

    var door = t.pt;
    if (!door || typeof $gamePlayer === "undefined" || !$gamePlayer.canMove())
      return;

    if ($gamePlayer.x === door.ev.x && $gamePlayer.y === door.ev.y) {
      // Scenario 1: already standing ON the changing block. Walking further is
      // blocked by the map edge, so the player-touch transfer can never fire on
      // its own -> reserve it directly. The resume target already encodes the
      // "one block in" minimum (clicking one tile into the void gives a delta of
      // one tile in the crossing direction) and any larger clicked delta.
      this.startCrossTransfer(door);
      dbg(
        "on-door cross: reserve",
        door.mapId,
        door.bx + "," + door.by,
        "-> resume",
        t.tx + "," + t.ty,
      );
    } else {
      // Scenario 3: not on the changing block. The engine just set the walk
      // destination to the (unreachable) void tile, which the path-finder can
      // only approach via the stock 12-node search. Steer the full BFS to the
      // door tile itself so it routes there reliably; stepping onto it fires the
      // transfer, then start() resumes pathing to the carried target.
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

  // Scenario 1 helper: directly reserve the door's transfer when the player is
  // already on it (so no walk step is needed to trigger it). Mirrors what the
  // 201 Transfer Player command does, using the door's own arrival tile /
  // facing / fade so the seam anchoring and crossfade behave exactly as a
  // walked transfer through this door would.
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

  // Re-issue the carried "virtual click" each frame after a cross transfer,
  // until the player actually starts walking toward it. Runs at the END of the
  // scene update (after the engine's updateDestination has already cleared the
  // destination for this frame), so the target is present at the TOP of the
  // next frame when updateDestination/moveByInput read it. Aborts as soon as
  // the player is moving, a fresh click arrives, or the grace window expires.
  Scene_Map.prototype.updateCrossResume = function () {
    var r = SM.resume;
    if (!r) return;
    if (typeof TouchInput !== "undefined" && TouchInput.isTriggered()) {
      // A fresh user click supersedes the resume (captureCrossIntent handles it).
      SM.resume = null;
      return;
    }
    if (typeof $gamePlayer !== "undefined" && $gamePlayer.isMoving()) {
      // Movement has begun; the engine now keeps the destination alive on its
      // own (moveByInput re-paths each tile until arrival).
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

  // Correct a cross-boundary click at the destination stage, which the engine
  // runs (via processMapTouch) BEFORE the player's moveByInput each frame. Doing
  // it here means an on-door click reserves the transfer / clears the void
  // destination before the player can take a (wrong) step toward the void on the
  // old map -- so there's no spurious "one tile forward" before the transfer.
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

  // Safety: if the scene tears down mid-pan (e.g. a chained transfer or a
  // menu), don't leak the snapshot or a stale camera offset.
  var _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    if (this._smActive) {
      this.endSeamlessTransition();
    }
    SM.resume = null; // don't carry a resume across an unrelated scene change
    _Scene_Map_terminate.call(this);
  };

  // Neighbour-map preview on approach
  //
  // As the player nears a door, fade the destination map's real background
  // (its <ground>/<par> parallax art) into the void beyond the current map's
  // edge. The preview sprites live behind the current map's ground layer, so
  // they only ever show through the empty void at a map edge -- a door in the
  // middle of a room reveals nothing (there is no void to see into), which is
  // exactly right and means we never overdraw the current room.

  // Cache of resolved neighbour backgrounds, keyed by map id. Persists for the
  // session so each neighbour is fetched/parsed once.
  var neighborCache = {}; // mapId -> { ground: Bitmap|null, par: Bitmap|null }
  var neighborPending = {}; // mapId -> [callback]

  function mapDataPath(mapId) {
    var s = String(mapId);
    while (s.length < 3) s = "0" + s;
    return "data/Map" + s + ".json";
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

  // Neighbour-map event graphics (the room's "stuff": NPCs, item sprites,
  // interactables). For the preview we render each event the same way the engine
  // would: pick the active page exactly as Game_Event.findProperPageIndex does --
  // the LAST page whose conditions are met -- evaluated against the live, shared
  // game state ($gameSwitches/$gameVariables/$gameSelfSwitches/$gameParty), which
  // is global and valid for any map id. So a chest that has been opened, an NPC
  // that has left, etc. previews in its current state, not a stale first page.

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

  // Walk a map's events and record the visible graphic of each (the active
  // page's image). Skips events with no graphic (empty trigger regions, etc.).
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
    var xhr = new XMLHttpRequest();
    xhr.open("GET", mapDataPath(mapId)); // SW / server.js decrypts transparently
    xhr.overrideMimeType("application/json");
    xhr.onload = function () {
      var entry = {
        ground: null,
        par: null,
        w: 0,
        h: 0,
        tilesetId: 0,
        events: [],
      };
      try {
        var data = JSON.parse(xhr.responseText);
        // Map array dimensions: used to decide whether a void click lands on a
        // valid tile of this neighbour even when its preview isn't on screen.
        entry.w = data.width || 0;
        entry.h = data.height || 0;
        entry.tilesetId = data.tilesetId || 0;
        var names = parseOverlayNames(data.note, mapId);
        if (names.ground)
          entry.ground = loadOverlayBitmap("grounds", names.ground);
        if (names.par) entry.par = loadOverlayBitmap("pars", names.par);
        // The room's events (NPCs, item sprites, props) so the preview shows the
        // real contents of the next room, not just its empty floor.
        entry.events = collectNeighborEventGraphics(data, mapId);
      } catch (e) {
        /* leave entry empty -> no preview for this neighbour */
      }
      done(entry);
    };
    xhr.onerror = function () {
      done({ ground: null, par: null, w: 0, h: 0, tilesetId: 0, events: [] });
    };
    try {
      xhr.send();
    } catch (e) {
      done({ ground: null, par: null, w: 0, h: 0, tilesetId: 0, events: [] });
    }
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
    // Warm every destination map's data (dimensions + parallax) up front, so a
    // void click can resolve onto a valid neighbour tile even before that door's
    // approach preview has appeared.
    var warmed = {};
    for (var w = 0; w < pts.length; w++) {
      var mid = pts[w].mapId;
      if (!warmed[mid]) {
        warmed[mid] = true;
        loadNeighbor(mid, function () {});
      }
    }
  };

  // The transfer point matching the reserved transfer (destination map + arrival
  // tile), nearest to the player -- i.e. the door actually being used. Returns
  // null for variable-target or non-event transfers, in which case the seam
  // falls back to anchoring on the player.
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
    // snapNext: the first time this preview is positioned, jump straight to its
    // target opacity instead of fading from 0. On a normal approach you enter
    // range at ~0 opacity so this is invisible; on a respawn you appear already
    // within range, so the room you came from is simply *there*, not fading in.
    var slot = { sprite: null, pt: pt, snapNext: true };
    this._neighborSprites[mapId] = slot;
    loadNeighbor(mapId, function (entry) {
      // The scene may have been torn down or the slot recycled meanwhile.
      if (!scene._neighborSprites || scene._neighborSprites[mapId] !== slot)
        return;
      var container = scene._spriteset && scene._spriteset._tilemap;
      if (!container) return;
      // Ground + events + par merged into one bitmap, faded as a single sprite.
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

  // The previewed neighbour is composited into a SINGLE bitmap (ground -> events
  // -> par, the true in-game stack) and faded as one sprite. Fading the layers
  // separately would superpose three independent alphas over the void (par over
  // events over ground over black), which reads as ghosting/darkening; merging
  // first makes the next room fade in as one coherent translucent image.

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

  // Resolve one event's source bitmap (character sheet or tileset page). The
  // source-frame math needs the sheet size, so it's deferred to draw time.
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

  // Blit one event onto the composite at its tile (bottom-centre anchored, like
  // Sprite_Character). Source frame mirrors the engine's block/pattern (char) and
  // updateTileFrame (tile) math.
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

  // Build the merged preview bitmap for a neighbour, once every source bitmap
  // (ground, par, each event graphic) has loaded. The canvas spans the ground
  // rect (== the neighbour's map area); event tiles index straight into it, so
  // a single Sprite at the door-anchored origin lines the whole thing up.
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
        // No parallax art resolved -> fall back to the map array's pixel size so
        // events still have somewhere to land.
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
    // Kept alive during dialogue AND during the cross-dissolve on purpose: the
    // old-room preview must already be present and aligned under the fading
    // snapshot, or the void region would briefly empty out (snapshot gone,
    // preview not yet created) and the old room would flash back in. Only an
    // inactive scene (menu, etc.) suppresses previews.
    var active = this.isActive();

    // Collapse all doors by destination map: one preview each, opacity taken
    // from the nearest door to that map.
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

    // Create / position / fade the wanted previews.
    for (var key in byMap) {
      var d = byMap[key];
      this.ensureNeighborSprite(d.pt.mapId, d.pt);
      var slot = this._neighborSprites[key];
      if (!slot) continue;
      // Anchor the neighbour's arrival tile onto the door tile -- the exact
      // world position the real transfer produces. Origin is fixed to the
      // slot's chosen door, so it stays put as you approach and lines up with
      // the map you land on (no 1-tile pop, no duplicates).
      var originX = slot.pt.ev.x - slot.pt.bx;
      var originY = slot.pt.ev.y - slot.pt.by;
      var sx = (originX - map.displayX()) * tw;
      var sy = (originY - map.displayY()) * th;
      var op255 = Math.round(255 * d.op);
      // Snap to target the first frame the sprite exists (present-on-respawn);
      // ease thereafter.
      var snap = slot.snapNext && slot.sprite;
      if (snap) slot.snapNext = false;
      moveOverlaySprite(slot.sprite, sx, sy, op255, snap);
    }

    // Fade out / remove previews no longer wanted.
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
  //
  // A click that lands in a neighbour's preview (the "dark" void past a map
  // edge) means "walk into that room and over to there". We translate the
  // clicked tile into the neighbour's coordinates and remember it, then route
  // the player across through the door that preview is anchored to:
  //   - if the player is already standing ON that door (the changing block --
  //     e.g. you just respawned on the return door), walking into the edge
  //     can't fire the transfer, so we reserve it directly;
  //   - otherwise we steer the full BFS to the door tile so it path-finds there
  //     reliably and the step onto it fires the transfer.
  // On arrival the new scene resumes pathing to the carried tile -- so you don't
  // stop on the seam, you land 1+ tiles in and keep walking where you pointed.

  // Pixel above this ground/par alpha counts as "the current room draws here".
  var ROOM_ALPHA_MIN = 8;

  // Build a 2D context holding a copy of a loaded Bitmap's pixels, so we can
  // read per-pixel alpha. MV 1.6 builds loaded-image bitmaps straight into a
  // GPU BaseTexture (no canvas/_context), so Bitmap.getAlphaPixel would throw;
  // we draw the source image into our own offscreen canvas instead. Same-origin
  // (SW/server served) so getImageData never taints.
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

  // Resolve the current map's ground/par parallax into alpha samplers (the real
  // room art). TCOAAL parallax maps are a full-rectangle parallax with
  // TRANSPARENT areas where the void/neighbours show through, laid over a much
  // larger tile array -- so neither the array dims nor the parallax rectangle
  // bound the (often non-rectangular) room. Sampling the art's alpha does.
  // Memoized per map id; null until at least one parallax bitmap has loaded.
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

  // Outer rectangle of the room art (for diagnostics / a cheap reject).
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

  // True when the current map's room art is opaque at tile (x, y) -- i.e. the
  // click is on THIS room, not on a neighbour showing through a transparent
  // area. This is the real "in the current map" test (correct for
  // non-rectangular rooms). Falls back to map-array bounds when no parallax art
  // has resolved yet.
  Scene_Map.prototype.isRoomOpaqueAt = function (x, y) {
    var L = this.roomLayers();
    if (!L) {
      return x >= 0 && x < $gameMap.width() && y >= 0 && y < $gameMap.height();
    }
    var tw = $gameMap.tileWidth();
    var th = $gameMap.tileHeight();
    var px = Math.floor(x * tw + tw / 2); // sample the tile centre
    var py = Math.floor(y * th + th / 2);
    // The ground (floor) is the reliable room indicator; par is foreground
    // overlay that can hang over the void, so only consult it when there is no
    // ground layer at all.
    var s = L.ground || L.par;
    if (!s) return false;
    if (px < 0 || py < 0 || px >= s.w || py >= s.h) return false;
    try {
      return s.ctx.getImageData(px, py, 1, 1).data[3] > ROOM_ALPHA_MIN;
    } catch (e) {
      // getImageData failure -> can't tell; assume room so we don't mis-fire a
      // transfer on a genuine in-room click.
      return true;
    }
  };

  // Per-neighbour ground alpha sampler (built once from the cached ground art),
  // so a cross-boundary click can be tested against the NEIGHBOUR's real room
  // shape -- the same alpha test isRoomOpaqueAt does for the current map. Keyed
  // by map id; null is cached only when the neighbour has no ground art at all
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
})();

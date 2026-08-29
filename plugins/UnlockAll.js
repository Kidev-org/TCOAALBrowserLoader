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
 * @plugindesc Treats every ending/gallery tag as unlocked while enabled (TCOAAL).
 * @author kidev
 *
 * @help
 * Standalone build of the Browser Player's Unlocker mod. Injects the
 * ending/gallery tags on read and strips them again on write, so disabling
 * the plugin leaves global.rpgsave exactly as it was.
 *
 * Install: copy to www/js/plugins/ and add
 *   {"name":"UnlockAll","status":true,"description":"","parameters":{}}
 * to www/js/plugins.js AFTER the AudioStreaming entry.
 */
/* The tags live in globalInfo[0].tags (save/global.rpgsave). */

(function () {
  "use strict";

  if (typeof DataManager === "undefined") return;

  var INJECTED_TAGS = [
    "star_money",
    "star_butcher",
    "star_soda",
    "star_present",
    "star_ring",
    "leytarsoul",
    "visionroom",
    "vision_room",
    "nailgun",
    "coffee",
    "star_phone",
    "star_choker",
    "pretzels",
    "complex",
  ];

  var INJECTED_SET = Object.create(null);
  for (var i = 0; i < INJECTED_TAGS.length; i++) {
    INJECTED_SET[INJECTED_TAGS[i]] = true;
  }

  // The tags that were genuinely in the last load, so the save wrapper can
  // tell a tag it injected from one the player had earned.
  var _lastOriginal = null;

  function cloneSlot0(slot0, newTags) {
    var out = {};
    if (slot0 && typeof slot0 === "object") {
      for (var k in slot0) {
        if (Object.prototype.hasOwnProperty.call(slot0, k)) out[k] = slot0[k];
      }
    }
    out.tags = newTags;
    return out;
  }

  var _origLoad = DataManager.loadGlobalInfo;
  DataManager.loadGlobalInfo = function () {
    var info = _origLoad.call(this);
    if (!info || !Array.isArray(info)) return info;

    var slot0 = info[0] && typeof info[0] === "object" ? info[0] : null;
    var origTags = slot0 && Array.isArray(slot0.tags) ? slot0.tags : [];

    var originalSet = Object.create(null);
    for (var i = 0; i < origTags.length; i++) originalSet[origTags[i]] = true;
    _lastOriginal = originalSet;

    var merged = origTags.slice();
    for (var j = 0; j < INJECTED_TAGS.length; j++) {
      if (!originalSet[INJECTED_TAGS[j]]) merged.push(INJECTED_TAGS[j]);
    }

    var out = info.slice();
    out[0] = cloneSlot0(slot0, merged);
    return out;
  };

  var _origSave = DataManager.saveGlobalInfo;
  DataManager.saveGlobalInfo = function (info) {
    if (
      !info ||
      !Array.isArray(info) ||
      !info[0] ||
      !Array.isArray(info[0].tags)
    ) {
      return _origSave.call(this, info);
    }
    var tags = info[0].tags;
    var keep = [];
    var seen = Object.create(null);
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (seen[t]) continue;
      seen[t] = true;
      if (INJECTED_SET[t] && !(_lastOriginal && _lastOriginal[t])) continue;
      keep.push(t);
    }
    var cleaned = info.slice();
    cleaned[0] = cloneSlot0(info[0], keep);
    return _origSave.call(this, cleaned);
  };
})();

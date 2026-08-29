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
 * Unlock All Tags (TCOAAL)
 *
 * Pretends every ending/gallery tag (vision_room, star_*, nailgun, etc.) is
 * unlocked while the plugin is enabled.
 *
 * Tags live in globalInfo[0].tags inside RPG Global / save/global.rpgsave.
 * We wrap DataManager.loadGlobalInfo to merge the target tags in on read,
 * and DataManager.saveGlobalInfo to strip any tag we injected (but that
 * wasn't in the stored save) before write. Net effect: disabling the plugin
 * leaves the user's global save bit-identical to how it was before enabling.
 */

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

  // Snapshot of the tags genuinely present in the most recent loadGlobalInfo
  // result. The save wrapper uses it to tell "tag was already real, keep it"
  // apart from "tag only exists because we injected it, drop it".
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

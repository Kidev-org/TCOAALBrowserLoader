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
"use strict";

/*
 * The Browser Player's own plugins a mod build can ship: the Build pane's
 * checklist in app/create.html and the "plugins" list of a repository's
 * .config/mod.json read by tools/build-mod.js. One list, so a plugin added
 * here is offered by both.
 *
 * `src` is relative to the site root (https://tcoaal.app/ in production):
 * the six standalone builds under plugins/ at the repo root, which
 * plugins/README.md documents for hand installation, and two catalog plugin
 * mods read past any installed IDB copy ("?fresh="). `file` is where the
 * plugin lands in the mod's tree, `name` its js/plugins.js registry name,
 * and `parameters` the registry parameters it is shipped with.
 */
(function (root) {
  root.BundledPlugins = [
    {
      name: "MouseControl",
      file: "js/plugins/MouseControl.js",
      src: "plugins/MouseControl.js",
      title: "Mouse Control",
      author: "kidev",
      blurb:
        "Click-to-move, right-click cancel and menu, click on the player " +
        "tile to interact, hover-to-select choices, touch gestures.",
      description: "Mouse and touch control.",
    },
    {
      name: "ImprovedLoader",
      file: "js/plugins/ImprovedLoader.js",
      src: "plugins/ImprovedLoader.js",
      title: "Improved Loader",
      author: "kidev",
      blurb:
        "Pause during cutscenes, notes on save rows, uncapped slots, a " +
        "preview of the hovered save, fast load, quick save on M.",
      description: "Better save/load.",
      // No prefix on the save rows. The plugin's "auto" label reads an
      // episode off the BASE game's map ids, and a mod's maps are its
      // own: in a mod that tag is either wrong or meaningless, so a save
      // here is named by its note and nothing else.
      parameters: { Label: "" },
    },
    {
      name: "VirtualController",
      file: "js/plugins/VirtualController.js",
      src: "plugins/VirtualController.js",
      title: "Virtual Controller",
      author: "kidev",
      blurb: "On-screen touch controller: d-pad, A/B/X/Y, menu, quick save.",
      description: "On-screen touch controller.",
    },
    {
      name: "InteractGlint",
      file: "js/plugins/InteractGlint.js",
      src: "plugins/InteractGlint.js",
      title: "Interact Glint",
      author: "kidev",
      blurb:
        "A small periodic glint on everything you can interact with, " +
        "following the UI Hints option.",
      description: "Glint on interactables.",
    },
    {
      name: "SeamlessMaps",
      file: "js/plugins/SeamlessMaps.js",
      src: "plugins/SeamlessMaps.js",
      title: "Seamless Maps",
      author: "kidev",
      blurb:
        "Centered camera, cross-faded door transfers, next-room previews " +
        "past the map edge.",
      description: "Centered camera and seamless doors.",
    },
    {
      name: "UnlockAll",
      file: "js/plugins/UnlockAll.js",
      src: "plugins/UnlockAll.js",
      title: "Unlocker",
      author: "kidev",
      blurb:
        "Every ending and gallery tag reads as unlocked while the plugin " +
        "is on; the save file itself is left as it was.",
      description: "Unlock every ending/gallery tag.",
    },
    {
      name: "SAN_AnalogMove",
      file: "js/plugins/SAN_AnalogMove.js",
      src: "mods/_AnalogMove/www/js/plugins/SAN_AnalogMove.js?fresh=",
      title: "Analog Move",
      author: "Sanshiro",
      blurb: "Dot movement for the party that does not depend on tiles.",
      description: "Analog movement.",
    },
    {
      name: "YEP_X_MessageBacklog",
      file: "js/plugins/YEP_X_MessageBacklog.js",
      src: "mods/_MessageBacklog/www/js/plugins/YEP_X_MessageBacklog.js?fresh=",
      title: "Message Backlog",
      author: "Yanfly",
      blurb: "A backlog of past messages, opened with TAB.",
      description: "Message backlog (TAB).",
    },
  ];
})(typeof self !== "undefined" ? self : this);

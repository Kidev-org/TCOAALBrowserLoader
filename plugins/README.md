# Standalone plugins

The Browser Player's mods and its save/load features, each as one ordinary
RPG Maker MV plugin file that installs into the desktop game (the Steam
build of TCOAAL, or an overhaul built on the same engine).

| File                   | What it does                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `MouseControl.js`      | click-to-move, right-click cancel/menu, click on the player tile to interact, hover-to-select choices, contextual cursors, touch gestures |
| `ImprovedLoader.js`    | pause during cutscenes, notes and episode tags on save rows, uncapped slots, a rendered preview of the hovered save in the Continue menu, fast load, quick save on M |
| `VirtualController.js` | on-screen touch controller (d-pad, A/B/X/Y, menu, quick save) |
| `InteractGlint.js`     | a small periodic glint on every Action Button interactable, following the "UI Hints" option |
| `SeamlessMaps.js`      | centered camera, cross-faded door transfers, next-room previews past the map edge |
| `UnlockAll.js`         | every ending/gallery tag reads as unlocked while enabled; reversible |

## Install

A modder packaging a mod in `create.html` can tick any of these under
"Plugins to ship with the mod": the file and its registry line below are
added to the package, so the player's copy has them once the mod is
installed. By hand:

1. Copy the file(s) you want into `www/js/plugins/` of the game.
2. Open `www/js/plugins.js` and add one entry per file to the `$plugins`
   array, AFTER the `AudioStreaming` entry (see "Load order" below):

```js
{"name":"MouseControl","status":true,"description":"Mouse and touch control.","parameters":{}},
{"name":"VirtualController","status":true,"description":"On-screen touch controller.","parameters":{}},
{"name":"InteractGlint","status":true,"description":"Glint on interactables.","parameters":{}},
{"name":"SeamlessMaps","status":true,"description":"Centered camera and seamless doors.","parameters":{}},
{"name":"UnlockAll","status":false,"description":"Unlock every ending/gallery tag.","parameters":{}},
{"name":"ImprovedLoader","status":true,"description":"Better save/load.","parameters":{"Label":"auto"}},
```

Set `"status":false` on any you do not want; the files can stay in place.

`"Label":"auto"` puts `[Episode X]` in front of each save row, read off the
BASE game's map ids. Use `"Label":""` (no prefix) in a mod: an overhaul reuses
those ids for its own story, so the episode it names is not the one the save
is in. The Create page packages it that way for you.

The order among the six otherwise does not matter.

## Per-plugin notes

**ImprovedLoader**

- Notes are stored in `savenotes.json` in the same folder as the save files
  (`%APPDATA%/CoffinAndyLeyley/` for the base game), keyed by save filename
  so they follow the file. Delete the file to clear every note.
- Keys: `N` on a save row edits its note (Enter keeps it, Esc discards),
  `M` on the map quick-saves to the first free slot, `Escape` during a
  cutscene or a line of dialogue opens the menu.
- File slots are uncapped: the list always shows five empty rows past the
  highest used one. The number of autosaves kept on disk follows the
  in-game option instead of the fixed maximum.
- Not included (they exist in the Browser Player because it has no file
  system): export/import/delete of saves.

**SeamlessMaps**

- Cross-boundary click-to-move (clicking into the next room's preview)
  needs `MouseControl`. Everything else works without it.

**VirtualController**

- The quick-save button only appears when `ImprovedLoader` is installed.
- The tap-to-continue layer during cutscenes only appears when
  `MouseControl` is NOT installed (with it, taps already reach the game).

**UnlockAll**

- Injects the tags on read and strips them again on write, so disabling the
  plugin leaves `global.rpgsave` exactly as it was.

## Removing

Set `"status":false` or delete the entry and the file. `ImprovedLoader`
leaves `savenotes.json` behind (notes only; harmless) and nothing else.

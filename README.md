# kidev's TCOAAL Browser Loader

**You must OWN the game: this tool only allows you to make it playable on a browser**

A browser tool to play [_The Coffin of Andy and Leyley_](https://store.steampowered.com/app/2378900/The_Coffin_of_Andy_and_Leyley/) (by _Nemlei_) from the browser.  
Game files stay on your device. Works on desktop and mobile (Chrome, Edge, Firefox, Safari), and can be installed as an Android app or a PWA.

The point of the project is to bring a copy you already own to the web and to
mobile, and to layer on the quality-of-life features the community has long
wanted (touch controls, save anywhere, save previews and export, infinite
slots, local achievements, community mods and translations), all without
altering or redistributing the game itself. The changes live in the browser
runtime around your own files; the game content is never modified on disk.

## Loader features

- **Play in browser**: import your own copy (folder or `.zip`) once via `loader.html`, then just open the page to play. No Node/NW.js required.
- **Offline play**: after the first import, a Service Worker serves every game file locally; the game keeps working with no connection.
- **Multiple versions**: import several builds of the game side by side and switch between them; a guided wizard can drive your own Steam client (via `steam://` console commands) to download older depots for mods that need a specific version.
- **Mods**: browse and install community overhauls, translations and plugins from the in-game **Mods** menu. Overhauls are exclusive (one active at a time), plugins can be combined freely, and saves are kept isolated per active mod.
- **Data management**: clear/reset all browser data for a fresh start; save files can be exported and re-imported independently of the browser profile.

## Game additions

Quality-of-life features layered on top of the original game, available regardless of which mod (if any) is active:

- **Save anytime, even mid-scene**: Escape opens the pause menu at any point during a CG or line of dialogue, not just on a quiet map like stock RPG Maker requires. You're never stuck without a way to save because a cutscene is running.
- **Saves keep the exact line**: saving while a message is on screen stores that exact line; loading the save resumes right there instead of skipping ahead to the next command like a naive save/load would.
- **Save annotations**: press `[N]` on any save slot (or long-press it on touch) to add or edit a free-form note right on the row; new saves are auto-labeled with their creation time until you overwrite the note yourself.
- **Save preview**: the Continue screen renders a real snapshot of each save (map, characters, on-screen dialogue) instead of a blank/generic background.
- **Instant drag & drop loading**: drop a `.rpgsave` (or a legacy `.json` export) anywhere on the window and it loads immediately, jumping straight into that save.
- **Save export/import**: export any save, or all of them at once, as standard `.rpgsave` files you can back up or move to another browser/device.
- **Quick save**: a dedicated key (`M`) or on-screen button saves instantly to a new file slot without opening the menu.
- **Infinite save slots**: the stock 30/50-slot cap is removed; the save screen scrolls to as many files as you make.
- **Achievements**: Steam achievements are replaced with a local unlock system and an on-screen toast, so progress tracking works without Steamworks.

## Included plugins and mods

Available directly from the in-game **Mods** menu (no external download needed):

**Plugins** (any combination can be active):
- Mouse Control: mouse/touch input for menus and gameplay
- Virtual Controller: on-screen D-pad + action buttons
- Analog Move: free (non-tile-locked) movement
- Message Backlog: message history (TAB)
- Seamless Maps: keeps the player centered and turns door transfers into a smooth pan
- Unlocker: unlocks the vision room, visions and stars

**Overhauls** (one active at a time):
- The Coffin of Andrew and Renee (TCOAAR)
- The Coffin of Andy and July (TCOAAJ)
- The Coffin of Andy and Lili
- The Lost Coffin of Andrew and Ashley (TLCOAAA)
- The Dubbing Of Andy And Leyley (TDOAAL): Chapter 1 voice acting
- Side Dishes: extra content for episode 1
- Mod of Extension: more branches, CGs, sprites and maps
- The Coffin of Andy and Catley

**Translations:** Chinese, French, German, Hungarian, Italian, Japanese, Korean, Polish, Brazilian Portuguese, Russian, Castilian Spanish, Mexican Spanish, Turkish, Ukrainian (base game), plus partial translations for several overhauls.

## License

AGPLv3; see [LICENSE](LICENSE). No telemetry, no ads, no tracking.

No money is made from this project: nothing is sold, no donations are asked for
or accepted, and there is no advertising, sponsorship or affiliate link. It is
hosted on the free tiers of GitHub Pages and Cloudflare, so it costs nothing to
run either.

No game files are distributed with this project: you import your own copy, and it
stays on your device. See [NOTICE](NOTICE.md), also served from the site itself
at [tcoaal.app/notice.html](https://tcoaal.app/notice.html), for the full purpose
and design, and for rights holder contact.

## Credits

Created by Kidev as a fan tool for the community.

Some assets, theme and inspiration by **Nemlei**

Faustina font by Google.

[pako](https://github.com/nodeca/pako) by nodeca.

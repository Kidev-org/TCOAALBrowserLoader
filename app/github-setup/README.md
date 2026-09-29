# Releasing this mod from GitHub

This folder and `.github/workflows/release.yml` came from the mod creator page
as its "GitHub setup". Together they let GitHub build and publish the mod:
every run makes the `.tcoaalmod`, stamps the installers and puts them all in a
GitHub Release.

## Set up

Your repository holds your modded game as it runs: the folder with `www/` in
it (or `www` itself). Put `.github/` and `.config/` at its root:

```
.github/workflows/release.yml   the release workflow
.config/mod.json                what your mod is (filled in from the page)
.config/base-index.json         what the game already has (see below)
.config/icon.png                the mod's icon, if you picked one
.config/theme/                  the installer's page from the Customize screen
www/                            your modded game's www folder
```

Only what your mod adds or changes goes into the package. Every file that is
still the game's own is recognised (through `base-index.json`) and left out:
players use their own copy. A game file you renamed or reused is referenced,
not carried. The game's copyright notices are never packaged.

At the root, what belongs to the repository is never packaged either: dot
folders (`.config`, `.github`, `.git`), `README`, `LICENSE`, `CHANGELOG` and
`.md` files.

## .config/mod.json

| Field         | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `id`          | Lowercase letters, digits and dashes, 3 to 40 characters. Never change it. Empty: made from the repository's name. |
| `name`        | The mod's name, up to 60 characters. Empty: the repository's name.           |
| `author`      | Empty: the repository's owner.                                               |
| `description` | Up to 500 characters. Empty: the repository's description.                   |
| `game`        | The game version the mod is made for, such as `3.0.13`.                      |
| `content`     | Where to look for your files, as a path from the repository root. Empty (the default) is the root. The folder it names is used when it is laid out like the game's `www` folder, or its `www/` subfolder when it has one. |
| `thumbnail`   | The picture the TCOAAL Mod Loader shows for your mod in its "Available online" list: a path in your `www` folder (default `img/titles1/Book.png`, the title art), a path from the repository root starting with `/`, or an `https://` link. Also the mod's icon when `.config/icon.png` is missing. |
| `saves`       | `isolated`: the mod keeps its own saves. `shared`: the game's.               |
| `plugins`     | Extra features to ship, by name: `MouseControl`, `ImprovedLoader`, `VirtualController`, `InteractGlint`, `SeamlessMaps`, `UnlockAll`, `SAN_AnalogMove`, `YEP_X_MessageBacklog`. Needs your own `js/plugins.js` in `www/`. |
| `updates`     | `false` to stop installers from checking this repository for new versions.   |

The version is not in this file: it is the release's tag. Where the mod is
published is not in it either: the workflow uses the repository it runs in.

## .config/base-index.json

GitHub never has the game, so this file tells it what the game already holds:
for every game file, a fingerprint (a hash) of its content, and nothing of the
game itself. The page wrote it from the game you imported there. If you move
the mod to another game version, download the GitHub setup again from that version
and replace this file (and `game` in `mod.json` with it).

## Releasing

Actions tab -> **Release** -> **Run workflow**, then pick:

- **bump**: `patch`, `minor` or `major`. The newest `vX.Y.Z` tag is bumped
  (`v1.4.2` -> `v1.4.3`, `v1.5.0` or `v2.0.0`); with no tag yet you get
  `v0.0.1`, `v0.1.0` or `v1.0.0`.
- **offline**: installers with the mod inside.
- **online**: small installers that download the newest release of this
  repository when the player installs.
- **windows**, **linux**: which systems to make installers for (macOS is not
  offered for now).

The release holds the `.tcoaalmod` (players can also add it from the Mods menu
of the browser player) and one installer per system and kind, named
`<id>-<version>-<offline|online>-<system>`. The commit the workflow ran on is
tagged; nothing is tagged if the build fails.

Online installers find the mod through this repository's latest release, so
keep the repository public and do not delete the `.tcoaalmod` from a release.

## Limits

GitHub cannot turn an edited data file into a small patch the way the mod
creator page does (that needs the game's own bytes): an edited map or database
file is shipped whole. Files you did not change never are.

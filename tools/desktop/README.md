# TCOAAL Mod Installer (`tools/desktop/user`)

A small cross-platform desktop app (Tauri v2) that installs `.tcoaalmod`
packages beside a copy of the game and plays them, **without ever writing to
the game itself**. It does not reimplement anything: it carries a Node runtime
plus `tools/mod-loader.js` and the `app/js/libs/` modules that tool needs, and
shells out to Node.

It is also the **stub** `app/create.html` stamps. A modder builds their mod in
create.html and presses one of the three platform buttons; the page attaches
the `.tcoaalmod` to a copy of this binary (an appended trailer on Windows and
Linux, a bundle resource on macOS) and renames and re-icons it. The result is
one double-clickable installer for that one mod. Un-stamped, the same binary is
the generic loader and asks for a mod file.

## What the player sees

**The mod's own page.** A `.tcoaalmod` carries the theme its author designed in
create.html (`theme/index.html` plus its CSS and JS), and the app renders that
theme and answers the calls it makes. `ui/index.html` is not a UI in front of
the theme: it is the API those calls land on, plus a built-in theme (the same
screen create.html shows under its "Slate" preset) for a mod that ships none.

So the app is one screen with one button. It finds the game on its own (the
folder used last, then Steam's own app manifest, then a scan of every library),
the player presses Install and then Play, and the window wears the mod's name
and icon.

Two rules make the theme contract work:

- Every API name is a plain global (`FindGame`, `InstallSteam`, `LaunchGame`,
  ...), listed in create.html under the theme editor and stubbed in its live
  preview, so a theme that worked in the preview works here unchanged.
- The shell keeps ALL of its own declarations inside one function. A theme is
  arbitrary top-level script; a `const` here and a `var` of the same name there
  are a SyntaxError that would kill the theme's script before its first line.

`.github/workflows/deploy-stubs.yml` builds the three stubs and publishes them
to `/stub/` (plus `stubs.json`) for create.html to fetch.

The **creator** app (project extraction, mod authoring) is not here. It
drives `extract-project.js`, which this repo does not ship; it lives in the
local-only `.modding/tools/desktop/creator` and depends on this workspace's
`core` crate by path. See `.modding/README.md`.

## Why the binary carries everything

A stub is handed to a player as ONE file, so everything it runs has to be
inside it. Tauri's `resources` cannot do that on Windows, where bundled
resources are installed *next to* the exe by the NSIS/MSI installer and a bare
copied `.exe` finds nothing. So:

- `src-tauri/build.rs` gzips `src-tauri/runtime/node` (staged by CI, or by
  `.modding/tools/build.sh`, right before the build) into the binary, and sets
  the `embedded_runtime` cfg. Without a staged runtime it builds a dev binary
  instead, which is what makes `cargo check` and `tauri dev` work in a fresh
  checkout.
- `src-tauri/src/main.rs` embeds `tools/mod-loader.js`, `tools/mod-apply.js`,
  `tools/tcoaal-versions.json` and the four `app/js/libs/` modules as text
  (`TOOL_FILES`), and on first launch unpacks all of it into a versioned cache
  directory that then serves as `core::run_tool`'s resource dir.

`<stub> --selftest [--report <file>]` unpacks that directory, runs both tools
through the unpacked Node, reads back any stamped mod, and exits without
opening a window, so CI can prove a built stub actually installs, on a
headless runner. It writes its report to `--report` as well as stdout because
the Windows release build has no console attached and a caller capturing its
stdout would get nothing.

The macOS stub is arm64 only: it embeds the build runner's own Node, so a
universal binary would need a universal Node to go with it.

## Install, play, uninstall

`tools/mod-loader.js` owns all of it (see its header for the full layout). The
game folder gains exactly one directory, and loses it again on uninstall:

```
<game>/
  www/  Game.exe  package.json  locales/     <- Steam's, never written to
  addons/
    state.json           enabled mods and their load order
    <mod-id>/            the package, its manifest, icon and theme
    .profile/            the tree the game is actually launched from
```

- **Install** unpacks the package into `addons/<id>/` and rebuilds the profile.
- **The profile** is a mirror of the whole game folder built out of hardlinks,
  so it costs no disk space and contains no copy of the game's content. Each
  enabled mod is then applied into it in load order, always by REMOVING the
  mirrored entry and creating a new file, never by writing through the link,
  which would write into the player's original. That one rule is what keeps the
  Steam copy pristine, so `tools/test-mod-loader.js` asserts it by inode, not
  by bytes: a write through a link leaves the two identical.
- **Play** launches the executable inside the profile. The profile is a
  complete game root, `package.json` and all, so NW.js resolves `main` next to
  that binary and loads the profile's `www`. Nothing is passed on the command
  line. On Linux, where a Steam copy is the Windows build, it runs through the
  same Proton and the same prefix Steam uses (`core::find_proton`), so the
  player's settings and saves are the ones the modded game sees.
- **Uninstall** removes the mod, rebuilds the profile, and takes `addons/` with
  it when the last mod goes.
- Several mods coexist; load order decides who wins, and a `patch` entry is
  applied to whatever the mods before it left.
- `mod-apply.js` (the older in-place installer: overwrite the game, keep
  `.tcoaalmod-rollback.zip`) is still carried for ONE job: putting back a game
  that installer already modified. The loader refuses to build a profile over
  one, and the UI offers `RestoreOriginal()`.

## Finding the game

`core::find_game` answers "where is it?" without asking the player: the folder
they used last (remembered in `<shared-data>/game-path.txt`), then Steam's own
`appmanifest_2378900.acf` `installdir`, then a scan of every library's
`common/` matched by SHAPE (a folder holding `www/data`) so a renamed or
hand-copied install is still found. `TCOAAL_GAME` overrides all of it, which is
how the app is driven in a test. The folder picker exists for the copy none of
that can find, and what it picks is remembered.

Both game layouts are understood: `www/` beside the executable, and the macOS
bundle where the same tree sits inside the `.app`.

## Steam version downloader (core only)

This app no longer has a downloader UI: a player installs a mod, they do not
pick depot manifests. The logic below still lives in `core/src/lib.rs` and is
what the local-only creator app uses; it is documented here because that is
where the code is.

It detects the Steam install per-OS, opens the Steam client
console and puts `download_depot 2378900 2378901 <manifest>` on the clipboard
for the user to paste (TCOAAL is paid, so the download must use the owning
account's logged-in client; `download_depot` is a Steam *console* command, there
is no steam:// URL for it and anonymous SteamCMD cannot fetch a paid depot).
Clicking **Download** opens the console, copies the command, and immediately
starts waiting: the user only pastes + Enter, and the version is archived
automatically when the download stops changing. The watcher scans the depot
folder under every detected Steam root
(`<root>[/ubuntu12_32]/steamapps/content/app_2378900/depot_2378901/`, covering
native/flatpak/snap/symlinked-runtime installs) and **moves it into shared app
storage** (`tcoaal-mods/versions/<key>/`) so a later Steam update cannot
overwrite it.

Historical depot manifest IDs are not in any public Steam Web API (that is
SteamDB's archived data), so the version list lives in
**`tools/tcoaal-versions.json`**, maintained by
**`tools/update-game-manifest-ids.js`**. The catalog has three layers, freshest
first: a manual **Refresh from GitHub** (`steam_refresh` -> `refresh_catalog`,
which pulls the maintained file from `raw.githubusercontent.com` and merges in
the installed game + archived versions), the **installed game** (manifest +
build id from `appmanifest_2378900.acf`, plus the latest available build parsed
out of the Steam client's `appcache/appinfo.vdf`), and the **bundled** copy. The
merged result is cached at `<shared-data>/tcoaal-versions.json`. Everything but
that one button works offline. A mod's variants embed the Steam manifest of each
base build they support, so `mod_info` can offer a one-click download of a
supported version even with no catalog at all.

## Layout

```
tools/
  mod-loader.js         install beside the game + build the play profile (the tool this runs)
  mod-apply.js          the older in-place apply/rollback, kept to undo its own installs
  test-mod-loader.js    installs, plays and uninstalls against a synthetic game
  test-mod-apply.js     round-trips mod-apply against a synthetic game
  test-stub-stamp.js    stamps a mod into a built stub and runs it (CI)
  desktop/
    Cargo.toml          workspace (core + user/src-tauri)
    core/               shared Rust: locate the bundled Node + run a tool, Steam
    user/
      package.json      @tauri-apps/cli
      ui/index.html     frontend (loader.html-styled, static)
      src-tauri/        Tauri app (Cargo.toml, build.rs, tauri.conf.json, src/)
```

## Build prerequisites

- Rust (stable) and the platform's Tauri deps (on Arch:
  `webkit2gtk-4.1 base-devel librsvg libappindicator-gtk3`; on Debian/Ubuntu:
  `libwebkit2gtk-4.1-dev librsvg2-dev libgtk-3-dev patchelf`).
- Node.js (for `@tauri-apps/cli`, and as the runtime that gets embedded).

## Build by hand

```bash
cd tools/desktop/user
npm install                                    # @tauri-apps/cli (once)
mkdir -p src-tauri/runtime && cp "$(command -v node)" src-tauri/runtime/node
export APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true
npx @tauri-apps/cli build                      # -> tools/desktop/target/release/
node ../../test-stub-stamp.js ../../desktop/target/release/tcoaal-mod-installer
```

The last line is the check worth running: it stamps a real mod into what you
just built and confirms the result installs it.

## Fast iteration with `tauri dev`

A dev build has no embedded runtime, so point it at the repo and your own Node
(`TCOAAL_RES_DIR` also disables the staged-resources path). `TCOAAL_GAME` aims
it at a throwaway copy of a game, and `--payload` stands in for a stamped mod,
so the whole player flow is reachable without building an installer:

```bash
cd tools/desktop/user
TCOAAL_RES_DIR="$(git rev-parse --show-toplevel)" \
TCOAAL_NODE="$(command -v node)" \
TCOAAL_GAME="/path/to/a/copy/of/the/game" \
  npm run dev -- --payload /path/to/some.tcoaalmod
```

## CI

`.github/workflows/deploy-stubs.yml` builds the three stubs (Windows exe, macOS
`.app` zipped, Linux AppImage), stamps the release version into the bundle,
stages the runner's own Node as the embedded runtime, proves each stub installs
a mod stamped into it, and publishes them plus `stubs.json` as the assets of the
`stub/v<version>` GitHub Release. A release rather than a branch because the
Linux AppImage is over the 100 MB per-file limit git on github.com enforces;
release assets take 2 GB. `deploy-web.yml` downloads that set into the deployed
site at `/stub/` (hash-checking each asset against `stubs.json` first), and
`release.yml` runs both in order for one version.

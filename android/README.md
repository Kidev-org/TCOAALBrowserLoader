# TCOAAL Player: Android

Author: kidev

A thin native Android wrapper that runs https://tcoaal.app inside a `WebView`.
Saves live in the app's private sandbox (never evicted by browser storage pressure),
and are mirrored to a small native file that rides **Android Auto Backup**, surviving
factory resets and phone migrations.

## Prerequisites

| Tool | Version | Notes |
| ---- | ------- | ----- |
| JDK | 17 | Must be on `JAVA_HOME` or the active JDK |
| Android SDK | API 34 | `android-34` platform must be installed |
| `./gradlew` | Gradle 8.13 (bundled) | Never run the system `gradle` command |

The Gradle wrapper (`gradlew` + `gradle/wrapper/gradle-wrapper.jar`) is committed
to this repo. No system Gradle installation is needed or used. If you have a system
Gradle on `PATH`, ignore it; all commands here go through `./gradlew`.

## First-time setup

1. Set `ANDROID_HOME` (or `local.properties`) to your SDK path, e.g.
   ```
   echo "sdk.dir=$HOME/Android/Sdk" > android/local.properties
   ```
2. That's it. The wrapper downloads Gradle 8.13 from the Gradle CDN on first use
   (cached in `~/.gradle/`; subsequent builds are offline-capable).

## Building

All commands run from the `android/` directory.

```bash
# Debug APK (unsigned, for local testing)
./gradlew assembleDebug

# Install on a connected device or running emulator
./gradlew installDebug

# Release APK (signed when CI env vars are set; see Signing below)
./gradlew assembleRelease
```

The debug APK is at `app/build/outputs/apk/debug/app-debug.apk`.

## First launch on device

1. App opens to `tcoaal.app` in the WebView.
2. Tap the import button and select your game's `www/` folder as a **.zip**.
   - Folder import (`webkitdirectory`) is desktop-only; Android WebView's file
     chooser does not support it. Pack the `www/` folder into a zip first.
3. The game loads and runs fully from the WebView sandbox.
4. Saves are automatically exported to native storage once per minute and on
   pause, and restored on next launch.

## Running tests

```bash
# Unit tests: no device needed (URL policy, save-mirror file store)
./gradlew test

# Instrumented smoke test: requires a connected device or emulator
# Proves: service worker registers, intercepts a fetch, and IndexedDB persists
# on the real WebView of the target device. Run this before shipping.
./gradlew connectedDebugAndroidTest
```

The instrumented test (`ServiceWorkerSmokeTest`) is the confidence gate for the
entire architecture: the asset-decryption pipeline depends on the WebView
honouring a page-registered service worker's fetch handler. If it passes, the
app will work on that device.

## Signing a release build

Release signing is driven by environment variables. Set these before running
`assembleRelease`:

```bash
export KEYSTORE_FILE=/path/to/release.jks
export KEYSTORE_PASSWORD=...
export KEY_ALIAS=...
export KEY_PASSWORD=...
./gradlew assembleRelease
```

Without these variables the release variant builds unsigned (safe for local
testing; not installable from Play Store). CI sets them from GitHub Actions
secrets automatically.

## App icon and splash screen

Icons are generated from `app/img/icon-512.png` at all mipmap densities
(mdpi -> xxxhdpi). On API 26+ Android uses the adaptive icon with a black
background and the icon centred in the safe zone. The splash screen (via
`core-splashscreen`) shows the same icon on a black background before the
WebView finishes loading.

To regenerate icons after changing the source image, from the repo root:

```bash
SRC="app/img/icon-512.png"
OUT="android/app/src/main/res"
for spec in "48 108 72 mdpi" "72 162 108 hdpi" "96 216 144 xhdpi" "144 324 216 xxhdpi" "192 432 288 xxxhdpi"; do
    read L C S D <<< "$spec"
    magick "$SRC" -resize ${L}x${L} -background "#000000" -alpha remove $OUT/mipmap-$D/ic_launcher.png
    HALF=$((L/2))
    magick \( "$SRC" -resize ${L}x${L} \) \( -size ${L}x${L} xc:none -fill white -draw "circle ${HALF},${HALF} ${HALF},0" \) -compose dst-in -composite -background "#000000" -flatten $OUT/mipmap-$D/ic_launcher_round.png
    magick "$SRC" -resize ${S}x${S} -background none -gravity center -extent ${C}x${C} $OUT/mipmap-$D/ic_launcher_foreground.png
done
```

Requires ImageMagick 7 (`magick` command).

## Architecture notes

### Save durability

| Threat | Plain PWA | This app |
| ------ | --------- | -------- |
| Storage pressure / ITP eviction | Can wipe IndexedDB | Sandbox, not evictable |
| Clear browser data | Wipes it | Untouched (separate from Chrome) |
| Factory reset / new phone | Lost | Restored via Auto Backup |

Game assets (hundreds of MB) are excluded from Auto Backup; they exceed the
25 MB cap and are re-importable from the user's own zip. Only `save-backup.json`
is backed up. A `@JavascriptInterface` bridge (`AndroidSaveBridge`) handles the
export/restore because the three IDB databases (`tcoaal`, `tcoaal-saves`,
`tcoaal-translations`) share one origin directory and can't be file-granularly
targeted by backup rules.

### Components

- `MainActivity.kt`: WebView host: service workers, external link routing, file
  chooser for zip import, splash screen, save mirror scheduling.
- `SaveStore.kt`: atomic read/write of `filesDir/save-backup.json`. Pure
  `java.io`, unit-tested.
- `SaveBridge.kt`: `@JavascriptInterface` exposed as `window.AndroidSaveBridge`.
- `assets/save-sync.js`: injected after each page load; exports live saves and
  restores the backed-up snapshot into `localStorage` + `tcoaal-saves` IDB.
- `res/xml/backup_rules.xml` + `data_extraction_rules.xml`: allowlist Auto
  Backup to `save-backup.json` only.

## Known constraints

- **Folder import is desktop-only.** Use a zip on mobile.
- **Auto Backup requires Google backup enabled** on the device, runs on Google's
  schedule (roughly daily, on wifi + charging + idle), capped at 25 MB.
- **iOS is not covered.** WKWebView storage is WebKit-managed and App Store review
  friction makes plain WebView wrappers impractical. This story is Android-only.
- **Do not run the system `gradle` command.** It will fail if your system Gradle
  is 9.6+ (which removed internal APIs that AGP 8.x relies on). Always use
  `./gradlew` from the `android/` directory.

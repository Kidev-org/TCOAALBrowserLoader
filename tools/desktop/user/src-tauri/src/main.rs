// SPDX-License-Identifier: AGPL-3.0-or-later
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//
// TCOAAL Mod Installer / Loader.
//
// What the player sees is the MOD'S OWN PAGE: a stamped installer carries the
// theme its author designed in app/create.html, and this app renders it and
// answers the calls it makes (FindGame, InstallMod, LaunchGame, ...). The
// window is one screen with one obvious button, not a tabbed tool: the player
// opens it, it finds their game on its own, they press Install and then Play.
//
// What it does NOT do is write to their game. Every file it creates lives in
// <game>/addons/, and the game is played out of a hardlinked profile built
// there (tools/mod-loader.js owns that; see its header for the layout and the
// unlink-before-write invariant). The old in-place installer, which overwrote
// the game and kept a rollback zip, is still reachable for exactly one purpose:
// putting back a game that installer already modified.
//
// This binary is also the STUB app/create.html stamps: a modder builds their
// .tcoaalmod there and presses one of the three platform buttons, which
// attaches the mod to a copy of this app and renames and re-icons it. A
// stamped copy starts up already carrying its mod, so the player never picks a
// file. Un-stamped, the same binary is the generic loader and asks for one.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tcoaal_desktop_core::{
    find_game, find_protons, no_console, resolve_resource_dir, run_tool, run_tool_streaming,
    shared_data_dir, GameLocation, ToolResult, TCOAAL_APPID,
};

/// The bundle identifier, which is also the name of every per-app directory
/// the OS gives us. Must match `identifier` in tauri.conf.json: housekeeping
/// runs before the Tauri context exists and so cannot read it from there.
const APP_ID: &str = "app.tcoaal.modinstaller";

/// Installs and plays a mod without ever writing inside the game folder.
const LOADER_TOOL: &str = "mod-loader.js";

/// The older in-place installer. Kept for one job only: undoing an install it
/// made before this app stopped touching the game.
const APPLY_TOOL: &str = "mod-apply.js";

/// Trailer magic written by app/js/libs/stub-stamp.js. Layout, Windows and
/// Linux: [stub][payload][u64 LE payload length][magic].
const TRAILER_MAGIC: &[u8; 8] = b"TCOAALPK";

/// Name of the payload inside a stamped macOS bundle. Appending to a Mach-O
/// would invalidate its signature, so the mac path ships the payload as a
/// bundle resource instead, which is exactly this app's resource dir.
const BUNDLE_PAYLOAD: &str = "payload.tcoaalmod";

/// Hard ceiling on an embedded payload, so a corrupt or hostile length field
/// in the trailer cannot make us allocate the world before we ever look at
/// the bytes. A .tcoaalmod is a diff: a large one is tens of megabytes.
const MAX_PAYLOAD: u64 = 2 * 1024 * 1024 * 1024;

/// Theme assets are inlined into the page as data: URLs, so a theme that ships
/// a video instead of a background image is refused rather than pushed through
/// the IPC channel.
const MAX_THEME_FILE: u64 = 16 * 1024 * 1024;

// ===========================================================================
// Self-contained resources
//
// A stub is ONE file the player double-clicks, with no installer and nothing
// beside it, so everything it runs travels inside the binary and is unpacked on
// first launch into a versioned cache directory. Tauri's `resources` are not
// usable for this: on Windows they are installed next to the exe by the
// NSIS/MSI installer, and a bare .exe copied anywhere else finds nothing.
//
// The scripts are embedded as text (a handful of KB). The Node runtime is
// embedded gzipped by build.rs, and only when it was staged: a plain
// `cargo check` or `tauri dev` in a fresh checkout builds without it and
// falls back to TCOAAL_RES_DIR + TCOAAL_NODE, the documented dev flow.
// ===========================================================================

/// Every file `run_tool` needs, laid out under the staging dir exactly as it
/// is in the repo (tools/ next to app/js/libs/) because the tools resolve
/// their libraries by that relative path.
#[cfg_attr(not(embedded_runtime), allow(dead_code))]
const TOOL_FILES: &[(&str, &str)] = &[
    (
        "tools/mod-loader.js",
        include_str!("../../../../mod-loader.js"),
    ),
    ("tools/mod-apply.js", include_str!("../../../../mod-apply.js")),
    (
        "tools/tcoaal-versions.json",
        include_str!("../../../../tcoaal-versions.json"),
    ),
    (
        "app/js/libs/tcoaal-codec.js",
        include_str!("../../../../../app/js/libs/tcoaal-codec.js"),
    ),
    (
        "app/js/libs/json-diff.js",
        include_str!("../../../../../app/js/libs/json-diff.js"),
    ),
    (
        "app/js/libs/mod-package.js",
        include_str!("../../../../../app/js/libs/mod-package.js"),
    ),
    (
        "app/js/libs/mod-diff-worker.js",
        include_str!("../../../../../app/js/libs/mod-diff-worker.js"),
    ),
];

#[cfg(embedded_runtime)]
const NODE_GZ: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/node.gz"));

#[cfg(embedded_runtime)]
fn node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// FNV-1a, for naming a cache directory after the bytes that produced it.
/// Not a security boundary and not a dependency worth taking: nothing here
/// defends against a chosen collision, it only has to change when the content
/// does.
fn digest(parts: &[&[u8]]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in *part {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// What this build unpacks, as one name.
///
/// It must cover the CONTENT of everything that gets staged, not just the
/// version number. Keying it on the crate version and the runtime's size (all
/// it used to be) meant a rebuild that fixed a bug in tools/mod-loader.js
/// produced the same directory name, found a `.ready` marker from the previous
/// build, and went on running the OLD script - forever, since neither the
/// version nor the runtime had changed. A player, or a developer, then has an
/// installer whose behaviour is a month behind its binary with nothing to
/// suggest it.
fn build_id() -> String {
    let mut parts: Vec<&[u8]> = vec![env!("CARGO_PKG_VERSION").as_bytes()];
    for (rel, body) in TOOL_FILES {
        parts.push(rel.as_bytes());
        parts.push(body.as_bytes());
    }
    #[cfg(embedded_runtime)]
    parts.push(NODE_GZ);
    digest(&parts)
}

/// The staging directory name for this build.
fn res_dir_name() -> String {
    format!("res-{}-{}", env!("CARGO_PKG_VERSION"), build_id())
}

/// Unpack the embedded resources under `parent`, into a directory named for
/// this build. Written to a scratch name and renamed into place, so a half
/// written staging directory is never visible, including to a second copy of
/// the app racing this one, which simply adopts whichever rename won.
#[cfg(embedded_runtime)]
fn stage_resources(parent: &Path) -> Result<PathBuf, String> {
    let stamp = res_dir_name();
    let dir = parent.join(&stamp);
    let ready = dir.join(".ready");
    if ready.is_file() {
        return Ok(dir);
    }

    let tmp = parent.join(format!("{stamp}.tmp{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| format!("Cannot create {}: {e}", tmp.display()))?;

    for (rel, body) in TOOL_FILES {
        let abs = tmp.join(rel);
        if let Some(p) = abs.parent() {
            fs::create_dir_all(p).map_err(|e| format!("Cannot create {}: {e}", p.display()))?;
        }
        fs::write(&abs, body).map_err(|e| format!("Cannot write {}: {e}", abs.display()))?;
    }

    let runtime = tmp.join("runtime");
    fs::create_dir_all(&runtime).map_err(|e| format!("Cannot create {}: {e}", runtime.display()))?;
    let node = runtime.join(node_name());
    let mut out =
        fs::File::create(&node).map_err(|e| format!("Cannot write {}: {e}", node.display()))?;
    let mut gz = flate2::read::GzDecoder::new(NODE_GZ);
    std::io::copy(&mut gz, &mut out).map_err(|e| format!("Cannot unpack the Node runtime: {e}"))?;
    drop(out); // fs::File is unbuffered: closing it is the flush.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Cannot make the Node runtime executable: {e}"))?;
    }

    fs::write(tmp.join(".ready"), b"1").map_err(|e| e.to_string())?;
    match fs::rename(&tmp, &dir) {
        Ok(()) => Ok(dir),
        // Another copy of the app staged it first (or a stale directory is in
        // the way): use whatever is there if it is complete, else report the
        // real failure rather than running against a half-written dir.
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            if ready.is_file() {
                Ok(dir)
            } else {
                Err(format!("Cannot stage the installer's runtime: {e}"))
            }
        }
    }
}

/// This app's own cache directory, and everything in it is ours to delete.
/// Resolved through core rather than the AppHandle so that housekeeping, which
/// runs before there is one, cannot pick a different directory than staging.
fn cache_dir() -> PathBuf {
    tcoaal_desktop_core::app_cache_dir(APP_ID)
}

/// Throw away what an older build left behind, before anything can read it.
///
/// Everything this app unpacks locally is derived: the staged Node runtime and
/// tools, and the mod unpacked out of its own binary. None of it is the
/// player's, all of it is reproducible in seconds, and a stale copy of any of
/// it is an installer that behaves like the build it came from rather than the
/// one they are running. So a build whose identity has changed - a new
/// version, an edited tool script, a different stamped mod - starts by
/// removing all of it, and every run prunes whatever does not belong to it.
///
/// The webview's own storage goes with it. That directory is a cache of the
/// page this binary serves plus one remembered mute toggle, and an update that
/// resets a mute toggle costs a player less than one that leaves them looking
/// at the previous version's screen.
///
/// Must run before the Tauri builder: the webview opens its storage on
/// startup, and a directory deleted underneath it is worse than a stale one.
fn housekeeping() {
    let dir = cache_dir();
    let marker = dir.join("build-id.txt");
    let want = format!(
        "{} {} {}\n",
        env!("CARGO_PKG_VERSION"),
        build_id(),
        payload_id().unwrap_or_else(|| "none".into())
    );
    let have = fs::read_to_string(&marker).unwrap_or_default();

    if have != want {
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(tcoaal_desktop_core::app_local_data_dir(APP_ID));
        if fs::create_dir_all(&dir).is_ok() {
            let _ = fs::write(&marker, &want);
        }
        return;
    }

    // Same build, but another one may have run here since (a player keeping
    // two stamped installers, or a developer alternating between builds), and
    // its staging directory is a Node runtime worth a hundred megabytes.
    let keep_res = res_dir_name();
    let keep_mod = self_mod_dir_name();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = name.starts_with("res-") || name.starts_with("self-mod");
        if ours && name != keep_res && name != keep_mod {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Stage into `parent` once per process, whatever the caller.
#[cfg(embedded_runtime)]
fn staged_resource_dir(parent: PathBuf) -> Result<PathBuf, String> {
    static STAGED: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    STAGED
        .get_or_init(|| {
            fs::create_dir_all(&parent)
                .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
            stage_resources(&parent)
        })
        .clone()
}

/// Where the bundled tools live for this run. A release build stages its own
/// embedded copy; a dev build falls back to the Tauri resource dir (and thus
/// to TCOAAL_RES_DIR).
fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(embedded_runtime)]
    if std::env::var_os("TCOAAL_RES_DIR").is_none() {
        return staged_resource_dir(cache_dir());
    }

    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {e}"))?;
    Ok(resolve_resource_dir(bundled))
}

// ===========================================================================
// Embedded mod payload (stamped stubs)
// ===========================================================================

/// Read the trailer of `file`, if it carries one. Seeks rather than reading
/// the whole binary: the Linux stub is a large AppImage and this runs on every
/// launch.
fn read_trailer(file: &Path) -> Option<Vec<u8>> {
    let mut f = fs::File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    if size < 16 {
        return None;
    }
    let mut tail = [0u8; 16];
    f.seek(SeekFrom::End(-16)).ok()?;
    f.read_exact(&mut tail).ok()?;
    if &tail[8..16] != TRAILER_MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(tail[0..8].try_into().ok()?);
    // A payload must fit strictly inside the file, before its own 16-byte
    // trailer: anything else is a coincidental magic or a corrupt download.
    if len == 0 || len > MAX_PAYLOAD || len + 16 > size {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    f.seek(SeekFrom::Start(size - 16 - len)).ok()?;
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// `<name>.app/Contents/Resources/payload.tcoaalmod`, derived from the running
/// binary rather than from Tauri. `--selftest` runs before the Tauri builder
/// (it must never open a window), so there is no AppHandle to ask, and on
/// macOS the trailer fallback cannot stand in, because the mac stamp is a
/// bundle resource, not a trailer. Returns `None` off any path that is not
/// `.../Contents/MacOS/<binary>`.
fn bundle_payload_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    Some(macos.parent()?.join("Resources").join(BUNDLE_PAYLOAD))
}

/// The stamped payload, in the order the format spec fixes: an explicit
/// `--payload <file>` argument, then the macOS bundle resource, then the
/// Windows/Linux trailer. `None` means this is an un-stamped generic build.
fn embedded_payload(app: Option<&AppHandle>) -> Option<Vec<u8>> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--payload" {
            if let Some(p) = args.next() {
                return fs::read(p).ok();
            }
        }
    }

    // The BUNDLED resource dir, not resolve_resource_dir(): TCOAAL_RES_DIR is
    // a dev override pointing at the repo checkout, which never holds a
    // stamped payload.
    let bundle = app
        .and_then(|a| a.path().resource_dir().ok())
        .map(|dir| dir.join(BUNDLE_PAYLOAD))
        .or_else(bundle_payload_path);
    if let Some(p) = bundle {
        if p.is_file() {
            if let Ok(bytes) = fs::read(&p) {
                return Some(bytes);
            }
        }
    }

    // Inside an AppImage, current_exe() is the extracted mount, not the
    // .AppImage the payload is appended to. APPIMAGE holds that path.
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())?;
    read_trailer(&exe)
}

/// A cheap fingerprint of the stamped payload, for naming what is unpacked
/// from it.
///
/// The whole package is not read: a .tcoaalmod is a zip that can run to
/// hundreds of megabytes and this decides whether to open a window. Its length
/// plus its last 64KB is enough, because the end of a zip is its central
/// directory, which carries the name, size and CRC of every entry: change any
/// file in the mod and this changes. `None` for an un-stamped build.
fn payload_id() -> Option<String> {
    const TAIL: u64 = 64 * 1024;

    let read_tail = |path: &Path, end: u64, len: u64| -> Option<String> {
        let mut f = fs::File::open(path).ok()?;
        let take = TAIL.min(len);
        f.seek(SeekFrom::Start(end - take)).ok()?;
        let mut buf = vec![0u8; take as usize];
        f.read_exact(&mut buf).ok()?;
        Some(digest(&[&len.to_le_bytes(), &buf]))
    };

    // An explicit --payload, or the macOS bundle resource: a plain file.
    let mut args = std::env::args().skip(1);
    let explicit = loop {
        match args.next() {
            Some(a) if a == "--payload" => break args.next().map(PathBuf::from),
            Some(_) => continue,
            None => break None,
        }
    };
    if let Some(p) = explicit.or_else(bundle_payload_path) {
        if let Ok(meta) = fs::metadata(&p) {
            return read_tail(&p, meta.len(), meta.len());
        }
    }

    // The Windows/Linux trailer, at the end of our own binary.
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())?;
    let mut f = fs::File::open(&exe).ok()?;
    let size = f.metadata().ok()?.len();
    if size < 16 {
        return None;
    }
    let mut tail = [0u8; 16];
    f.seek(SeekFrom::End(-16)).ok()?;
    f.read_exact(&mut tail).ok()?;
    if &tail[8..16] != TRAILER_MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(tail[0..8].try_into().ok()?);
    if len == 0 || len > MAX_PAYLOAD || len + 16 > size {
        return None;
    }
    read_tail(&exe, size - 16, len)
}

/// The name of the directory this binary's own mod is unpacked into.
fn self_mod_dir_name() -> String {
    match payload_id() {
        Some(id) => format!("self-mod-{id}"),
        None => "self-mod-none".to_string(),
    }
}

/// Path of the embedded payload written out as a real file, since the tools
/// are Node scripts that take a path. Resolved once per run.
fn embedded_mod_file(app: Option<&AppHandle>) -> Option<PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let bytes = embedded_payload(app)?;
        let out = std::env::temp_dir().join("tcoaal-embedded-mod.tcoaalmod");
        fs::write(&out, bytes).ok()?;
        Some(out)
    })
    .clone()
}

// ===========================================================================
// Running the loader
// ===========================================================================

/// Progress lines the tools print (`@progress {...}`) are forwarded to the
/// webview under this name, where the API shim hands them to whatever callback
/// the theme registered with OnProgress().
const PROGRESS_EVENT: &str = "mod-progress";

fn tool_error(res: &ToolResult, fallback: &str) -> String {
    let msg = res.stderr.trim();
    if !msg.is_empty() {
        return msg.to_string();
    }
    let out = res.stdout.trim();
    if !out.is_empty() {
        return out.to_string();
    }
    fallback.to_string()
}

/// Run mod-loader.js and return its single `@result` object, streaming its
/// `@progress` lines to the UI on the way.
fn run_loader(app: &AppHandle, args: Vec<String>) -> Result<Value, String> {
    let dir = resource_dir(app)?;
    let mut payload: Option<Value> = None;
    let handle = app.clone();
    let res = run_tool_streaming(&dir, LOADER_TOOL, &args, |line| {
        if let Some(rest) = line.strip_prefix("@progress ") {
            if let Ok(v) = serde_json::from_str::<Value>(rest) {
                let _ = handle.emit(PROGRESS_EVENT, v);
            }
        } else if let Some(rest) = line.strip_prefix("@result ") {
            payload = serde_json::from_str::<Value>(rest).ok();
        }
    });
    if !res.success {
        return Err(tool_error(&res, "The mod loader failed."));
    }
    payload.ok_or_else(|| "The mod loader returned nothing.".to_string())
}

// ===========================================================================
// The mod this binary carries
// ===========================================================================

/// A stamped stub's own mod: unpacked once into the app cache so its manifest,
/// icon and theme are readable without opening the package again.
fn self_mod(app: &AppHandle) -> Option<(PathBuf, Value)> {
    static SELF: OnceLock<Option<(PathBuf, Value)>> = OnceLock::new();
    SELF.get_or_init(|| {
        let file = embedded_mod_file(Some(app))?;
        // Named for the payload, not just "self-mod": the same machine can
        // run several stamped installers, and an updated one carries a new
        // mod under the same app identifier. A fixed name hands the second
        // installer the first one's name, icon and theme.
        let dir = cache_dir().join(self_mod_dir_name());
        let info = run_loader(
            app,
            vec![
                "--unpack".into(),
                file.to_string_lossy().into_owned(),
                "--out".into(),
                dir.to_string_lossy().into_owned(),
            ],
        )
        .ok()?;
        Some((dir, info))
    })
    .clone()
}

fn b64(bytes: &[u8]) -> String {
    // The alphabet, three bytes at a time. A base64 dependency for one call
    // site that only ever encodes is not worth the crate.
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Every file of a theme folder as `rel -> base64`, so the page can mount it
/// with its stylesheets, scripts and images inlined. Themes are small by
/// construction (create.html packages what the modder wrote, next to the mod's
/// icon); anything oversized is skipped rather than sent.
fn read_theme(dir: &Path) -> Option<Value> {
    let root = dir.join("theme");
    if !root.join("index.html").is_file() {
        return None;
    }
    let mut out = serde_json::Map::new();
    let mut stack = vec![root.clone()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_THEME_FILE {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(rel) = path.strip_prefix(&root) else {
                continue;
            };
            out.insert(
                rel.to_string_lossy().replace('\\', "/"),
                Value::String(b64(&bytes)),
            );
        }
    }
    Some(Value::Object(out))
}

fn read_icon(dir: &Path) -> Option<String> {
    let bytes = fs::read(dir.join("icon.png")).ok()?;
    if bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    Some(format!("data:image/png;base64,{}", b64(&bytes)))
}

/// What the page needs before it can render anything: the mod this installer
/// is for (if any), its theme, and this build's version.
#[tauri::command]
async fn app_info(app: AppHandle) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some((dir, info)) = self_mod(&handle) else {
            return json!({
                "version": env!("CARGO_PKG_VERSION"),
                "mod": Value::Null,
                "theme": Value::Null,
            });
        };
        let mut m = info.clone();
        if let Some(obj) = m.as_object_mut() {
            obj.insert(
                "icon".into(),
                read_icon(&dir).map(Value::String).unwrap_or(Value::Null),
            );
        }
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "mod": m,
            "theme": read_theme(&dir),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

// ===========================================================================
// Finding the game
// ===========================================================================

/// Where the last-used game folder is remembered, so the second launch never
/// searches at all, and a player whose copy lives somewhere no detection
/// could guess picks it once, not every time.
fn saved_game_path_file() -> PathBuf {
    shared_data_dir().join("game-path.txt")
}

fn saved_game_path() -> Option<PathBuf> {
    let raw = fs::read_to_string(saved_game_path_file()).ok()?;
    let p = PathBuf::from(raw.trim());
    if tcoaal_desktop_core::is_game_dir(&p) {
        Some(p)
    } else {
        None
    }
}

fn remember_game_path(root: &Path) {
    let file = saved_game_path_file();
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(file, root.to_string_lossy().as_bytes());
}

/// mod-loader's `--status` for `root`, with how the folder was found attached.
fn status_of(app: &AppHandle, root: &Path, source: &str) -> Result<Value, String> {
    let mut v = run_loader(
        app,
        vec![
            "--status".into(),
            "--game".into(),
            root.to_string_lossy().into_owned(),
        ],
    )?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("source".into(), Value::String(source.into()));
    }
    Ok(v)
}

/// The game, found on its own: the folder the player last used, else Steam.
/// `null` when neither answers, which is the only case where the page asks the
/// player to point at it.
#[tauri::command]
async fn detect_game(app: AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = saved_game_path() {
            if let Ok(v) = status_of(&app, &p, "saved") {
                return Ok(Some(v));
            }
        }
        let Some(GameLocation { path, source, .. }) = find_game() else {
            return Ok(None);
        };
        let root = PathBuf::from(&path);
        let v = status_of(&app, &root, &source)?;
        remember_game_path(&root);
        Ok(Some(v))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The folder picker, for a copy no detection can find.
#[tauri::command]
async fn choose_game(app: AppHandle) -> Result<Option<Value>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Where is The Coffin of Andy and Leyley?")
        .blocking_pick_folder();
    let Some(folder) = picked else {
        return Ok(None);
    };
    let root = folder
        .into_path()
        .map_err(|e| format!("Cannot use that folder: {e}"))?;
    let v = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let root = root.clone();
        move || status_of(&app, &root, "picked")
    })
    .await
    .map_err(|e| e.to_string())??;
    remember_game_path(&root);
    Ok(Some(v))
}

#[tauri::command]
async fn game_status(app: AppHandle, root: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || status_of(&app, Path::new(&root), "known"))
        .await
        .map_err(|e| e.to_string())?
}

// ===========================================================================
// Installing, enabling, ordering
// ===========================================================================

/// Install a mod into `<game>/addons/` and build the play profile. With no
/// `file`, the mod this binary carries, which is the whole point of a stamped
/// installer: the player never sees a file picker.
#[tauri::command]
async fn install_mod(
    app: AppHandle,
    root: String,
    file: Option<String>,
    force: Option<bool>,
) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mod_file = match file {
            Some(f) => PathBuf::from(f),
            None => embedded_mod_file(Some(&handle))
                .ok_or_else(|| "This installer carries no mod. Open a .tcoaalmod file.".to_string())?,
        };
        let mut args = vec![
            "--install".into(),
            mod_file.to_string_lossy().into_owned(),
            "--game".into(),
            root,
        ];
        if force.unwrap_or(false) {
            args.push("--force".into());
        }
        run_loader(&handle, args)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The .tcoaalmod picker, for the un-stamped generic build.
#[tauri::command]
async fn choose_mod_file(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Pick a mod file")
        .add_filter("TCOAAL mod", &["tcoaalmod"])
        .blocking_pick_file();
    Ok(picked.map(|f| f.to_string()))
}

#[tauri::command]
async fn uninstall_mod(app: AppHandle, root: String, id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_loader(&app, vec!["--uninstall".into(), id, "--game".into(), root])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn enable_mod(app: AppHandle, root: String, id: String, on: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_loader(
            &app,
            vec![
                "--enable".into(),
                id,
                "--on".into(),
                if on { "1".into() } else { "0".into() },
                "--game".into(),
                root,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_load_order(app: AppHandle, root: String, ids: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_loader(
            &app,
            vec![
                "--order".into(),
                ids.join(","),
                "--game".into(),
                root,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_update(
    app: AppHandle,
    root: String,
    id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["--check-update".into()];
        if let Some(id) = id {
            args.push(id);
        }
        args.push("--game".into());
        args.push(root);
        run_loader(&app, args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn apply_update(app: AppHandle, root: String, id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_loader(
            &app,
            vec!["--apply-update".into(), id, "--game".into(), root],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo an install made by the OLD in-place installer, which wrote into the
/// game itself. Nothing this app does now needs it; it is here so a player
/// who used that installer can get their game back and then use this one.
#[tauri::command]
async fn restore_original(app: AppHandle, root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resource_dir(&app)?;
        let res = run_tool(&dir, APPLY_TOOL, &["--rollback".into(), root]);
        if res.success {
            Ok(res.stdout)
        } else {
            Err(tool_error(&res, "Could not restore the original files."))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===========================================================================
// Playing
// ===========================================================================

/// Build the profile if it is stale, then start the game from it.
///
/// The profile is a complete game root, so this launches the executable INSIDE
/// it: NW.js reads the package.json next to that binary, which is the
/// profile's, and loads the profile's www. Nothing is passed on the command
/// line and nothing in the player's own copy is involved.
#[tauri::command]
async fn launch_game(app: AppHandle, root: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let built = run_loader(&app, vec!["--profile".into(), "--game".into(), root.clone()])?;
        let profile = built.get("profile").cloned().unwrap_or(Value::Null);
        let exe = profile
            .get("exe")
            .and_then(|v| v.as_str())
            .map(PathBuf::from);
        // No profile (nothing enabled) means the player asked to play the game
        // they already have: start it where it lives.
        let exe = match exe {
            Some(p) if p.exists() => p,
            _ => {
                let status = status_of(&app, Path::new(&root), "known")?;
                status
                    .get("exe")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        "Could not find the game's launcher in that folder.".to_string()
                    })?
            }
        };
        spawn_game(&exe)?;
        Ok(json!({ "launched": exe.to_string_lossy(), "profile": profile }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hand a child the environment the player actually logged in with.
///
/// An AppImage splices its own library, GTK and GIO paths into this process's
/// environment, and every child inherits them. The things launched from here
/// are the player's own programs: the game is NW.js (GTK and Chromium), Proton
/// is a Python script that goes on to run wine, and the file manager is
/// whatever their desktop uses. Aiming any of those at our bundled Ubuntu
/// libraries is the same failure that makes WebKit abort on a mismatched EGL,
/// except it lands in the game instead of here. So every value rooted in
/// $APPDIR comes out, list-valued or not, and the AppImage's own markers go
/// with it: nothing downstream should believe it is inside one.
///
/// Must be called before any `env()` on the same command: it clears first.
#[cfg(target_os = "linux")]
fn clean_child_env(cmd: &mut std::process::Command) {
    let appdir = match std::env::var("APPDIR") {
        Ok(d) if !d.is_empty() => d,
        _ => return, // not running from an AppImage: the environment is theirs
    };
    let prefix = format!("{}/", appdir.trim_end_matches('/'));
    cmd.env_clear();
    for (k, v) in std::env::vars_os() {
        let key = k.to_string_lossy().into_owned();
        match key.as_str() {
            // The AppImage runtime's markers, and the two values linuxdeploy's
            // GTK hook forces on us that are not paths.
            "APPDIR" | "APPIMAGE" | "ARGV0" | "OWD" | "GTK_THEME" | "GDK_BACKEND" => continue,
            _ => {}
        }
        let val = match v.to_str() {
            // Not text we can inspect, so not a path list we spliced.
            None => {
                cmd.env(&k, &v);
                continue;
            }
            Some(s) => s,
        };
        if !val.contains(&appdir) {
            cmd.env(&k, &v);
            continue;
        }
        let kept: Vec<&str> = val
            .split(':')
            .filter(|e| *e != appdir && !e.starts_with(&prefix))
            .collect();
        // Empty means the variable existed only to point into the bundle.
        if !kept.is_empty() {
            cmd.env(&k, kept.join(":"));
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn clean_child_env(_cmd: &mut std::process::Command) {}

/// What kind of program a file is, read from its first bytes.
///
/// The extension is not enough to decide how to start the game. Steam writes
/// every depot file 0755, so a Linux copy of this game is a folder full of
/// documents that look executable next to one Windows binary, and handing the
/// wrong one to the OS is where "Exec format error (os error 8)" came from.
/// mod-loader picks the executable by the same test, and this is the second
/// half of it: whatever it picked, the bytes decide how it is launched.
#[derive(PartialEq)]
enum Program {
    /// A Windows PE ("MZ"): the game's own build, whatever it is called.
    Windows,
    /// Something this machine can execute itself (ELF, Mach-O, or a #! script).
    Native,
    /// Neither, i.e. not a program at all.
    Unknown,
}

fn program_kind(exe: &Path) -> Program {
    let mut head = [0u8; 4];
    let read = fs::File::open(exe)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    if read >= 2 && &head[..2] == b"MZ" {
        return Program::Windows;
    }
    if read >= 2 && &head[..2] == b"#!" {
        return Program::Native;
    }
    if read < 4 {
        return Program::Unknown;
    }
    if &head == b"\x7fELF" {
        return Program::Native;
    }
    match u32::from_be_bytes(head) {
        // Mach-O, either byte order, plus the universal-binary wrapper.
        0xfeed_face | 0xfeed_facf | 0xcefa_edfe | 0xcffa_edfe | 0xcafe_babe | 0xbeba_feca => {
            Program::Native
        }
        _ => Program::Unknown,
    }
}

/// The environment the game's Steam module needs to find the client.
///
/// The profile is not the copy Steam knows about, so nothing tells the process
/// which app it is and the game stops at "STEAM MODULE FAILURE". mod-loader
/// writes steam_appid.txt into the profile for the same reason; this is the
/// other half, for the launch we control.
fn steam_env(cmd: &mut std::process::Command) {
    cmd.env("SteamAppId", TCOAAL_APPID)
        .env("SteamGameId", TCOAAL_APPID);
}

/// How long a started game is watched before Play is called a success.
///
/// Spawning only says that the OS accepted the command, which is not the same
/// thing as the game running: a Proton that Steam is in the middle of updating,
/// a prefix that will not open, a launcher that exits on its own - all of them
/// spawn cleanly and are gone a moment later. Reported as success, that is a
/// Play button that says "Working..." and then nothing at all, which is
/// exactly what it looks like from the outside when nothing works. A game that
/// is still running after this has started.
const LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Wait up to `grace` for a child to exit. `None` means it is still running,
/// which for a game is the answer we want.
fn settled(
    child: &mut std::process::Child,
    grace: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            // Not knowing is not a failure: leave it running.
            Err(_) => return None,
            Ok(None) => {}
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Whatever the failed launch had to say, trimmed to something a player can be
/// shown. Proton in particular explains itself on stderr and nowhere else.
fn last_words(child: &mut std::process::Child) -> String {
    let mut out = String::new();
    for pipe in [
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read>),
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read>),
    ]
    .into_iter()
    .flatten()
    {
        let mut buf = Vec::new();
        let mut limited = pipe.take(16 * 1024);
        let _ = limited.read_to_end(&mut buf);
        out.push_str(&String::from_utf8_lossy(&buf));
    }
    let tail: Vec<&str> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .rev()
        .take(6)
        .collect();
    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// Start one prepared command and wait long enough to know it took.
fn start_and_watch(mut cmd: std::process::Command, dir: &Path) -> Result<(), String> {
    use std::process::Stdio;
    // Piped, not null: the whole point is to have something to say when a
    // launch fails. The pipes are dropped with the Child on the success path,
    // which leaves the game writing to a closed stdout - which it does not
    // read back and does not care about.
    let mut child = no_console(&mut cmd)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the game: {e}"))?;

    match settled(&mut child, LAUNCH_GRACE) {
        None => Ok(()),
        Some(status) => {
            let said = last_words(&mut child);
            // A code is only worth showing when there is one: a launcher that
            // quits cleanly reports success, and "(exit status: 0)" next to a
            // failure message reads as a contradiction.
            let code = match status.code() {
                Some(c) if c != 0 => format!(" (error {c})"),
                _ => String::new(),
            };
            let mut msg = format!(
                "The game started and closed again straight away{code}.\n\n\
                 The modded copy is ready at:\n{}",
                dir.display()
            );
            if !said.is_empty() {
                msg.push_str("\n\nIt said:\n");
                msg.push_str(&said);
            }
            Err(msg)
        }
    }
}

fn spawn_game(exe: &Path) -> Result<(), String> {
    use std::process::Command;
    let dir = exe.parent().unwrap_or(Path::new("."));
    let kind = program_kind(exe);

    if cfg!(target_os = "macos") && exe.extension().is_some_and(|e| e == "app") {
        // macOS: a .app is opened, not exec'd. `open` hands the bundle to
        // Launch Services and exits immediately, so its exit STATUS is the
        // only signal here; there is no process of ours left to watch.
        let mut cmd = Command::new("open");
        clean_child_env(&mut cmd);
        cmd.arg(exe);
        steam_env(&mut cmd);
        no_console(&mut cmd).current_dir(dir);
        let out = cmd
            .output()
            .map_err(|e| format!("Could not start the game: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        return Err(format!(
            "Could not start the game ({}).\n\nThe modded copy is ready at:\n{}\n\n{}",
            out.status,
            dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    if kind == Program::Unknown {
        return Err(format!(
            "{} is not a program this computer can start.\n\nThe modded copy is ready at:\n{}",
            exe.file_name().unwrap_or_default().to_string_lossy(),
            dir.display()
        ));
    }

    if kind == Program::Windows && !cfg!(target_os = "windows") {
        // The game is a Windows build on a Linux machine, which is what a
        // Linux player's Steam copy is. Run it through the same Proton and the
        // same prefix Steam uses, so the modded profile sees the settings and
        // the saves the player already has.
        //
        // Every installed runner is tried, best first, because the best one is
        // not always usable: Steam replaces a Proton directory in place when it
        // updates it, and a game started with one caught mid-update dies at
        // once. Only the first failure is worth reporting - it is the runner
        // the player's Steam would have used - so that is the message kept.
        let runs = find_protons(TCOAAL_APPID).unwrap_or_default();
        if runs.is_empty() {
            return Err(format!(
                "This is the Windows build of the game, and I could not find the \
                 Proton that Steam runs it with.\n\nThe modded copy is ready at:\n{}\n\n\
                 Start the game once through Steam, or add that folder's game to \
                 Steam as a non-Steam game, and Play will work from here.",
                dir.display()
            ));
        }
        let mut first_error = None;
        for run in runs {
            let mut cmd = Command::new(&run.proton);
            clean_child_env(&mut cmd);
            cmd.arg("run")
                .arg(exe)
                .env("STEAM_COMPAT_DATA_PATH", &run.compat_data)
                .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &run.steam_root)
                .env("STEAM_COMPAT_APP_ID", TCOAAL_APPID)
                .env("SteamAppId", TCOAAL_APPID)
                .env("SteamGameId", TCOAAL_APPID);
            match start_and_watch(cmd, dir) {
                Ok(()) => return Ok(()),
                Err(e) => first_error.get_or_insert(e),
            };
        }
        return Err(first_error.unwrap_or_else(|| "Could not start the game.".into()));
    }

    let mut cmd = Command::new(exe);
    clean_child_env(&mut cmd);
    steam_env(&mut cmd);
    start_and_watch(cmd, dir)
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    use std::process::Command;
    let cmd = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut c = Command::new(cmd);
    clean_child_env(&mut c);
    no_console(&mut c);
    c.arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {path}: {e}"))
}

// ===========================================================================
// The window icon
// ===========================================================================

/// Decode a PNG into the RGBA buffer a window icon is made of.
fn decode_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => {
            buf.chunks(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect()
        }
        // Palette: read_info() expands it only with EXPAND set; without a
        // palette table here there is nothing sensible to show, so keep the
        // stub's own icon.
        png::ColorType::Indexed => return None,
    };
    Some((rgba, info.width, info.height))
}

/// Wear the mod's icon: the same image the modder picked in create.html, on
/// the window itself (its title bar and the taskbar entry), not just on the
/// file they downloaded. Best-effort: a window with the stub's own icon is
/// not a failure worth reporting to anyone.
fn apply_mod_identity(app: &AppHandle) {
    let Some((dir, info)) = self_mod(app) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(name) = info.get("name").and_then(|v| v.as_str()) {
        let _ = window.set_title(name);
    }
    let Ok(bytes) = fs::read(dir.join("icon.png")) else {
        return;
    };
    if let Some((rgba, w, h)) = decode_png(&bytes) {
        let _ = window.set_icon(tauri::image::Image::new_owned(rgba, w, h));
    }
}

// ===========================================================================
// Selftest
// ===========================================================================

/// `--selftest [--report <file>]`: unpack this binary's embedded runtime and
/// run the tools through it, then exit. No window, no game folder: it answers
/// exactly one question, the one a stub cannot be shipped without: does this
/// file, on its own, still know how to install a mod? CI runs it on every
/// built stub.
///
/// The report is written to `--report <file>` as well as to stdout, because a
/// release build on Windows is a `windows_subsystem = "windows"` binary: it
/// has no console attached, so a caller capturing stdout gets nothing at all.
/// The file is how CI reads the result on every platform.
fn selftest(report: Option<PathBuf>) -> i32 {
    let mut log = String::new();
    let mut say = |line: String| {
        println!("{line}");
        log.push_str(&line);
        log.push('\n');
    };

    #[cfg(not(embedded_runtime))]
    let code = {
        say("selftest: dev build (no embedded runtime), nothing to check.".into());
        0
    };

    #[cfg(embedded_runtime)]
    let code = {
        (|| {
            let dir = match staged_resource_dir(std::env::temp_dir()) {
                Ok(d) => d,
                Err(e) => {
                    say(format!("selftest: staging failed: {e}"));
                    return 1;
                }
            };
            say(format!("selftest: staged into {}", dir.display()));

            for (tool, needle) in [(LOADER_TOOL, "--profile"), (APPLY_TOOL, "--rollback")] {
                let res = run_tool(&dir, tool, &["--help".into()]);
                if !res.success || !res.stdout.contains(needle) {
                    say(format!(
                        "selftest: the bundled {tool} did not run (code {}).\n{}\n{}",
                        res.code, res.stdout, res.stderr
                    ));
                    return 1;
                }
                say(format!("selftest: bundled Node ran tools/{tool}"));
            }

            match embedded_mod_file(None) {
                None => say("selftest: no stamped mod (this is an un-stamped stub).".into()),
                Some(f) => {
                    let out = std::env::temp_dir().join("tcoaal-selftest-mod");
                    let res = run_tool(
                        &dir,
                        LOADER_TOOL,
                        &[
                            "--unpack".into(),
                            f.to_string_lossy().into_owned(),
                            "--out".into(),
                            out.to_string_lossy().into_owned(),
                        ],
                    );
                    if !res.success {
                        say(format!(
                            "selftest: the stamped mod could not be read.\n{}",
                            res.stderr
                        ));
                        return 1;
                    }
                    say(format!(
                        "selftest: stamped mod reads back as {}",
                        res.stdout
                            .lines()
                            .find(|l| l.starts_with("@result "))
                            .unwrap_or("")
                            .trim()
                    ));
                    let _ = fs::remove_dir_all(&out);
                }
            }
            0
        })()
    };

    if code == 0 {
        say("selftest: ok".into());
    }
    if let Some(p) = report {
        let _ = fs::write(p, log);
    }
    code
}

fn main() {
    // Before Tauri: --selftest must never open a window (CI is headless).
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--selftest" {
            let report = std::env::args()
                .skip_while(|x| x != "--report")
                .nth(1)
                .map(PathBuf::from);
            std::process::exit(selftest(report));
        }
    }

    // WebKitGTK's DMABUF renderer asks for an EGL display that a great many
    // Linux setups cannot give it. A bare AppImage on a machine whose GL
    // stack does not match the one it was built against aborts outright with
    // "Could not create default EGL display: EGL_BAD_PARAMETER", before a
    // single line of this app runs. Disabling that renderer is the documented
    // way out and costs nothing here (this window is a page of text and a few
    // buttons). Set only when the user has not already chosen, and only on
    // Linux, where the variable exists at all.
    // Before the webview opens its storage: drop anything an older build of
    // this installer unpacked here.
    housekeeping();

    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // Same class of problem one layer down: a desktop-specific GTK module
        // named in the environment (Cinnamon's xapp-gtk3-module, say) is not
        // in an AppImage's bundle, and GTK complains on every start. Nothing
        // here needs any of them.
        std::env::remove_var("GTK_MODULES");
        std::env::remove_var("GTK3_MODULES");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Off the main thread: unpacking the stamped mod runs Node, and
            // the window must paint its loading state while that happens.
            let handle = app.handle().clone();
            std::thread::spawn(move || apply_mod_identity(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            detect_game,
            choose_game,
            game_status,
            install_mod,
            choose_mod_file,
            uninstall_mod,
            enable_mod,
            set_load_order,
            check_update,
            apply_update,
            restore_original,
            launch_game,
            open_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

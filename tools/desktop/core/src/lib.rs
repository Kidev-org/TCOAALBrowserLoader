// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared node-runner for the creator and user desktop apps. Each app resolves
// its Tauri resource directory (where the bundled Node runtime + the repo's
// tools/ are shipped) and calls run_tool() to execute one of the existing
// command-line tools. No tool logic is reimplemented here: the apps are thin
// GUIs over the same scripts the CLI uses.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Result of running a bundled tool. Returned to the webview as JSON.
#[derive(Serialize, Clone)]
pub struct ToolResult {
    pub success: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Dev override: if TCOAAL_RES_DIR is set, use it as the resource dir instead
/// of the app's bundled one. Lets `tauri dev` point straight at the repo
/// (which already has tools/ + app/js/libs/) without building an installer.
pub fn resolve_resource_dir(app_resource_dir: PathBuf) -> PathBuf {
    match std::env::var_os("TCOAAL_RES_DIR") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => app_resource_dir,
    }
}

/// Path to the Node binary used to run the tools. Honors a TCOAAL_NODE env
/// override (dev: point at your own `node`); otherwise the bundled
/// `runtime/node` (`runtime/node.exe` on Windows).
pub fn node_binary(resource_dir: &Path) -> PathBuf {
    if let Some(p) = std::env::var_os("TCOAAL_NODE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    resource_dir.join("runtime").join(name)
}

/// Keep a child process from opening a console window on Windows.
///
/// Everything this app runs is a command-line program: the bundled Node, the
/// shell helpers that open a folder or a URL. A GUI process that starts one of
/// those gets a console allocated for it, which is a black window that appears,
/// flashes text and vanishes, several times over an install. That reads as
/// something going wrong with the player's machine, so every Command we build
/// goes through here. CREATE_NO_WINDOW only suppresses that console; a child
/// that draws its own windows (the game, the file manager) is unaffected.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Absolute path to a bundled tool script, e.g. tool_path(dir, "share-project.js").
pub fn tool_path(resource_dir: &Path, script: &str) -> PathBuf {
    resource_dir.join("tools").join(script)
}

/// Run `node tools/<script> <args...>` from the bundled runtime, capturing
/// output. The working directory is the resource dir so the tools resolve
/// their sibling data files (tools/map-*.json) and app/js/libs the same way
/// they do in the repo.
pub fn run_tool(resource_dir: &Path, script: &str, args: &[String]) -> ToolResult {
    let node = node_binary(resource_dir);
    let script_path = tool_path(resource_dir, script);

    if !node.exists() {
        return ToolResult {
            success: false,
            code: -1,
            stdout: String::new(),
            stderr: format!(
                "Bundled Node runtime not found at {}. This build is missing its runtime.",
                node.display()
            ),
        };
    }
    if !script_path.exists() {
        return ToolResult {
            success: false,
            code: -1,
            stdout: String::new(),
            stderr: format!("Bundled tool not found: {}", script_path.display()),
        };
    }

    let mut cmd = Command::new(&node);
    no_console(&mut cmd);
    cmd.arg(&script_path);
    cmd.args(args);
    cmd.current_dir(resource_dir);

    match cmd.output() {
        Ok(out) => ToolResult {
            success: out.status.success(),
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Err(e) => ToolResult {
            success: false,
            code: -1,
            stdout: String::new(),
            stderr: format!("Failed to launch Node: {e}"),
        },
    }
}

/// Run a bundled tool, streaming its stdout line by line to `on_line` as it
/// arrives instead of only at the end.
///
/// tools/mod-loader.js reports progress on stdout while it works (mirroring a
/// game folder is thousands of files, and a player watching a frozen window
/// has no way to tell a slow install from a hung one), so the plain
/// `run_tool` above, which waits for the process to exit, cannot carry it.
/// stderr is drained on its own thread: a tool that fills the stderr pipe
/// while we are blocked reading stdout would otherwise deadlock, and the one
/// thing worse than no progress is an installer that never returns.
pub fn run_tool_streaming<F: FnMut(&str)>(
    resource_dir: &Path,
    script: &str,
    args: &[String],
    mut on_line: F,
) -> ToolResult {
    use std::io::BufRead;

    let node = node_binary(resource_dir);
    let script_path = tool_path(resource_dir, script);
    if !node.exists() {
        return ToolResult {
            success: false,
            code: -1,
            stdout: String::new(),
            stderr: format!(
                "Bundled Node runtime not found at {}. This build is missing its runtime.",
                node.display()
            ),
        };
    }
    if !script_path.exists() {
        return ToolResult {
            success: false,
            code: -1,
            stdout: String::new(),
            stderr: format!("Bundled tool not found: {}", script_path.display()),
        };
    }

    let mut spawner = Command::new(&node);
    no_console(&mut spawner);
    let mut child = match spawner
        .arg(&script_path)
        .args(args)
        .current_dir(resource_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return ToolResult {
                success: false,
                code: -1,
                stdout: String::new(),
                stderr: format!("Failed to launch Node: {e}"),
            }
        }
    };

    let err_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut p) = err_pipe {
            let _ = io::Read::read_to_string(&mut p, &mut buf);
        }
        buf
    });

    let mut stdout = String::new();
    if let Some(out) = child.stdout.take() {
        for line in io::BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            on_line(&line);
            stdout.push_str(&line);
            stdout.push('\n');
        }
    }

    let status = child.wait();
    let stderr = err_thread.join().unwrap_or_default();
    match status {
        Ok(st) => ToolResult {
            success: st.success(),
            code: st.code().unwrap_or(-1),
            stdout,
            stderr,
        },
        Err(e) => ToolResult {
            success: false,
            code: -1,
            stdout,
            stderr: format!("{stderr}\nWaiting for Node failed: {e}"),
        },
    }
}

// ===========================================================================
// Steam version downloader
//
// TCOAAL is a paid game, so its old depot manifests can only be fetched by the
// account that owns it. The reliable, login-free path is the user's already
// signed-in Steam *client* console: we open it and put the exact
// `download_depot <appid> <depotid> <manifestid>` command on the clipboard, the
// user pastes + presses Enter, and Steam downloads to
//   <steam>/steamapps/content/app_<appid>/depot_<depotid>
// (no progress is reported). We then wait for that folder to stabilize and
// *move it out* into the app's data dir, because a later Steam update reuses /
// overwrites the content folder.
//
// Historical manifest IDs are not in any public Steam Web API (that is SteamDB's
// archived data), so the version catalog ships as a bundled, refreshable JSON
// (tools/tcoaal-versions.json) and a mod's own variants embed the manifest they
// were built against, so the installer can offer the exact version to fetch.
// ===========================================================================

use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const TCOAAL_APPID: &str = "2378900";
pub const TCOAAL_DEPOT: &str = "2378901";

/// A located Steam installation.
#[derive(Serialize, Clone)]
pub struct SteamInfo {
    /// The main Steam root (holds steamapps/, steamapps/content/, ...).
    pub root: String,
    /// All library folders (from libraryfolders.vdf): where games may live.
    pub libraries: Vec<String>,
    /// Currently installed TCOAAL build id, if an appmanifest was found.
    pub installed_buildid: Option<String>,
    /// Currently installed TCOAAL depot manifest id, if found.
    pub installed_manifest: Option<String>,
    /// Latest available public depot manifest id (from the Steam client's
    /// appinfo cache, i.e. the newest version, even if not installed).
    pub latest_manifest: Option<String>,
    /// Latest available public build id (from the appinfo cache).
    pub latest_buildid: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// Candidate Steam roots per platform (first existing one with steamapps/ wins).
fn steam_root_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "windows") {
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(p) = std::env::var_os(var) {
                out.push(PathBuf::from(p).join("Steam"));
            }
        }
        out.push(PathBuf::from("C:\\Program Files (x86)\\Steam"));
    } else if cfg!(target_os = "macos") {
        if let Some(h) = home_dir() {
            out.push(h.join("Library/Application Support/Steam"));
        }
    } else {
        // Linux: native + Debian-style + flatpak + snap.
        if let Some(h) = home_dir() {
            out.push(h.join(".steam/steam"));
            out.push(h.join(".steam/root"));
            out.push(h.join(".local/share/Steam"));
            out.push(h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
            out.push(h.join("snap/steam/common/.local/share/Steam"));
        }
    }
    out
}

/// Read every "path" entry out of steamapps/libraryfolders.vdf (best-effort
/// text parse: the file is Valve KeyValues).
fn parse_library_folders(root: &Path) -> Vec<PathBuf> {
    let vdf = root.join("steamapps").join("libraryfolders.vdf");
    let mut libs = vec![root.to_path_buf()];
    if let Ok(text) = fs::read_to_string(&vdf) {
        for line in text.lines() {
            let l = line.trim();
            // lines look like: "path"   "D:\\SteamLibrary"
            if let Some(rest) = l.strip_prefix("\"path\"") {
                if let Some(p) = first_quoted(rest) {
                    let pb = PathBuf::from(p.replace("\\\\", "\\"));
                    if !libs.contains(&pb) {
                        libs.push(pb);
                    }
                }
            }
        }
    }
    libs
}

/// Return the first "double-quoted" token in `s`, unescaped just enough for VDF.
fn first_quoted(s: &str) -> Option<String> {
    let start = s.find('"')? + 1;
    let rest = &s[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Locate Steam and read the currently installed TCOAAL manifest (if any).
pub fn find_steam() -> Option<SteamInfo> {
    let root = steam_root_candidates()
        .into_iter()
        .find(|p| p.join("steamapps").is_dir())?;
    let libraries = parse_library_folders(&root);

    let (installed_buildid, installed_manifest) = libraries
        .iter()
        .find_map(|lib| read_appmanifest(lib, TCOAAL_APPID, TCOAAL_DEPOT))
        .map(|(b, m)| (Some(b), Some(m)))
        .unwrap_or((None, None));

    let (latest_manifest, latest_buildid) = match read_public_manifest(&root) {
        Some((m, b)) => (Some(m), b),
        None => (None, None),
    };

    Some(SteamInfo {
        root: root.to_string_lossy().into_owned(),
        libraries: libraries
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        installed_buildid,
        installed_manifest,
        latest_manifest,
        latest_buildid,
    })
}

// ===========================================================================
// Finding the player's copy of the game
//
// The installer asks for a folder only when this fails. A player who bought
// the game on Steam and never moved it should press one button and be done,
// so this looks in the places Steam actually puts it, in order of certainty:
// the app manifest's own installdir first (authoritative), then every library
// folder's common/ directory, matched by shape rather than by name, since a
// localized or renamed folder still holds a www/data.
// ===========================================================================

/// The game's install folder, and how it was found.
#[derive(Serialize, Clone)]
pub struct GameLocation {
    pub path: String,
    /// "env", "steam-manifest", "steam-scan" or "saved", shown in the UI so a
    /// player can tell a guess from a certainty.
    pub source: String,
    pub buildid: Option<String>,
}

/// Does this folder hold a shipped TCOAAL tree? Both layouts the loader
/// understands: `www/data` next to the executable, and the macOS bundle where
/// the same tree sits inside the .app.
pub fn is_game_dir(dir: &Path) -> bool {
    if dir.join("www").join("data").is_dir() {
        return true;
    }
    let mac_tail = Path::new("Contents/Resources/app.nw/www/data");
    if dir.join(mac_tail).is_dir() {
        return true;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name().to_string_lossy().ends_with(".app") && e.path().join(mac_tail).is_dir()
    })
}

/// `"installdir"` from the app manifest of `appid` in this library.
fn installdir_of(library: &Path, appid: &str) -> Option<String> {
    let acf = library
        .join("steamapps")
        .join(format!("appmanifest_{appid}.acf"));
    kv_after(&fs::read_to_string(acf).ok()?, "\"installdir\"")
}

/// Locate the installed game. `TCOAAL_GAME` overrides everything (dev), then
/// Steam is asked, then every Steam library's common/ is scanned.
pub fn find_game() -> Option<GameLocation> {
    if let Some(p) = std::env::var_os("TCOAAL_GAME") {
        let path = PathBuf::from(p);
        if is_game_dir(&path) {
            return Some(GameLocation {
                path: path.to_string_lossy().into_owned(),
                source: "env".into(),
                buildid: None,
            });
        }
    }

    let steam = find_steam()?;
    let buildid = steam.installed_buildid.clone();

    for lib in &steam.libraries {
        let lib = PathBuf::from(lib);
        if let Some(dir) = installdir_of(&lib, TCOAAL_APPID) {
            let path = lib.join("steamapps").join("common").join(dir);
            if is_game_dir(&path) {
                return Some(GameLocation {
                    path: path.to_string_lossy().into_owned(),
                    source: "steam-manifest".into(),
                    buildid,
                });
            }
        }
    }

    // No usable manifest (a moved library, a manually copied install): look at
    // what is actually in common/. Names that look like the game are tried
    // first so a library of 200 games costs 200 cheap string tests, not 200
    // directory reads.
    let mut scanned: Vec<PathBuf> = Vec::new();
    for lib in &steam.libraries {
        let common = PathBuf::from(lib).join("steamapps").join("common");
        let Ok(entries) = fs::read_dir(&common) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.contains("coffin") || name.contains("tcoaal") {
                if is_game_dir(&e.path()) {
                    return Some(GameLocation {
                        path: e.path().to_string_lossy().into_owned(),
                        source: "steam-scan".into(),
                        buildid,
                    });
                }
            } else {
                scanned.push(e.path());
            }
        }
    }
    for path in scanned {
        if is_game_dir(&path) {
            return Some(GameLocation {
                path: path.to_string_lossy().into_owned(),
                source: "steam-scan".into(),
                buildid: buildid.clone(),
            });
        }
    }
    None
}

/// A Proton runner and the game's prefix, for a Windows build of the game
/// installed on Linux (which is how most Linux players own it).
#[derive(Serialize, Clone)]
pub struct ProtonRun {
    /// The `proton` script to run.
    pub proton: String,
    /// STEAM_COMPAT_DATA_PATH: the game's existing prefix.
    pub compat_data: String,
    /// STEAM_COMPAT_CLIENT_INSTALL_PATH: the Steam root.
    pub steam_root: String,
}

/// Every Proton runner that could run the game's .exe, best first, together
/// with the prefix Steam already made for it.
///
/// This is what makes Play work on Linux at all: the game ships as a Windows
/// binary, so a Linux player's copy is a Proton install, and running the
/// profile's own executable means running it the way Steam does: the same
/// prefix, so their configuration and their Windows-side saves are the ones
/// the modded game sees. Best-effort: an install with Proton somewhere unusual
/// gets `None` and a message rather than a guess.
pub fn find_protons(appid: &str) -> Option<Vec<ProtonRun>> {
    let steam = find_steam()?;
    // The prefix Steam already made for this app is the one to use. A copy
    // that has been installed but never launched has none yet, which is not a
    // reason to refuse to play: the path is still the one Steam itself would
    // use, so point Proton at it in the library holding the app and let Proton
    // build the prefix on first run, exactly as a Steam launch would.
    let compat_of = |lib: &String| {
        PathBuf::from(lib)
            .join("steamapps")
            .join("compatdata")
            .join(appid)
    };
    let compat_data = match steam.libraries.iter().map(compat_of).find(|p| p.is_dir()) {
        Some(p) => p,
        None => {
            let lib = steam
                .libraries
                .iter()
                .find(|lib| {
                    PathBuf::from(lib)
                        .join("steamapps")
                        .join(format!("appmanifest_{appid}.acf"))
                        .is_file()
                })
                .or_else(|| steam.libraries.first())?;
            let p = compat_of(lib);
            fs::create_dir_all(&p).ok()?;
            p
        }
    };

    // Newest first by name, so "Proton 9.0" beats "Proton 8.0"; Experimental
    // wins outright, being what Steam defaults new installs to.
    let mut candidates: Vec<PathBuf> = Vec::new();
    for lib in &steam.libraries {
        let common = PathBuf::from(lib).join("steamapps").join("common");
        if let Ok(entries) = fs::read_dir(&common) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("Proton") && e.path().join("proton").is_file() {
                    candidates.push(e.path());
                }
            }
        }
    }
    // Hand-installed runners (GE-Proton and friends).
    if let Some(home) = home_dir() {
        for root in [
            home.join(".steam/root/compatibilitytools.d"),
            home.join(".local/share/Steam/compatibilitytools.d"),
        ] {
            if let Ok(entries) = fs::read_dir(&root) {
                for e in entries.flatten() {
                    if e.path().join("proton").is_file() {
                        candidates.push(e.path());
                    }
                }
            }
        }
    }
    candidates.sort();
    // Experimental first, then newest by name. All of them are returned, not
    // just the best: a runner can be mid-update or broken (Steam replaces the
    // whole directory in place), and the caller can only tell by trying to
    // start the game with it. Falling through to the next one is the
    // difference between Play doing nothing and Play working.
    candidates.reverse();
    if let Some(i) = candidates.iter().position(|p| {
        p.file_name()
            .map(|n| n.to_string_lossy().contains("Experimental"))
            .unwrap_or(false)
    }) {
        let best = candidates.remove(i);
        candidates.insert(0, best);
    }

    Some(
        candidates
            .into_iter()
            .map(|p| ProtonRun {
                proton: p.join("proton").to_string_lossy().into_owned(),
                compat_data: compat_data.to_string_lossy().into_owned(),
                steam_root: steam.root.clone(),
            })
            .collect(),
    )
}

/// The best Proton runner for the game, i.e. the first of `find_protons`.
pub fn find_proton(appid: &str) -> Option<ProtonRun> {
    find_protons(appid)?.into_iter().next()
}

// appinfo.vdf (binary) parsing
//
// The Steam client caches PICS appinfo in <root>/appcache/appinfo.vdf: the same
// data `app_info_print <appid>` prints. We read the *latest available* public
// depot manifest + build id from it (depots.<depot>.manifests.public.gid and
// depots.branches.public.buildid), so the app knows the newest version even when
// it is not the one installed. The format is a header, then per-app entries each
// carrying a binary KeyValues blob; v41+ (magic low byte 0x29) stores keys as
// indices into a string table at the end of the file. Parsing is fully
// bounds-checked and best-effort: any malformed/unknown shape yields None and
// the app falls back to the installed manifest + catalog.

struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Cur<'a> {
    fn new(b: &'a [u8]) -> Self {
        Cur { b, p: 0 }
    }
    fn at(b: &'a [u8], p: usize) -> Self {
        Cur { b, p }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.p..self.p + n)?;
        self.p += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        let s = self.take(8)?;
        Some(u64::from_le_bytes([
            s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
        ]))
    }
    fn i64(&mut self) -> Option<i64> {
        self.u64().map(|v| v as i64)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }
    fn cstr(&mut self) -> Option<String> {
        let start = self.p;
        while *self.b.get(self.p)? != 0 {
            self.p += 1;
        }
        let s = String::from_utf8_lossy(&self.b[start..self.p]).into_owned();
        self.p += 1; // consume the NUL
        Some(s)
    }
}

enum Node {
    Obj(BTreeMap<String, Node>),
    Str(String),
}

fn read_key(cur: &mut Cur, strtab: Option<&[String]>) -> Option<String> {
    match strtab {
        Some(t) => {
            let idx = cur.u32()? as usize;
            t.get(idx).cloned()
        }
        None => cur.cstr(),
    }
}

/// Parse a binary KeyValues object (until the 0x08 terminator).
fn parse_kv(cur: &mut Cur, strtab: Option<&[String]>) -> Option<BTreeMap<String, Node>> {
    let mut map = BTreeMap::new();
    loop {
        let t = cur.u8()?;
        if t == 0x08 || t == 0x0b {
            break;
        }
        let key = read_key(cur, strtab)?;
        match t {
            0x00 => {
                map.insert(key, Node::Obj(parse_kv(cur, strtab)?));
            }
            0x01 => {
                map.insert(key, Node::Str(cur.cstr()?));
            }
            0x02 | 0x03 | 0x04 | 0x06 => {
                let v = cur.u32()?;
                if t == 0x02 {
                    map.insert(key, Node::Str(v.to_string()));
                }
            }
            0x07 | 0x0a => {
                let v = cur.u64()?;
                map.insert(key, Node::Str(v.to_string()));
            }
            0x05 => {
                // wide string: consume until a UTF-16 NUL.
                while cur.u16()? != 0 {}
            }
            _ => return None,
        }
    }
    Some(map)
}

fn obj<'a>(map: &'a BTreeMap<String, Node>, key: &str) -> Option<&'a BTreeMap<String, Node>> {
    match map.get(key) {
        Some(Node::Obj(m)) => Some(m),
        _ => None,
    }
}
fn strv<'a>(map: &'a BTreeMap<String, Node>, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(Node::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// Read the latest public (manifest gid, build id) for the TCOAAL depot from the
/// Steam client's appinfo cache. Best-effort: returns None on any parse trouble.
pub fn read_public_manifest(steam_root: &Path) -> Option<(String, Option<String>)> {
    let bytes = fs::read(steam_root.join("appcache").join("appinfo.vdf")).ok()?;
    let mut cur = Cur::new(&bytes);

    let magic = cur.u32()?;
    let has_string_table = (magic & 0xff) >= 0x29;
    let _universe = cur.u32()?;

    // v41+ stores a string table; its offset is an i64 right after the universe.
    let strtab: Option<Vec<String>> = if has_string_table {
        let off = cur.i64()? as usize;
        let mut sc = Cur::at(&bytes, off);
        let count = sc.u32()? as usize;
        let mut v = Vec::with_capacity(count.min(1 << 20));
        for _ in 0..count {
            v.push(sc.cstr()?);
        }
        Some(v)
    } else {
        None
    };
    let appid_target: u32 = TCOAAL_APPID.parse().ok()?;

    loop {
        let appid = cur.u32()?;
        if appid == 0 {
            return None;
        }
        let size = cur.u32()? as usize;
        let entry_end = cur.p + size; // size covers everything after this field
        if appid == appid_target {
            // Fixed header within the entry, then the KV blob.
            cur.skip(4)?; // infoState
            cur.skip(4)?; // lastUpdated
            cur.skip(8)?; // picsToken
            cur.skip(20)?; // sha1 (text)
            cur.skip(4)?; // changeNumber
            if has_string_table {
                cur.skip(20)?; // sha1 (binary vdf)
            }
            let root = parse_kv(&mut cur, strtab.as_deref())?;
            let depots = obj(&root, "depots")?;
            let depot = obj(depots, TCOAAL_DEPOT)?;
            let gid = obj(depot, "manifests")
                .and_then(|m| obj(m, "public"))
                .and_then(|p| strv(p, "gid"))
                .map(|s| s.to_string())?;
            let buildid = obj(depots, "branches")
                .and_then(|b| obj(b, "public"))
                .and_then(|p| strv(p, "buildid"))
                .map(|s| s.to_string());
            return Some((gid, buildid));
        }
        // Not our app: jump straight to the next entry.
        cur.p = entry_end;
        if cur.p > bytes.len() {
            return None;
        }
    }
}

/// Parse steamapps/appmanifest_<appid>.acf for (buildid, depot manifest id).
fn read_appmanifest(library: &Path, appid: &str, depot: &str) -> Option<(String, String)> {
    let acf = library
        .join("steamapps")
        .join(format!("appmanifest_{appid}.acf"));
    let text = fs::read_to_string(&acf).ok()?;

    let buildid = kv_after(&text, "\"buildid\"").unwrap_or_default();

    // Find the depot block inside "InstalledDepots": ... "<depot>" { "manifest" "id" }
    let needle = format!("\"{depot}\"");
    let didx = text.find(&needle)?;
    let after = &text[didx..];
    let manifest = kv_after(after, "\"manifest\"")?;
    Some((buildid, manifest))
}

/// Value of the first `"key" "value"` pair at or after `key` in VDF text.
fn kv_after(text: &str, key: &str) -> Option<String> {
    let idx = text.find(key)? + key.len();
    first_quoted(&text[idx..])
}

/// Candidate folders where Steam drops `download_depot` output. On Linux the
/// client writes under an extra `ubuntu12_32/` runtime segment (e.g.
/// `<root>/ubuntu12_32/steamapps/content/app_<id>/depot_<id>`); on Windows/macOS
/// it is directly under `steamapps/content`. We return every candidate (most
/// likely first) and the caller picks whichever actually gets populated. The
/// downloaded folder is the game root (contains `www/`, `Game.exe`, ...).
pub fn depot_content_dirs(steam_root: &Path, appid: &str, depot: &str) -> Vec<PathBuf> {
    let tail = Path::new("steamapps")
        .join("content")
        .join(format!("app_{appid}"))
        .join(format!("depot_{depot}"));
    let mut dirs = Vec::new();
    if cfg!(target_os = "linux") {
        dirs.push(steam_root.join("ubuntu12_32").join(&tail));
    }
    dirs.push(steam_root.join(&tail));
    dirs
}

/// The console command the user pastes into the Steam client console.
pub fn download_command(appid: &str, depot: &str, manifest: &str) -> String {
    format!("download_depot {appid} {depot} {manifest}")
}

/// Every existing Steam root (each candidate that actually has a steamapps/ dir).
/// `download_depot` always writes under the *main* root, but installs vary
/// (native, flatpak, snap, symlinked runtime), so we collect them all.
fn existing_steam_roots() -> Vec<PathBuf> {
    steam_root_candidates()
        .into_iter()
        .filter(|p| p.join("steamapps").is_dir())
        .collect()
}

/// Every depot content folder to watch for a `download_depot`, across all
/// detected Steam roots (deduped, most-likely first). The downloaded folder is
/// the game root (contains www/, Game.exe, ...).
pub fn all_depot_content_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in existing_steam_roots() {
        for d in depot_content_dirs(&root, TCOAAL_APPID, TCOAAL_DEPOT) {
            if !out.contains(&d) {
                out.push(d);
            }
        }
    }
    out
}

/// Open the Steam client console (steam://open/console) via the OS handler.
pub fn open_steam_console() -> io::Result<()> {
    open_url("steam://open/console")
}

fn open_url(url: &str) -> io::Result<()> {
    let mut cmd = if cfg!(target_os = "windows") {
        // explorer, not `cmd /C start`: cmd.exe is a console program, and a
        // GUI process starting one gets a console allocated for it. That is a
        // black window that appears and vanishes, which reads to a player as
        // something going wrong with their machine. explorer hands the URL to
        // the same default handler and never has a console. It reports a
        // non-zero exit code even on success, so its status is not checked.
        let mut c = Command::new("explorer");
        c.arg(url);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    no_console(&mut cmd).spawn().map(|_| ())
}

/// A cheap fingerprint of a directory tree (file count + total bytes), used to
/// detect when an in-progress depot download has stopped growing.
#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct DirSnapshot {
    files: u64,
    bytes: u64,
}

fn snapshot_dir(dir: &Path) -> DirSnapshot {
    let mut snap = DirSnapshot::default();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() => {
                    snap.files += 1;
                    if let Ok(meta) = entry.metadata() {
                        snap.bytes += meta.len();
                    }
                }
                _ => {}
            }
        }
    }
    snap
}

/// First candidate that already exists and is non-empty.
fn first_populated(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .find(|d| d.is_dir() && snapshot_dir(d).files > 0)
        .cloned()
}

/// Wait until one of the candidate depot folders becomes non-empty and stops
/// changing for `stable_secs`, returning that folder. Blocks up to
/// `timeout_secs`. Steam shows no download progress, so this is a stabilization
/// heuristic; call it from a Tauri command on its own thread.
pub fn wait_for_any_depot(
    dirs: &[PathBuf],
    stable_secs: u64,
    timeout_secs: u64,
) -> Result<PathBuf, String> {
    let started = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    let mut last = DirSnapshot::default();
    let mut active: Option<PathBuf> = None;
    let mut stable_since: Option<Instant> = None;

    loop {
        if started.elapsed() > timeout {
            return Err(format!(
                "Timed out after {timeout_secs}s waiting for the download. If it is still \
                 running, wait for it to finish and use 'Archive now'."
            ));
        }
        // Pick the candidate with the most bytes right now (the one being written).
        let mut best: Option<(PathBuf, DirSnapshot)> = None;
        for d in dirs {
            let s = snapshot_dir(d);
            if s.files > 0 && s.bytes > 0 && best.as_ref().map_or(true, |(_, b)| s.bytes > b.bytes) {
                best = Some((d.clone(), s));
            }
        }
        match best {
            None => {
                stable_since = None;
                active = None;
            }
            Some((dir, snap)) => {
                if active.as_ref() == Some(&dir) && snap == last {
                    let since = stable_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_secs(stable_secs) {
                        return Ok(dir);
                    }
                } else {
                    active = Some(dir);
                    stable_since = None;
                }
                last = snap;
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Metadata stored alongside an archived game version.
#[derive(Serialize, Deserialize, Clone)]
pub struct ArchivedVersion {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub appid: String,
    pub depot: String,
    pub manifest: String,
    #[serde(default)]
    pub buildid: String,
    #[serde(default)]
    pub date: String,
    /// Absolute path to the archived game folder (contains www/).
    pub path: String,
}

fn versions_index_path(archive_root: &Path) -> PathBuf {
    archive_root.join("versions.json")
}

fn read_versions_index(archive_root: &Path) -> BTreeMap<String, ArchivedVersion> {
    let p = versions_index_path(archive_root);
    match fs::read(&p) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}

fn write_versions_index(
    archive_root: &Path,
    index: &BTreeMap<String, ArchivedVersion>,
) -> io::Result<()> {
    fs::create_dir_all(archive_root)?;
    let json = serde_json::to_vec_pretty(index).map_err(io::Error::other)?;
    fs::write(versions_index_path(archive_root), json)
}

/// Move a freshly downloaded depot folder into permanent app storage under
/// `archive_root/versions/<key>/`, record it in versions.json, and return it.
/// The source is removed (rename when possible, else copy + delete) so a later
/// Steam update can't clobber the kept copy.
pub fn archive_version(
    src_depot_dir: &Path,
    archive_root: &Path,
    mut version: ArchivedVersion,
) -> Result<ArchivedVersion, String> {
    if !src_depot_dir.is_dir() {
        return Err(format!(
            "Downloaded folder not found: {}",
            src_depot_dir.display()
        ));
    }
    let dest = archive_root.join("versions").join(&version.key);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;

    // Prefer a same-filesystem move; fall back to copy + delete across devices.
    if fs::rename(src_depot_dir, &dest).is_err() {
        copy_dir_all(src_depot_dir, &dest).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(src_depot_dir);
    }

    version.path = dest.to_string_lossy().into_owned();
    let mut index = read_versions_index(archive_root);
    index.insert(version.key.clone(), version.clone());
    write_versions_index(archive_root, &index).map_err(|e| e.to_string())?;
    Ok(version)
}

/// List archived versions (those still present on disk).
pub fn list_archived(archive_root: &Path) -> Vec<ArchivedVersion> {
    let index = read_versions_index(archive_root);
    index
        .into_values()
        .filter(|v| Path::new(&v.path).is_dir())
        .collect()
}

/// Remove an archived version and its index entry.
pub fn remove_archived(archive_root: &Path, key: &str) -> Result<(), String> {
    let mut index = read_versions_index(archive_root);
    if let Some(v) = index.remove(key) {
        let _ = fs::remove_dir_all(&v.path);
    }
    write_versions_index(archive_root, &index).map_err(|e| e.to_string())
}

/// The per-app cache dir, by the same rules Tauri's `app_cache_dir()` uses.
///
///   Windows: %LOCALAPPDATA%/<identifier>
///   macOS: ~/Library/Caches/<identifier>
///   Linux: $XDG_CACHE_HOME (or ~/.cache)/<identifier>
///
/// Resolved here rather than through the AppHandle so that the housekeeping
/// pass, which has to run before a window (and therefore before the webview
/// opens its own storage), and the staging that happens later cannot disagree
/// about where the app's files live.
pub fn app_cache_dir(identifier: &str) -> PathBuf {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home_dir().map(|h| h.join("Library/Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| home_dir().map(|h| h.join(".cache")))
    };
    base.unwrap_or_else(std::env::temp_dir).join(identifier)
}

/// The per-app local data dir, by the same rules Tauri's
/// `app_local_data_dir()` uses. This is the webview's own storage: WebKitGTK's
/// caches on Linux, WebView2's user data folder on Windows, WKWebView's on
/// macOS. The app writes nothing here itself.
pub fn app_local_data_dir(identifier: &str) -> PathBuf {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home_dir().map(|h| h.join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| home_dir().map(|h| h.join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir).join(identifier)
}

/// A single, app-shared data dir (so a version downloaded in the creator is
/// also visible to the installer, and vice versa).
///   Windows: %APPDATA%/tcoaal-mods
///   macOS: ~/Library/Application Support/tcoaal-mods
///   Linux: $XDG_DATA_HOME (or ~/.local/share)/tcoaal-mods
pub fn shared_data_dir() -> PathBuf {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().unwrap_or_else(|| PathBuf::from(".")))
    } else if cfg!(target_os = "macos") {
        home_dir()
            .map(|h| h.join("Library/Application Support"))
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home_dir()
                    .map(|h| h.join(".local/share"))
                    .unwrap_or_else(|| PathBuf::from("."))
            })
    };
    base.join("tcoaal-mods")
}

/// Where the refreshed/merged catalog is cached (shared by both apps). A manual
/// "refresh" (GitHub pull) or an installed-game merge writes here; it overrides
/// the copy bundled with the app at build time.
pub fn cached_catalog_path() -> PathBuf {
    shared_data_dir().join("tcoaal-versions.json")
}

fn read_catalog_file(p: &Path) -> Option<serde_json::Value> {
    let bytes = fs::read(p).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    // Only accept a well-formed catalog (has a majors[] array).
    if v.get("majors").map(|m| m.is_array()).unwrap_or(false) {
        Some(v)
    } else {
        None
    }
}

/// Load the version catalog as raw JSON. Prefers the refreshed cache in the
/// shared data dir (GitHub pull + installed-game merge); falls back to the copy
/// bundled with the app (tools/tcoaal-versions.json). Returns `null` if neither
/// is usable.
pub fn load_catalog(resource_dir: &Path) -> serde_json::Value {
    if let Some(v) = read_catalog_file(&cached_catalog_path()) {
        return v;
    }
    read_catalog_file(&tool_path(resource_dir, "tcoaal-versions.json"))
        .unwrap_or(serde_json::Value::Null)
}

/// Result of a catalog refresh: the merged catalog plus any non-fatal note
/// (e.g. "GitHub was unreachable, used the bundled copy") for the UI to show.
#[derive(Serialize, Clone)]
pub struct CatalogRefresh {
    pub catalog: serde_json::Value,
    pub note: String,
}

/// Refresh the catalog and write it to the shared cache, then return it. Runs
/// the existing `update-game-manifest-ids.js` maintenance tool so the merge
/// logic lives in one place:
///   - `remote=true` pulls the maintained catalog from GitHub (best-effort);
///   - the locally installed game + previously archived versions are always
///     merged in (so the list updates from what the user actually has).
/// The app-bundled copy is passed as the offline seed/fallback.
pub fn refresh_catalog(resource_dir: &Path, remote: bool) -> Result<CatalogRefresh, String> {
    let cache = cached_catalog_path();
    if let Some(parent) = cache.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let seed = tool_path(resource_dir, "tcoaal-versions.json");
    let mut args: Vec<String> = vec![
        "--out".into(),
        cache.to_string_lossy().into_owned(),
        "--seed".into(),
        seed.to_string_lossy().into_owned(),
    ];
    if remote {
        args.push("--remote".into());
    }
    let res = run_tool(resource_dir, "update-game-manifest-ids.js", &args);
    if !res.success {
        return Err(if res.stderr.trim().is_empty() {
            "Could not refresh the version catalog.".into()
        } else {
            res.stderr.trim().to_string()
        });
    }
    Ok(CatalogRefresh {
        catalog: load_catalog(resource_dir),
        note: res.stderr.trim().to_string(),
    })
}

// High-level orchestration (the Tauri commands in both apps are thin wrappers
//     around these, so the download flow lives in one place). -----------------

/// What the UI needs after kicking off a download: the command to paste into the
/// Steam console and the folder to watch.
#[derive(Serialize, Clone)]
pub struct DownloadStart {
    pub command: String,
    pub content_dir: String,
    pub steam_root: String,
}

fn sanitize_key(s: &str) -> String {
    let k: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let k = k.trim_matches('_').to_string();
    if k.is_empty() {
        "v".to_string()
    } else {
        k
    }
}

/// Open the Steam console and return the command + the folder to watch. The UI
/// copies the command to the clipboard and tells the user to paste + Enter.
pub fn steam_start_download(manifest: &str) -> Result<DownloadStart, String> {
    if manifest.trim().is_empty() {
        return Err("This version has no known manifest id yet. Enter one (from \
                    steamdb.info) to download it."
            .into());
    }
    let steam = find_steam().ok_or_else(|| "Steam was not found on this computer.".to_string())?;
    let dirs = all_depot_content_dirs();
    let content = first_populated(&dirs).unwrap_or_else(|| dirs.first().cloned().unwrap_or_default());
    open_steam_console().map_err(|e| format!("Could not open the Steam console: {e}"))?;
    Ok(DownloadStart {
        command: download_command(TCOAAL_APPID, TCOAAL_DEPOT, manifest.trim()),
        content_dir: content.to_string_lossy().into_owned(),
        steam_root: steam.root,
    })
}

/// Write the steam.json metadata next to the archived game so share-project can
/// embed it into each mod variant.
fn write_steam_json(av: &ArchivedVersion) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(av).map_err(io::Error::other)?;
    fs::write(Path::new(&av.path).join("steam.json"), json)
}

/// Finish a download: optionally wait for the depot folder to stabilize, then
/// move it into shared storage and record it. `wait=false` archives whatever is
/// already present (the "Archive now" override).
#[allow(clippy::too_many_arguments)]
pub fn steam_finish_download(
    manifest: &str,
    name: &str,
    version: &str,
    buildid: &str,
    date: &str,
    wait: bool,
) -> Result<ArchivedVersion, String> {
    find_steam().ok_or_else(|| "Steam was not found on this computer.".to_string())?;
    let dirs = all_depot_content_dirs();

    let content = if wait {
        // Steam reports no progress; wait until a candidate folder is stable for
        // 12s, up to one hour.
        wait_for_any_depot(&dirs, 12, 3600)?
    } else {
        first_populated(&dirs).ok_or_else(|| {
            "No downloaded depot found yet. Start the download in the Steam console first."
                .to_string()
        })?
    };

    let key = format!(
        "{}_{}",
        sanitize_key(if version.is_empty() { name } else { version }),
        sanitize_key(manifest)
    );
    let av = ArchivedVersion {
        key,
        name: if name.is_empty() {
            version.to_string()
        } else {
            name.to_string()
        },
        version: version.to_string(),
        appid: TCOAAL_APPID.to_string(),
        depot: TCOAAL_DEPOT.to_string(),
        manifest: manifest.to_string(),
        buildid: buildid.to_string(),
        date: date.to_string(),
        path: String::new(),
    };
    let archived = archive_version(&content, &shared_data_dir(), av)?;
    let _ = write_steam_json(&archived);
    Ok(archived)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verifies the binary appinfo.vdf parser against a fixture built from the
    // real `app_info_print 2378900` output. The fixture path is supplied via
    // TCOAAL_TEST_APPINFO (a Steam-root-like dir holding appcache/appinfo.vdf);
    // the assertion is skipped when it is not set, so plain `cargo test` passes.
    #[test]
    fn parses_public_manifest_from_appinfo() {
        if let Some(dir) = std::env::var_os("TCOAAL_TEST_APPINFO") {
            let got = read_public_manifest(Path::new(&dir));
            assert_eq!(
                got,
                Some((
                    "3682254389579820333".to_string(),
                    Some("22651024".to_string())
                ))
            );
        }
    }
}

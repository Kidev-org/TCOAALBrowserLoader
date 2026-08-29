// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The installer is distributed as ONE self-contained file per OS. That is the
// whole point of the create.html stubs: a modder hands a player a single
// double-clickable installer. Tauri's `resources` mechanism cannot deliver
// that on Windows, where bundled resources are installed NEXT TO the exe by
// the NSIS/MSI installer and a bare copied .exe finds nothing.
//
// So the app carries its payload inside the binary instead: the applier and
// its libraries as text (see TOOL_FILES in src/main.rs) and the Node runtime
// as a compressed blob staged here into OUT_DIR. main.rs unpacks both into a
// versioned cache directory on first run.
//
// The runtime is the whole download: some 106 MB of Node against 7 MB of
// everything else this binary is. It is compressed with zstd at its highest
// level rather than with gzip, which is worth the ~28s it costs here exactly
// once per runtime change. Measured on the staged Node 22:
//
//   gzip -9     43.3 MB   (what this used to ship, on an unstripped runtime)
//   gzip -9     39.0 MB   stripped
//   zstd -19    29.0 MB   stripped, and ~4x faster to unpack on first run
//
// CI strips the runtime before staging it; a locally staged one that still
// carries its debug sections simply compresses less well.
//
// The runtime is optional at compile time: `runtime/node` is staged by CI (and
// by tools/build.sh) right before the release build, so a plain `cargo check`
// or a `tauri dev` in a fresh checkout still builds. Without it the app falls
// back to TCOAAL_RES_DIR + TCOAAL_NODE, which is the documented dev flow.

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;

/// zstd's top level. Anything lower is measurably bigger for a saving in
/// build time that a step gated on `rerun-if-changed` does not need.
const ZSTD_LEVEL: i32 = 19;

fn main() {
    tauri_build::build();

    println!("cargo:rustc-check-cfg=cfg(embedded_runtime)");

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let node_name = if target_os == "windows" { "node.exe" } else { "node" };
    let node = manifest.join("runtime").join(node_name);
    println!("cargo:rerun-if-changed={}", node.display());

    if !node.is_file() {
        println!(
            "cargo:warning=No {} in src-tauri/runtime: building a dev binary that needs \
             TCOAAL_RES_DIR + TCOAAL_NODE. Stage a Node runtime there for a release build.",
            node_name
        );
        return;
    }

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("node.zst");
    let mut src = BufReader::new(File::open(&node).expect("open runtime node"));
    let mut dst = zstd::Encoder::new(
        BufWriter::new(File::create(&out).expect("create node.zst")),
        ZSTD_LEVEL,
    )
    .expect("start the zstd encoder");
    std::io::copy(&mut src, &mut dst).expect("compress runtime node");
    dst.finish().expect("finish node.zst");
    println!("cargo:rustc-cfg=embedded_runtime");
}

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
// as a gzip blob staged here into OUT_DIR. main.rs unpacks both into a
// versioned cache directory on first run.
//
// The runtime is optional at compile time: `runtime/node` is staged by CI (and
// by tools/build.sh) right before the release build, so a plain `cargo check`
// or a `tauri dev` in a fresh checkout still builds. Without it the app falls
// back to TCOAAL_RES_DIR + TCOAAL_NODE, which is the documented dev flow.

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;

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

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("node.gz");
    let mut src = BufReader::new(File::open(&node).expect("open runtime node"));
    let mut dst = flate2::write::GzEncoder::new(
        BufWriter::new(File::create(&out).expect("create node.gz")),
        flate2::Compression::best(),
    );
    std::io::copy(&mut src, &mut dst).expect("compress runtime node");
    dst.finish().expect("finish node.gz");
    println!("cargo:rustc-cfg=embedded_runtime");
}

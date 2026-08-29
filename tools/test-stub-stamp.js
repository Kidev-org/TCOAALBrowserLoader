#!/usr/bin/env node
/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/*
 * Proves that a built installer stub actually works as a stamped installer -
 * the one thing a stub cannot ship without, and the one thing neither the
 * browser-side unit tests (which stamp but never run the result) nor a plain
 * build can tell you.
 *
 *   node tools/test-stub-stamp.js <stub>
 *
 * <stub> is what CI just built: win-x64.exe, a .AppImage, or a macOS .app
 * directory (or the macos.zip holding one). It is run TWICE with --selftest -
 * which unpacks the stub's embedded Node runtime, runs tools/mod-apply.js
 * through it, and reads back any mod stamped into it:
 *
 *   1. exactly as CI built it, which must report no stamped mod;
 *   2. with a real .tcoaalmod attached the same way app/create.html does: on
 *      Windows through StubStamp.stampWindows(), which rewrites the exe's
 *      resources before appending the trailer; a bare trailer on Linux; a
 *      bundle resource on macOS, which must report the mod's name.
 *
 * Running the un-stamped stub first is what makes a failure readable: it says
 * whether the build is broken or the stamp is. The Windows path is the reason
 * step 2 runs the REWRITTEN exe rather than the one cargo produced:
 * PeResources has to add a section to an MSVC-linked binary (.reloc sits
 * behind .rsrc, so the section cannot be grown in place), and the only real
 * proof that the result is still a loadable PE is Windows loading it.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MAGIC = Buffer.from("TCOAALPK", "ascii");
const MOD_NAME = "Stamp Probe";

function loadLibs() {
  const ctx = vm.createContext({
    self: {},
    crypto: globalThis.crypto || require("crypto").webcrypto,
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    Response,
    console,
  });
  for (const rel of [
    "app/js/libs/tcoaal-codec.js",
    "app/js/libs/json-diff.js",
    "app/js/libs/mod-package.js",
    "app/js/libs/pe-resources.js",
    "app/js/libs/stub-stamp.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx);
  }
  return ctx.self;
}

async function buildProbeMod() {
  const { ModPackage } = loadLibs();
  const payload = new TextEncoder().encode("var probe = 1;\n");
  const payloads = new Map([["f/0000000000000000", payload]]);
  return Buffer.from(
    await ModPackage.build({
      id: "stamp-probe",
      name: MOD_NAME,
      author: "CI",
      version: "0.0.1",
      description: "Built by tools/test-stub-stamp.js.",
      icon: null,
      saves: "isolated",
      update: null,
      theme: [],
      payloads,
      variants: [
        {
          base: {
            label: "probe",
            fingerprint: { files: 1, digest: "sha256:probe", version: null },
          },
          files: [
            {
              rel: "js/plugins/Probe.js",
              type: "verbatim",
              enc: false,
              payload: "f/0000000000000000",
            },
          ],
          stats: {
            patched: 0,
            added: 1,
            replaced: 0,
            deleted: 0,
            unchanged: 0,
          },
        },
      ],
    }),
  );
}

/** [stub][payload][u64 LE length][magic], per app/js/libs/stub-stamp.js. */
function attachTrailer(stub, payload) {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(payload.length));
  return Buffer.concat([stub, payload, len, MAGIC]);
}

function macBinary(appDir) {
  const macos = path.join(appDir, "Contents", "MacOS");
  const names = fs.readdirSync(macos);
  if (!names.length) throw new Error("No binary under " + macos);
  return path.join(macos, names[0]);
}

/**
 * Run one stub with `--selftest` and report EVERYTHING the run produced. Never
 * throws: a stub that dies before it can say why is exactly the case this has
 * to describe, and `execFileSync` reduces that to "Command failed" with an
 * empty stdout and stderr, which is indistinguishable from a dozen unrelated
 * failures. The exit status in hex is the one clue that separates them (an
 * NTSTATUS like 0xc0000135 is Windows telling you the image never got as far
 * as main), so it is always printed.
 */
function runSelftest(exe, label, cwd) {
  const report = path.join(cwd, "selftest-" + label + ".txt");
  const res = spawnSync(exe, ["--selftest", "--report", report], {
    encoding: "utf8",
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    cwd,
    timeout: 10 * 60 * 1000,
  });
  const out = fs.existsSync(report) ? fs.readFileSync(report, "utf8") : null;

  const status = res.status;
  console.log(`\n--- ${label}: ${exe}`);
  console.log(
    "    exit status: " +
      (status === null || status === undefined
        ? String(status)
        : `${status} (0x${(status >>> 0).toString(16)})`) +
      (res.signal ? `  signal: ${res.signal}` : ""),
  );
  if (res.error) console.log("    spawn error: " + res.error.message);
  if (res.stdout) console.log(indent("stdout", res.stdout));
  if (res.stderr) console.log(indent("stderr", res.stderr));
  console.log(out === null ? "    report: (no file written)" : indent("report", out));

  return { ok: status === 0 && !res.error, report: out || "" };
}

function indent(what, text) {
  return (
    "    " +
    what +
    ":\n" +
    text
      .replace(/\s+$/, "")
      .split("\n")
      .map((l) => "      | " + l)
      .join("\n")
  );
}

/** A selftest run that has to succeed, and say the given things. */
function require_(label, run, expected) {
  const missing = expected.filter((s) => run.report.indexOf(s) === -1);
  if (!run.ok) throw new Error(label + ": the stub's selftest did not succeed.");
  if (missing.length) {
    throw new Error(
      label + ": the selftest never reported " + missing.map((s) => JSON.stringify(s)).join(", "),
    );
  }
}

/**
 * The stub must stage the tools it was BUILT from, not whatever an earlier
 * build left in the same place.
 *
 * The staging directory used to be named for the crate version and the size of
 * the runtime, neither of which changes when a tool script does, so a rebuilt
 * binary found the previous build's directory already marked ready and went on
 * running its months-old scripts. Nothing about that is visible from outside:
 * the app starts, installs, and misbehaves exactly as the build it replaced.
 * So the staged copy is compared against the repo, byte for byte.
 */
function requireFreshTools(label, run) {
  const line = run.report.split("\n").find((l) => l.startsWith("selftest: staged into "));
  if (!line) throw new Error(label + ": the selftest never said where it staged.");
  const dir = line.slice("selftest: staged into ".length).trim();
  for (const rel of ["tools/mod-loader.js", "tools/mod-apply.js"]) {
    const staged = path.join(dir, rel);
    if (!fs.existsSync(staged)) throw new Error(`${label}: ${rel} was not staged at all.`);
    if (!fs.readFileSync(staged).equals(fs.readFileSync(path.join(ROOT, rel)))) {
      throw new Error(
        `${label}: the staged ${rel} is not the one this stub was built from ` +
          `(stale staging directory ${dir}).`,
      );
    }
  }
}

/**
 * Materialize one copy of the stub inside `dir` and return the binary to run.
 * With `mod` null the copy is byte-identical to what CI built, which is what
 * separates "this stub is broken" from "stamping broke it"; with a mod it goes
 * through exactly the path app/create.html uses for that platform.
 */
function place(target, dir, mod) {
  fs.mkdirSync(dir, { recursive: true });

  if (target.endsWith(".zip") || target.endsWith(".app")) {
    let app;
    if (target.endsWith(".zip")) {
      execFileSync("unzip", ["-q", path.resolve(target), "-d", dir], { stdio: "inherit" });
      app = fs
        .readdirSync(dir)
        .map((n) => path.join(dir, n))
        .find((p) => p.endsWith(".app"));
      if (!app) throw new Error("No .app inside " + target);
    } else {
      app = path.join(dir, path.basename(target));
      fs.cpSync(target, app, { recursive: true });
    }
    if (mod) {
      fs.writeFileSync(path.join(app, "Contents", "Resources", "payload.tcoaalmod"), mod);
    }
    return macBinary(app);
  }

  const exe = path.join(dir, path.basename(target));
  if (!mod) {
    fs.copyFileSync(target, exe);
  } else if (target.endsWith(".exe")) {
    // The full create.html Windows path: resources first (icon + product
    // name), trailer second. The icon payloads are opaque to the rewriter and
    // never parsed by the loader, so placeholder bytes are enough to exercise
    // the resource tree it builds.
    const libs = loadLibs();
    const icons = [16, 32, 48, 64, 128, 256].map((w) => ({
      width: w,
      height: w,
      png: new Uint8Array(64 + w).fill(0xab),
    }));
    const out = libs.StubStamp.stampWindows(new Uint8Array(fs.readFileSync(target)), {
      payload: new Uint8Array(mod),
      icons,
      name: MOD_NAME,
    });
    const back = libs.PeResources.readIconGroup(out);
    if (back.length !== icons.length) {
      throw new Error(
        "resource stamp wrote " + icons.length + " icons, read back " + back.length,
      );
    }
    // Rebuilding .rsrc must not cost the stub any resource type the rebuild
    // does not itself write, RT_MANIFEST (24) above all. Losing it makes the
    // stamped exe bind comctl32 v5 instead of the v6 the manifest asks for,
    // and Windows then fails the import at load with 0xc0000139
    // (STATUS_ENTRYPOINT_NOT_FOUND) before main can print a word. Assert it
    // here so that shows up as this sentence rather than as a bare NTSTATUS.
    const REBUILT = [3, 14, 16]; // RT_ICON, RT_GROUP_ICON, RT_VERSION
    const kept = (bytes) => {
      const info = libs.PeResources.parse(bytes);
      return [
        ...new Set(
          libs.PeResources.readResourceTree(bytes, info)
            .map((leaf) => leaf.type)
            .filter((t) => REBUILT.indexOf(t) === -1),
        ),
      ].sort();
    };
    const before = kept(new Uint8Array(fs.readFileSync(target)));
    const after = kept(out);
    const lost = before.filter((t) => after.indexOf(t) === -1);
    if (lost.length) {
      throw new Error(
        "the resource stamp dropped resource type(s) " +
          lost.join(", ") +
          " that the stub carried (had " +
          before.join(", ") +
          ", kept " +
          after.join(", ") +
          ")",
      );
    }
    console.log("    stamp kept the stub's other resource types: " + (before.join(", ") || "(none)"));
    fs.writeFileSync(exe, Buffer.from(out));
  } else {
    fs.writeFileSync(exe, attachTrailer(fs.readFileSync(target), mod));
  }
  fs.chmodSync(exe, 0o755);
  return exe;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node tools/test-stub-stamp.js <stub exe|AppImage|.app|macos.zip>");
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error("No such stub: " + target);
    process.exit(2);
  }

  buildProbeMod()
    .then((mod) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcoaal-stub-"));

      // Two runs, from the same directory, differing only in the stamp. The
      // first is the build's own smoke test (it unpacks the embedded Node
      // runtime and runs the applier through it) and it is what tells you,
      // when the second one fails, whether stamping is to blame.
      const plain = place(target, path.join(tmp, "plain"), null);
      const plainRun = runSelftest(plain, "plain", path.dirname(plain));
      require_("the stub as built", plainRun, ["selftest: ok", "no stamped mod"]);
      requireFreshTools("the stub as built", plainRun);

      const stamped = place(target, path.join(tmp, "stamped"), mod);
      require_(
        "the stamped stub",
        runSelftest(stamped, "stamped", path.dirname(stamped)),
        ["selftest: ok", MOD_NAME],
      );

      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`\nok: ${path.basename(target)} installs the mod stamped into it.`);
    })
    .catch((e) => {
      console.error("\nFAILED: " + ((e && e.message) || e));
      process.exit(1);
    });
}

main();

/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details: <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
"use strict";

// Real Web Worker only: pulls in TcoaalCodec (dekit/enkit/isEncrypted) and
// JsonDiff (diff), both consumed below. Guarded so this file still loads
// under vm.runInContext in tools/test-create.js, which has neither
// importScripts nor a worker global scope; the test harness loads those two
// files into the same context itself instead (see loadLib() there).
if (typeof importScripts === "function") {
  importScripts("/js/libs/tcoaal-codec.js", "/js/libs/json-diff.js");
}

/*
 * The mod diff engine. Compares a modder's tree against the SHIPPED game
 * (hashed + encrypted as the game stores it) and emits the modder's files
 * only, under the modder's own names: a file that is the game's own cancels
 * out (or, under another name, travels as a reference to the player's copy)
 * and never reaches the output, and a changed data file travels as a JSON
 * patch rather than as a copy of the original. That is what makes the output
 * copyright-safe by construction.
 *
 * This file holds only the pure comparison core (ModDiff), consumed by
 * app/create.html through a Web Worker. It does not import ModPackage and
 * must never build or know about the .tcoaalmod container: the worker
 * message handler that drives this from postMessage calls (added below this
 * IIFE by a later task) hands its output back to the main thread, which packs
 * it.
 */
(function (root) {
  var C = root.TcoaalCodec;
  var J = root.JsonDiff;

  var STD_SYSTEM = "data/be1a37535e921f91"; // hashPath("data/System.json")

  async function sha16(bytes) {
    var buf = await crypto.subtle.digest("SHA-256", bytes);
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); })
      .join("")
      .slice(0, 16);
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function tryJson(bytes) {
    if (bytes.length === 0) return undefined;
    var c = bytes[0];
    if (c !== 0x7b && c !== 0x5b) return undefined; // not '{' or '['
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return undefined;
    }
  }

  async function addPayload(payloads, bytes) {
    var h = await sha16(bytes);
    var key = "f/" + h;
    if (!payloads.has(key)) payloads.set(key, bytes);
    return key;
  }

  function encFields(raw) {
    var enc = C.isEncrypted(raw);
    return enc ? { enc: true, key: C.readKeyByte(raw) } : { enc: false };
  }

  // rel is where the entry is written: the name the MODDER's tree used. src
  // is the base file it is compared against, in the base's own key space:
  // the same name for a tree in game space, the game's storage name
  // (data/be1a37535e921f91 for the modder's data/Actors.json) for a project.
  // index maps the sha16 of every base file's PLAINTEXT to that file's name,
  // so a modder's file that is the game's own under any name is recognised
  // by its content, not only by where it sits.
  //
  // Rule order:
  //  1. mod side missing              -> delete (rel is the base's name)
  //  2. (both present sides get decrypted below, each with its own name)
  //  3. decrypted bytes identical to the base file at src, or to any base
  //     file by content -> null when it is the same name (drop; nothing
  //     enters payloads); otherwise copy: the player's own file laid down at
  //     rel, still with nothing in payloads
  //  4. base side missing             -> verbatim, enc/key from the MOD header
  //  5. both decrypt to parseable JSON -> patch, enc/key from the BASE header
  //     (the loader re-encrypts a patched file using the base file's own
  //     convention, so the patch entry must carry the base's enc/key); under
  //     another name the patch replays on src and lands at rel, so it
  //     carries from and the MOD's enc/key, which describe the file there
  //  6. otherwise                     -> verbatim, enc/key from the MOD header
  //
  // A copy is emitted only for a plain modded file. An encrypted one under a
  // different name would be re-encrypted by the loader with rel's mask, and
  // whether that reproduces the modder's bytes depends on how their tool
  // derived the mask from a name with an extension; verbatim round-trips
  // through the same codec on both ends and is right by construction.
  async function classify(rel, baseRaw, modRaw, payloads, src, index) {
    if (src == null) src = rel;
    if (modRaw == null) return { rel: src, type: "delete" };

    // Comparison MUST happen on decrypted bytes: two files can be
    // byte-identical after decryption while differing on disk (a different
    // keyByte produces a different ciphertext for the same plaintext).
    // Diffing raw bytes here would wrongly emit an entry for an unchanged
    // file, i.e. leak base-game content into the package.
    var modPlain = C.dekit(modRaw, rel);
    var modF = encFields(modRaw);
    var basePlain = baseRaw == null ? null : C.dekit(baseRaw, src);

    var same = basePlain !== null && sameBytes(basePlain, modPlain);
    var ops = null;
    if (!same && basePlain !== null) {
      var a = tryJson(basePlain);
      var b = tryJson(modPlain);
      if (a !== undefined && b !== undefined) {
        ops = J.diff(a, b);
        // Zero ops means the two sides parse to the same document and only
        // the serialization differs (key order, whitespace, a re-save by the
        // modder's editor). sameBytes could not see that. The file did not
        // change.
        if (ops.length === 0) same = true;
      }
    }

    // The player's own file, under this name or another.
    var from = same ? src : index ? index.get(await sha16(modPlain)) : undefined;
    if (from !== undefined) {
      if (from === rel) return null;
      if (!modF.enc) return { rel: rel, type: "copy", from: from, enc: false };
      // Encrypted under another name: verbatim, see above.
    } else if (ops !== null) {
      if (src !== rel) {
        return Object.assign({ rel: rel }, modF, { type: "patch", from: src, ops: ops });
      }
      return Object.assign({ rel: rel }, encFields(baseRaw), { type: "patch", ops: ops });
    }

    return Object.assign({ rel: rel }, modF, {
      type: "verbatim",
      payload: await addPayload(payloads, modPlain),
    });
  }

  /*
   * The shipped notices: the copyright, credits and EULA documents sitting
   * directly in www.
   *
   * These never belong in a mod. The game hashes one of them on boot and
   * refuses to start if it changed ("Game files corrupted"), and it takes
   * nothing more than a checkout with core.autocrlf to rewrite the line
   * endings of a file no modder ever opened. Diffing them turns that accident
   * into a package that carries the publisher's copyright text and cannot
   * boot. The loader restores them from the player's own copy either way; this
   * keeps them out of the package in the first place.
   */
  var NOTICE_RE = /^[^/]+\.(txt|url)$/i;

  /*
   * Where the game keeps each file of a modder's tree.
   *
   * A mod is authored as an RPG Maker project: data/Actors.json, not
   * data/be1a37535e921f91, and plain bytes rather than TCOAAL containers.
   * Diffed by name against the shipped game the two trees share almost no
   * path, so the whole game reads as deleted and every file of the modder's
   * as new. The shipped layout is derived from the logical one, though
   * (TcoaalCodec.storagePath), so the base file that stands behind each of
   * the modder's files can be computed: this maps every logical name to the
   * base's storage name for it, and compare() looks the base up through it.
   *
   * What it does NOT do is move the modder's files. Every overhaul in the
   * registry ships its own engine (a plugins.js and a GameCode.js or payload
   * of its own, with obfuscation and encryption off), and that engine opens
   * data/Actors.json, plain, exactly as the modder's folder holds it. A mod
   * re-hashed and re-encrypted to the base's layout would be one the mod's
   * own engine never reads. The modder ran their folder as it is, so as it
   * is is how it is laid down - which is also what importing it into the
   * loader does. Per path, so a tree already in game space (a whole modded
   * game, hashed and encrypted) maps every name to itself and a mixed tree
   * comes out right on both halves.
   *
   * Two logical names can land on one storage name (a project's Actor1.png
   * beside a stale 7d7d5b7fb68621e6.png for the same character). That is not
   * a conflict here: both are files the modder shipped, both are laid down
   * under their own names, and both are compared against the same base file.
   */
  async function storageNames(modList) {
    var out = new Map();
    for (var i = 0; i < modList.length; i++) {
      out.set(modList[i], (await C.storagePath(modList[i])).rel);
    }
    return out;
  }

  /*
   * Two shapes of "modded copy", and a base path missing from the modder's
   * tree means the opposite thing in each.
   *
   * "full": the tree is a whole modded GAME, so a base file absent from it
   * was removed on purpose and travels as a delete entry.
   *
   * "overlay": the tree holds only the files the mod itself ships, which is
   * how mods are normally distributed. A base file absent from it was never
   * touched, and emitting a delete for it builds a package that wipes the
   * game. Base-only paths are not walked at all in this mode: the loader
   * lays the player's own game down first and applies these entries on top,
   * so leaving a path out of the package IS leaving that file alone.
   *
   * The caller decides which; detectMode() below is what it decides with.
   *
   * opts.storage is the storageNames() map for the modded tree. Absent, every
   * name stands for itself, which is the whole-modded-game case. "Absent from
   * the modder's tree" is judged through it: a base file is present when any
   * file of the modder's maps to it, whatever that file is called.
   */
  async function compare(baseSource, modSource, payloads, onProgress, opts) {
    var overlay = !!(opts && opts.mode === "overlay");
    var storage = (opts && opts.storage) || new Map();
    var notice = function (rel) { return NOTICE_RE.test(rel); };
    var baseList = (await baseSource.list()).filter(function (r) { return !notice(r); });
    var modList = (await modSource.list()).filter(function (r) { return !notice(r); });
    var baseSet = new Set(baseList);
    var srcOf = function (rel) {
      var s = storage.get(rel);
      return s === undefined ? rel : s;
    };
    var covered = new Set();
    for (var mi = 0; mi < modList.length; mi++) covered.add(srcOf(modList[mi]));
    // The modder's files, then (full only) the base files none of them
    // stands for. A base path is keyed with a marker so the loop below can
    // tell "the modder's js/plugins.js" from "the base's js/plugins.js" when
    // the two are spelled the same.
    var all = modList.map(function (r) { return { rel: r, base: false }; });
    if (!overlay) {
      for (var bi = 0; bi < baseList.length; bi++) {
        if (!covered.has(baseList[bi])) all.push({ rel: baseList[bi], base: true });
      }
    }
    all.sort(function (x, y) { return x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0; });

    // Every base file by the hash of its plaintext, so a modder's file that
    // is the game's own under a name of their choosing (a track renamed, an
    // asset reused) is laid down from the player's copy rather than carried.
    // First name wins, in path order, so a build is a pure function of its
    // inputs (baseList is sorted by every Source's contract). It is a pass
    // over the whole base, so it is on the progress bar: the total below
    // counts it, and the walk continues from where it ends.
    var index = new Map();
    var total = baseList.length + all.length;
    for (var xi = 0; xi < baseList.length; xi++) {
      var h = await sha16(C.dekit(await baseSource.read(baseList[xi]), baseList[xi]));
      if (!index.has(h)) index.set(h, baseList[xi]);
      if (xi % 64 === 0) onProgress(xi + 1, total);
    }

    var files = [];
    var stats = {
      mode: overlay ? "overlay" : "full",
      patched: 0,
      added: 0,
      replaced: 0,
      copied: 0,
      deleted: 0,
      unchanged: 0,
      untouched: 0,
    };
    // Reported, not just skipped: "1542 game files left alone" is the line
    // that tells a modder the build read their folder the way they meant it.
    if (overlay) {
      for (var ui = 0; ui < baseList.length; ui++) {
        if (!covered.has(baseList[ui])) stats.untouched++;
      }
    }

    for (var i = 0; i < all.length; i++) {
      var rel = all[i].rel;
      var src = all[i].base ? rel : srcOf(rel);
      var inBase = baseSet.has(src);
      var baseRaw = inBase ? await baseSource.read(src) : null;
      var modRaw = all[i].base ? null : await modSource.read(rel);
      var entry = await classify(rel, baseRaw, modRaw, payloads, src, index);
      if (entry === null) {
        stats.unchanged++;
      } else {
        files.push(entry);
        if (entry.type === "delete") stats.deleted++;
        else if (entry.type === "patch") stats.patched++;
        else if (entry.type === "copy") stats.copied++;
        else if (!inBase) stats.added++;
        else stats.replaced++;
      }
      if (i % 64 === 0 || i === all.length - 1) onProgress(baseList.length + i + 1, total);
    }
    return { files: files, stats: stats };
  }

  async function fingerprint(source) {
    var list = await source.list();
    list.sort();
    var chunks = [];
    for (var i = 0; i < list.length; i++) {
      var raw = await source.read(list[i]);
      chunks.push(list[i] + "\n" + (await sha16(raw)) + "\n");
    }
    var digestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chunks.join("")));
    var digest = "sha256:" + Array.prototype.map
      .call(new Uint8Array(digestBuf), function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");

    var version = null;
    if (list.indexOf(STD_SYSTEM) !== -1) {
      var sys = tryJson(C.dekit(await source.read(STD_SYSTEM), STD_SYSTEM));
      if (sys && sys.versionId != null) version = String(sys.versionId);
    }
    return { files: list.length, digest: digest, version: version };
  }

  function idbReq(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (v && v.buffer) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    throw new Error("Unsupported IDB value type for a game file.");
  }

  // A Source over the game-files object store loader.html owns. gameVerId
  // null reads the ACTIVE game's plain-key namespace (skipping "mod:",
  // "gamever:", and "__" keys, the same three prefixes loader.html's own
  // isBaseFileKey() filters, so this never pulls a mod overlay, a parked
  // version, or a registry blob into the diff); a non-null id reads one
  // parked version under its "gamever:<id>:" prefix instead.
  //
  // Every read() goes through a fresh db.get(): IndexedDB's structured
  // clone gives back a brand-new value each call, so this source neither
  // caches nor hands back the same buffer twice (required: classify() may
  // store a dekit() result, itself the same reference when the file isn't
  // encrypted, directly into the shared payloads map).
  function idbSource(db, storeName, gameVerId) {
    var prefix = gameVerId ? "gamever:" + gameVerId + ":" : null;
    function store() {
      return db.transaction(storeName, "readonly").objectStore(storeName);
    }
    return {
      list: async function () {
        var keys = await idbReq(store().getAllKeys());
        var out = [];
        for (var i = 0; i < keys.length; i++) {
          var k = String(keys[i]);
          if (prefix) {
            if (k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
          } else if (
            k.indexOf("mod:") !== 0 &&
            k.indexOf("gamever:") !== 0 &&
            k.indexOf("__") !== 0
          ) {
            out.push(k);
          }
        }
        return out.sort();
      },
      read: async function (rel) {
        return toBytes(await idbReq(store().get(prefix ? prefix + rel : rel)));
      },
    };
  }

  // A Source over a picked FileSystemDirectoryHandle. Roots at the handle
  // itself when it directly contains a "data" entry (the modder picked the
  // game's www/ folder), otherwise at its "www" child (they picked the game
  // root); if neither shape is found this is not a game folder at all, and
  // silently walking it anyway would produce an empty (or bogus) diff: the
  // most dangerous failure mode this tool has, since an empty diff reads as
  // "no changes" and a bogus one would misalign every path against the base
  // game's keys, making every base file look added *and* deleted at once
  // (see the module comment on why that's a copyright leak). So this is a
  // thrown, user-facing error instead.
  //
  // Paths are joined with "/" and carry no leading slash, matching the
  // logical paths idbSource yields (e.g. "data/be1a37535e921f91"), so the
  // two sources line up file-for-file in compare().
  async function dirSource(handle) {
    var rootHandle = handle;
    var names = [];
    for await (var e of handle.values()) names.push(e.name);
    if (names.indexOf("data") === -1) {
      if (names.indexOf("www") === -1) {
        throw new Error(
          'This does not look like a game folder (no "data" or "www" found inside it).'
        );
      }
      rootHandle = await handle.getDirectoryHandle("www");
    }
    var files = new Map();
    async function walk(dir, base) {
      for await (var entry of dir.values()) {
        var rel = base ? base + "/" + entry.name : entry.name;
        if (entry.kind === "directory") await walk(entry, rel);
        else files.set(rel, entry);
      }
    }
    await walk(rootHandle, "");
    return {
      list: async function () { return Array.from(files.keys()).sort(); },
      // Every read() re-reads the handle: File.arrayBuffer() returns a fresh
      // ArrayBuffer per call, and only file *handles* are cached here, never
      // bytes, so like idbSource this never hands back the same buffer
      // twice across calls.
      read: async function (rel) {
        var file = await files.get(rel).getFile();
        return new Uint8Array(await file.arrayBuffer());
      },
    };
  }

  // A Source over an in-memory [rel, bytes] list, for browsers with no
  // showDirectoryPicker (Firefox, Safari): create.html unpacks the modder's
  // .zip and hands the entries over instead of a directory handle.
  function memSource(entries) {
    var map = entries instanceof Map ? entries : new Map(entries);
    return {
      list: async function () {
        return Array.from(map.keys()).sort();
      },
      read: async function (rel) {
        var v = map.get(rel);
        // Fresh copy per read: classify() stores an unencrypted file's bytes
        // into payloads by reference, so handing back the same array twice
        // would alias two payload entries onto one buffer.
        return v == null ? v : v.slice();
      },
    };
  }

  /*
   * Add plugin entries to an RPG Maker plugins.js.
   *
   * The file is "var $plugins = [ {...}, {...} ];", one JSON object per
   * plugin. It is edited as text, not parsed and re-serialised: the array is
   * left exactly as the modder's editor wrote it and the new entries go in
   * before its closing bracket, so the diff against a base that already
   * carries the same registry stays as small as the addition. An entry whose
   * name is already registered is skipped: the modder's own line, with the
   * modder's own status and parameters, is the one that counts. Returns the
   * input untouched when there is nothing to add. Throws when the file holds
   * no $plugins array at all, because appending to something else would
   * ship a registry the engine cannot read.
   */
  function registerPlugins(raw, entries) {
    var text = new TextDecoder().decode(raw);
    var at = text.indexOf("$plugins");
    var open = at === -1 ? -1 : text.indexOf("[", at);
    var close = open === -1 ? -1 : text.search(/\]\s*;?\s*$/);
    if (close === -1 && open !== -1) close = text.lastIndexOf("]");
    if (open === -1 || close <= open) {
      throw new Error("js/plugins.js holds no $plugins array to add plugins to.");
    }
    var have = Object.create(null);
    var re = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    var m;
    while ((m = re.exec(text.slice(open, close))) !== null) have[m[1]] = true;
    var lines = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (have[e.name]) continue;
      have[e.name] = true;
      lines.push(
        JSON.stringify({
          name: e.name,
          status: e.status !== false,
          description: e.description || "",
          parameters: e.parameters || {},
        })
      );
    }
    if (!lines.length) return raw;
    var body = text.slice(open + 1, close).replace(/\s+$/, "");
    var sep = body.trim() === "" ? "\n" : ",\n";
    var out = text.slice(0, open + 1) + body + sep + lines.join(",\n") + "\n" + text.slice(close);
    return new TextEncoder().encode(out);
  }

  /*
   * A Source over the modded tree with the Browser Player's own plugins laid
   * on top: each plugin's file under js/plugins/, and js/plugins.js with the
   * entries registered. create.html offers them as a checklist at build
   * time, so a modder who wants mouse control or a save-slot preview in the
   * shipped mod gets it without hand-editing a registry. The registry is
   * the modder's own js/plugins.js when the tree ships one, otherwise the
   * base game's, since an overlay that never touched plugins.js runs on the
   * game's registry and that is the one the additions belong in. The
   * entries land at the END of the array: every one of these plugins patches
   * what the engine and the DRM payload define, so it has to load after
   * them, and after the mod's own plugins too, for the same reason. A plugin
   * the tree already ships under the same file name is replaced by the
   * bundled copy (the checkbox says "ship this one"); its registry line, if
   * it has one, is kept as the modder wrote it (see registerPlugins).
   *
   * plugins is [{file, bytes, name, status?, description?, parameters?}].
   */
  async function bundlePlugins(mod, base, plugins) {
    if (!plugins || !plugins.length) return mod;
    var names = await mod.list();
    var extra = new Map();
    var entries = [];
    for (var i = 0; i < plugins.length; i++) {
      var p = plugins[i];
      extra.set(p.file, p.bytes);
      entries.push(p);
    }
    var ownRegistry = names.indexOf("js/plugins.js") !== -1;
    var registry = ownRegistry ? await mod.read("js/plugins.js") : await base.read("js/plugins.js");
    if (registry == null) {
      throw new Error(
        "Neither your modded copy nor the base game has js/plugins.js, so " +
          "there is no plugin list to add the bundled plugins to."
      );
    }
    extra.set("js/plugins.js", registerPlugins(registry, entries));
    var list = names.slice();
    extra.forEach(function (_, rel) {
      if (list.indexOf(rel) === -1) list.push(rel);
    });
    list.sort();
    return {
      list: async function () { return list.slice(); },
      read: async function (rel) {
        if (extra.has(rel)) return extra.get(rel).slice();
        return mod.read(rel);
      },
    };
  }

  /*
   * Which naming convention a tree's CONTENT files use.
   *
   * The remaster ships every asset under 16 hex characters (hashPath in
   * tcoaal-codec.js), optionally "!"-prefixed or "[BUST]"-suffixed. An RPG
   * Maker project, a mod's source repository, and the pre-remaster builds all
   * keep the canonical names instead. js/, fonts/, icon/ and the engine's own
   * files are named the same either way, so they carry no signal and are left
   * out of the count.
   *
   * Returns "hashed", "canonical", or null when the tree holds too little
   * content, or too even a mix, to say. null is the safe answer: it means no
   * caller refuses anything on this evidence.
   */
  var HASHED_NAME = /^!?[0-9a-f]{16}(\[BUST\])?$/;
  var CONTENT_DIR = /^(data|img|audio|movies|languages)\//;

  function pathSpace(list) {
    var hashed = 0;
    var canonical = 0;
    for (var i = 0; i < list.length; i++) {
      if (!CONTENT_DIR.test(list[i])) continue;
      if (HASHED_NAME.test(list[i].split("/").pop())) hashed++;
      else canonical++;
    }
    var total = hashed + canonical;
    if (total < 8) return null;
    if (hashed >= total * 0.9) return "hashed";
    if (canonical >= total * 0.9) return "canonical";
    // A remaster mod may replace hashed files AND add new assets under their
    // real names, which lands here. Nothing is wrong with that tree.
    return null;
  }

  /*
   * The one pairing that cannot be built.
   *
   * A project-space mod against a remaster base is NOT this case: the
   * remaster's storage name for each of the modder's files is computed from
   * the logical one (storageNames above), so the base file behind each is
   * found. It is only refused the other way round, where a mod whose files
   * are already hashed is pointed at a pre-remaster build that never hashed
   * anything. Nothing can be derived in that direction - the hash is one-way,
   * and the base holds no table to look the names up in - so every path would
   * miss and the package would read as "delete the game, here are 2000 files
   * of mine", which is exactly the shape this tool exists to prevent.
   *
   * Checked on the naming convention rather than on how much the two trees
   * overlap, because a legitimate overlay overlaps just as little (see
   * detectMode). This is the one signal that separates the two.
   */
  function spaceProblem(baseList, modList) {
    if (pathSpace(baseList) !== "canonical") return null;
    if (pathSpace(modList) !== "hashed") return null;
    return (
      "Your copy names its files the way the remaster ships them " +
      "(data/be1a37535e921f91), but the game version you picked uses the " +
      "canonical names (data/Actors.json). Pick the version your mod was " +
      "actually built against."
    );
  }

  /*
   * Full modded game, or just the files the mod ships?
   *
   * A full copy contains essentially all of the base: even a total
   * conversion replaces files rather than removing them, and the handful a
   * mod does delete is nothing against the whole tree. An overlay contains a
   * small part of it - a real one measured here came to 14%. The gap is wide
   * enough that a single threshold is not a close call.
   *
   * Where it is a close call, "overlay" is the safer read: reading an overlay
   * as full builds a package that deletes the player's game, while reading a
   * full copy as an overlay only drops the deletions the mod meant to make.
   * The modder can say which in the build UI either way, and the build
   * summary reports which reading was used.
   */
  var FULL_COPY_COVERAGE = 0.75;

  function detectMode(baseList, modList) {
    var mod = new Set(modList);
    var covered = 0;
    for (var i = 0; i < baseList.length; i++) {
      if (mod.has(baseList[i])) covered++;
    }
    var full =
      baseList.length > 0 && covered >= baseList.length * FULL_COPY_COVERAGE;
    return {
      mode: full ? "full" : "overlay",
      covered: covered,
      baseCount: baseList.length,
    };
  }

  /*
   * A last check on a pair built as a FULL copy.
   *
   * An overlay is expected to hold a small part of the base and is exempt.
   * But a tree read (or forced) as a whole modded game while most of the base
   * is missing from it is one of two mistakes - the wrong folder, or an
   * overlay marked as full - and the package it produces deletes almost the
   * entire game and carries the rest in as the modder's own work.
   *
   * Returns the reason, or null when the two go together.
   */
  function pairProblem(stats) {
    if (stats.mode === "overlay") return null;
    var kept = stats.unchanged + stats.patched + stats.replaced;
    var baseTotal = kept + stats.deleted;
    if (!baseTotal || kept * 2 >= baseTotal) return null;
    return (
      "That folder holds only " + kept + " of the game's " + baseTotal +
      " files, so building it as a full modded copy would delete the other " +
      stats.deleted + " and carry " + stats.added + " files in as your own " +
      "work. If it holds just the files your mod ships, set what the copy " +
      "contains to \"Only the files my mod changes\". If it is meant to be a " +
      "whole modded game, pick the copy that sits beside Game.exe."
    );
  }

  root.ModDiff = {
    sha16: sha16,
    classify: classify,
    compare: compare,
    fingerprint: fingerprint,
    storageNames: storageNames,
    pathSpace: pathSpace,
    spaceProblem: spaceProblem,
    detectMode: detectMode,
    pairProblem: pairProblem,
    idbSource: idbSource,
    dirSource: dirSource,
    memSource: memSource,
    registerPlugins: registerPlugins,
    bundlePlugins: bundlePlugins,
  };
})(typeof self !== "undefined" ? self : this);

/*
 * Worker entry point: app/create.html posts {cmd:"diff", dbName, storeName,
 * pairs:[{baseVerId, label, modHandle, steam?, mode?, plugins?}, ...]} to
 * this file running as a real Web Worker. Each pair diffs one base game
 * version (read from IDB) against one modded folder (read from a
 * FileSystemDirectoryHandle the main thread got from showDirectoryPicker():
 * handles are structured-cloneable, so they travel over postMessage intact).
 * mode is "auto" (or absent), "full" or "overlay"; see compare(). plugins is
 * the list bundlePlugins() takes, the Browser Player's plugins the modder
 * ticked, with their bytes fetched by the main thread. Replies are
 * {type:"progress", pair, done, total} while a pair is diffing, then either
 * {type:"done", variants, payloads} once, or {type:"error", message} on the
 * first failure.
 *
 * payloads is a single Map created ONCE for the whole message (outside the
 * pairs loop below), not per pair, so identical bytes across two variants of
 * the same mod (e.g. a Steam and a GOG base) collapse into one payload
 * instead of being packaged twice.
 *
 * Guarded so loading this file in a non-worker context (the Node/vm test
 * harness, which has neither importScripts nor indexedDB) never throws.
 */
if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = async function (ev) {
    var msg = ev.data;
    if (!msg || msg.cmd !== "diff") return;
    var db = null;
    try {
      db = await new Promise(function (resolve, reject) {
        var r = indexedDB.open(msg.dbName);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });

      var payloads = new Map();
      var variants = [];
      for (var i = 0; i < msg.pairs.length; i++) {
        var pair = msg.pairs[i];
        // Wrapped per pair so ANY failure for this pair (a bad base id, a
        // folder that doesn't look like a game, an identical tree, a
        // compare()/fingerprint() error) surfaces with the pair's label
        // attached, instead of an unlabeled message that leaves the caller
        // unable to tell which of possibly several pairs failed.
        try {
          var base = self.ModDiff.idbSource(db, msg.storeName, pair.baseVerId);
          // A pair supplies its modded tree either as a directory handle or,
          // where showDirectoryPicker does not exist, as an unpacked zip.
          var mod;
          if (pair.modHandle) {
            mod = await self.ModDiff.dirSource(pair.modHandle);
          } else if (pair.files) {
            mod = self.ModDiff.memSource(pair.files);
          } else {
            throw new Error("No modded folder was provided for this variant.");
          }
          // The Browser Player's plugins the modder ticked ride on top of
          // the tree from here on, so everything below (the space check,
          // the mode, the diff) sees them as part of the mod.
          if (pair.plugins && pair.plugins.length) {
            mod = await self.ModDiff.bundlePlugins(mod, base, pair.plugins);
          }
          // The base side gets the same "does this look like a game?" test
          // dirSource applies to the modded side, and for a much sharper
          // reason. If the base source yields nothing (a stale or mistyped
          // baseVerId, a gamever: prefix matching no keys, a parked version
          // whose files were never written) then compare() sees an empty
          // base against a full modded tree and classifies EVERY file as
          // new, so the entire base game is copied into payloads as the
          // modder's own work. That is precisely the leak this whole tool is
          // built to prevent, and it would look like a successful build.
          // Failing loudly here is the only place that catches it: the
          // fingerprint runs after compare, and a huge files list is
          // indistinguishable from a legitimately large mod.
          var baseNames = await base.list();
          if (!baseNames.length) {
            throw new Error(
              "The selected base game has no files in this browser's storage. " +
                "Re-import it in loader.html before building against it."
            );
          }
          if (!baseNames.some(function (n) { return n.indexOf("data/") === 0; })) {
            throw new Error(
              "The selected base game has no data/ files, so it does not look " +
                "like a game. Refusing to diff against it: every file would " +
                "be treated as something you added."
            );
          }
          // A mod is normally authored as an RPG Maker project, so the tree
          // handed over here usually names its files data/Actors.json where
          // the remaster ships data/be1a37535e921f91. The files stay where
          // the modder put them (their own engine opens them there); what is
          // computed is which base file stands behind each, so the diff can
          // leave the base's bytes out of the package. Against a base that
          // never hashed anything (pre-remaster) the names already agree.
          var modNames = await mod.list();
          var storage =
            self.ModDiff.pathSpace(baseNames) === "hashed"
              ? await self.ModDiff.storageNames(modNames)
              : new Map();
          var space = self.ModDiff.spaceProblem(baseNames, modNames);
          if (space) throw new Error(space);
          // A modded copy is either a whole modded game or just the files
          // the mod ships, and the same missing base path means "deleted" in
          // the first and "untouched" in the second. Auto is the default and
          // is what a modder who never opens that control gets; "full" and
          // "overlay" are their explicit answer and are taken as given. The
          // coverage is measured by the names the base uses.
          var covered = modNames.map(function (r) {
            var s = storage.get(r);
            return s === undefined ? r : s;
          });
          var mode =
            pair.mode === "full" || pair.mode === "overlay"
              ? pair.mode
              : self.ModDiff.detectMode(baseNames, covered).mode;

          var idx = i;
          var res = await self.ModDiff.compare(
            base,
            mod,
            payloads,
            function (done, total) {
              self.postMessage({ type: "progress", pair: idx, done: done, total: total });
            },
            { mode: mode, storage: storage }
          );
          if (!res.files.length) {
            throw new Error(
              mode === "overlay"
                ? "Every file in that folder is already identical to the base game (no changes)."
                : "The modded folder is identical to the base game (no changes)."
            );
          }
          var mismatch = self.ModDiff.pairProblem(res.stats);
          if (mismatch) throw new Error(mismatch);
          if (pair.plugins && pair.plugins.length) {
            res.stats.bundled = pair.plugins.map(function (p) { return p.name; });
          }
          var fp = await self.ModDiff.fingerprint(base);
          var baseMeta = { label: pair.label, fingerprint: fp };
          if (pair.steam) baseMeta.steam = pair.steam;
          variants.push({ base: baseMeta, files: res.files, stats: res.stats });
        } catch (pairErr) {
          throw new Error(
            'Variant "' + pair.label + '": ' + ((pairErr && pairErr.message) || pairErr)
          );
        }
      }
      self.postMessage({ type: "done", variants: variants, payloads: payloads });
    } catch (e) {
      self.postMessage({ type: "error", message: String((e && e.message) || e) });
    } finally {
      if (db) db.close();
    }
  };
}

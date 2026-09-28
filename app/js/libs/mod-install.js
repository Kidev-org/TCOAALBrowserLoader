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

/*
 * Installs a .tcoaalmod into the browser's game store: the in-browser twin of
 * applyModIntoProfile in tools/mod-loader.js.
 *
 * The native loader lays a package down over a hardlinked copy of the game.
 * Here the game already sits in IndexedDB under its plain keys and a mod's
 * files live beside it as "mod:{id}:{rel}", which the service worker overlays
 * on the base game (tryModOverlay). So each entry of the matching variant
 * becomes one mod key:
 *
 *   verbatim  the payload's bytes
 *   copy      the player's own file at `from`, decoded
 *   patch     the player's own file at `from` (or rel), decoded, JSON-parsed,
 *             RFC 6902 ops applied
 *   delete    nothing. The overlay has no way to hide a base file, and needs
 *             none: a mod's engine asks for its own names, and the catalog
 *             overhauls (installed file by file) have always run this way.
 *
 * Files are stored PLAIN, even where the entry says the native profile holds
 * them encrypted (`enc`): the service worker decodes whatever it serves before
 * the game sees it (dekit is a no-op on plain bytes), and every page-side
 * reader of mod keys (the language extraction, the boot repair) expects the
 * plain form.
 *
 * `from` is read the way the native loader reads it, out of the tree as it
 * stands: this install's own earlier write when it made one, the base game
 * otherwise. The base is always the active game in the plain-key namespace,
 * the same one app/create.html diffs against.
 *
 * Storage goes through a small adapter ({get, putMany, keys, deleteMany}) so
 * tools/test-mod-install.js runs this against a Map. idbStore() is the real one.
 *
 * Needs ModPackage (mod-package.js), TcoaalCodec (tcoaal-codec.js) and
 * JsonDiff (json-diff.js) loaded first.
 */
(function (root) {
  // hashPath("data/System.json"): where the shipped game keeps its System.
  var STD_SYSTEM = "data/be1a37535e921f91";
  // Writes are grouped so an install of a thousand files is a few dozen
  // transactions rather than a thousand, without holding more than a
  // handful of decoded files in memory at once.
  var BATCH = 24;

  function P() {
    return root.ModPackage;
  }
  function C() {
    return root.TcoaalCodec;
  }
  function J() {
    return root.JsonDiff;
  }

  /*
   * Every rel in a package names a key we write. IndexedDB cannot be escaped
   * through one the way a directory can, but the same names also reach the
   * service worker's URL matching and the native loader, so the rule is the
   * native loader's (safeRel in tools/mod-loader.js).
   */
  function safeRel(rel) {
    if (typeof rel !== "string" || !rel) return false;
    if (rel.indexOf("\\") !== -1) return false;
    if (rel.charAt(0) === "/" || /^[A-Za-z]:/.test(rel)) return false;
    return !rel.split("/").some(function (p) {
      return p === "" || p === "." || p === "..";
    });
  }

  // The mod id becomes a key prefix, a save-scope prefix and a localStorage
  // value. The package format's own ids are lowercase words and dashes
  // (validateId in create.html); anything else is refused outright.
  function safeId(id) {
    return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
  }

  function labelOf(variant) {
    return (
      (variant &&
        variant.base &&
        (variant.base.label ||
          (variant.base.steam && variant.base.steam.name))) ||
      "unnamed build"
    );
  }

  function toBytes(v) {
    if (v == null) return null;
    if (v instanceof Uint8Array) return v;
    // By tag rather than instanceof: a value from another realm (a worker's
    // structured clone, a test's vm context) is still an ArrayBuffer.
    if (Object.prototype.toString.call(v) === "[object ArrayBuffer]") {
      return new Uint8Array(v);
    }
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (ArrayBuffer.isView(v)) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    return null;
  }

  async function valueBytes(v) {
    if (typeof Blob !== "undefined" && v instanceof Blob) {
      return new Uint8Array(await v.arrayBuffer());
    }
    return toBytes(v);
  }

  // The active game's plain-key namespace: no "mod:", "gamever:" or "__"
  // prefix. The same filter as idbSource in mod-diff-worker.js, so the file
  // count here is the one create.html recorded in the variant's fingerprint.
  function isBaseKey(k) {
    return (
      k.indexOf("mod:") !== 0 &&
      k.indexOf("gamever:") !== 0 &&
      k.indexOf("__") !== 0
    );
  }

  // The release the player sees ("3.0.13"): js/main.js carries it as
  // GAME_VERSION, which is what create.html labels a variant with ("v3.0.13").
  // System.json's versionId is an editor build stamp nobody would recognise.
  function mainJsVersion(bytes) {
    if (!bytes) return null;
    var m = new TextDecoder()
      .decode(bytes)
      .match(/GAME_VERSION\s*=\s*["']([^"']+)["']/);
    return (m && m[1].trim()) || null;
  }

  async function describeBase(store) {
    var gameVersion = mainJsVersion(await valueBytes(await store.get("js/main.js")));
    var version = null;
    var sys = await valueBytes(await store.get(STD_SYSTEM));
    if (sys) {
      try {
        var doc = JSON.parse(
          new TextDecoder().decode(C().dekit(sys, STD_SYSTEM)),
        );
        if (doc && doc.versionId != null) version = String(doc.versionId);
      } catch (e) {}
    }
    var keys = await store.keys("");
    var files = 0;
    for (var i = 0; i < keys.length; i++) if (isBaseKey(keys[i])) files++;
    return { version: version, files: files, gameVersion: gameVersion };
  }

  /*
   * The game release a variant was built on, as dotted numbers ("3.0.13"),
   * or null. create.html writes it into the label ("v3.0.13", or a parked
   * version's own label); a fingerprint may carry it as gameVersion.
   */
  function variantGameVersion(variant) {
    var base = (variant && variant.base) || {};
    var fp = base.fingerprint || {};
    if (fp.gameVersion) return String(fp.gameVersion);
    var m = String(base.label || "").match(/(\d+(?:\.\d+)+)/);
    return m ? m[1] : null;
  }

  function versionParts(v) {
    return String(v)
      .split(".")
      .map(function (n) {
        return parseInt(n, 10) || 0;
      });
  }

  // How far apart two releases are, compared part by part from the major: a
  // different major outweighs any patch distance.
  function versionDistance(a, b) {
    var pa = versionParts(a);
    var pb = versionParts(b);
    var n = Math.max(pa.length, pb.length);
    var d = [];
    for (var i = 0; i < n; i++) d.push(Math.abs((pa[i] || 0) - (pb[i] || 0)));
    return d;
  }

  function compareDistance(da, db) {
    for (var i = 0; i < Math.max(da.length, db.length); i++) {
      var x = da[i] || 0;
      var y = db[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /*
   * Every variant, in the order to try them on this game. The ones built on
   * this exact game come first: System.json's versionId, then the file count
   * (what tools/mod-loader.js checks). Then the rest, nearest release first,
   * those whose release is unknown last. None is refused here: whether a
   * variant fits a game it was not built on is decided by trying it
   * (checkVariant), before anything is written.
   */
  function rankVariants(manifest, base) {
    var variants = ((manifest && manifest.variants) || []).slice();
    function exactness(v) {
      var fp = (v.base && v.base.fingerprint) || {};
      if (base.version && fp.version != null && String(fp.version) === base.version) {
        return 0;
      }
      if (fp.files === base.files) return 1;
      return 2;
    }
    var mine = base.gameVersion;
    return variants
      .map(function (v, i) {
        var gv = variantGameVersion(v);
        return {
          v: v,
          i: i,
          exact: exactness(v),
          dist: mine && gv ? versionDistance(mine, gv) : null,
        };
      })
      .sort(function (a, b) {
        if (a.exact !== b.exact) return a.exact - b.exact;
        if (a.dist && b.dist) {
          var c = compareDistance(a.dist, b.dist);
          if (c) return c;
        } else if (a.dist || b.dist) {
          return a.dist ? -1 : 1;
        }
        return a.i - b.i;
      })
      .map(function (x) {
        return x.v;
      });
  }

  /*
   * The variant built against this game, or null: the exact matches of
   * rankVariants only. Kept for callers that must not guess.
   */
  function selectVariant(manifest, base) {
    var ranked = rankVariants(manifest, base);
    if (!ranked.length) return null;
    var fp = (ranked[0].base && ranked[0].base.fingerprint) || {};
    var exact =
      (base.version && fp.version != null && String(fp.version) === base.version) ||
      fp.files === base.files;
    return exact ? ranked[0] : null;
  }

  /*
   * What a player is told when no variant fits their game: which release the
   * mod needs, in the words they would look for in Steam's betas list.
   * `short` fits a Mods-menu row; `message` says the rest.
   */
  function versionRequirement(manifest, base) {
    var seen = Object.create(null);
    var required = [];
    (manifest.variants || []).forEach(function (v) {
      var gv = variantGameVersion(v);
      if (gv && !seen[gv]) {
        seen[gv] = true;
        required.push(gv);
      }
    });
    var name = manifest.name || manifest.id;
    var short;
    if (!required.length) short = "Needs another game version";
    else if (required.length === 1) short = "v" + required[0] + " is required";
    else short = "v" + required.slice(0, -1).join(", v") + " or v" +
      required[required.length - 1] + " is required";
    var message =
      '"' + name + '" does not work with your version of the game' +
      (base.gameVersion ? " (v" + base.gameVersion + ")" : "") + ". " +
      (required.length ? short + "." : "It was built for: " +
        (manifest.variants || []).map(labelOf).join(", ") + ".");
    var err = new Error(message);
    err.code = "GAME_VERSION";
    err.required = required;
    err.short = short;
    return err;
  }

  /*
   * Which of a mod's files is its language data, for the service worker's
   * /lang-data.json merge.
   *
   * By content, not by name: a mod's engine can keep its dialogue anywhere
   * (languages/<lang>/dialogue.loc, data/dialogues, a LANGDATA blob under the
   * game's own hashed name data/9c7050ae76645487, ...), and a mod whose file
   * was not found got the base game's dialogue, which has none of its keys:
   * every line then showed as its raw key, "(label)[Narrator] (lines)[wait30]".
   * What every such file has in common is the tables the DRM reads, so a file
   * is language data when it holds one of their names and parses as JSON from
   * its first "{" (the .loc padding and the LANGDATA prefix both sit before
   * it). Media and scripts are never looked into.
   */
  var LANG_MARKERS = ["linesLUT", "labelLUT"];
  var NOT_LANG = /\.(png|jpe?g|webp|gif|bmp|ogg|m4a|mp3|wav|webm|mp4|ttf|otf|woff2?|js|css|html?|exe|dll|dat|pdf|md|txt|csv)$|^(img|audio|movies|fonts|icon|js)\//i;

  function hasAscii(bytes, needle) {
    var first = needle.charCodeAt(0);
    var n = needle.length;
    outer: for (var i = 0; i + n <= bytes.length; i++) {
      if (bytes[i] !== first) continue;
      for (var j = 1; j < n; j++) {
        if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
      }
      return true;
    }
    return false;
  }

  function mayBeLangFile(rel, plain) {
    if (NOT_LANG.test(rel)) return false;
    for (var i = 0; i < LANG_MARKERS.length; i++) {
      if (hasAscii(plain, LANG_MARKERS[i])) return true;
    }
    return false;
  }

  // Ranking between several candidates: the English file first (a mod that
  // ships translations ships English as the default), then the two layouts
  // the known overhauls use, then anything else in the order it came.
  function langRank(rel) {
    if (/^languages\/english\//i.test(rel)) return 0;
    if (/^data\/dialogues$/i.test(rel)) return 1;
    if (/^data\/9c7050ae76645487$/i.test(rel)) return 2;
    if (/^languages\//i.test(rel)) return 3;
    return 4;
  }

  /*
   * The language file among `candidates` ([{rel, bytes}], plain bytes) as
   * {rel, json}, json being the parsed document's text; null when none of
   * them parses into the tables the game reads.
   */
  function pickLangData(candidates) {
    var list = candidates.slice().sort(function (a, b) {
      return langRank(a.rel) - langRank(b.rel);
    });
    for (var i = 0; i < list.length; i++) {
      var text = new TextDecoder().decode(list[i].bytes);
      var at = text.indexOf("{");
      if (at < 0) continue;
      try {
        var doc = JSON.parse(text.slice(at));
        if (doc && (doc.linesLUT || doc.labelLUT)) {
          return { rel: list[i].rel, json: text.slice(at) };
        }
      } catch (e) {}
    }
    return null;
  }

  // Name-only guess, for callers that have the paths but not the bytes.
  function detectLangFile(rels) {
    var best = null;
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      var named =
        /^languages\/[^/]+\/dialogue\.(loc|pld)$/i.test(r) ||
        /^data\/dialogues$/i.test(r) ||
        /^data\/9c7050ae76645487$/i.test(r);
      if (named && (best === null || langRank(r) < langRank(best))) best = r;
    }
    return best;
  }

  // Online placeholders

  function httpsUrl(raw, what) {
    var url = String(raw || "");
    if (!/^https:\/\//i.test(url)) {
      throw new Error(what + " must be an https:// URL.");
    }
    return url;
  }

  async function fetchJson(fetchFn, url, headers) {
    var res = await fetchFn(url, { headers: headers || {} });
    if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
    return res.json();
  }

  /*
   * Where an online placeholder's real package is, as {url, page, label}.
   * The three source shapes of tools/mod-loader.js (resolveSource). For a
   * GitHub release the asset is fetched through the API's asset endpoint:
   * the browser_download_url on github.com answers without CORS headers, so
   * a page cannot read it.
   */
  async function resolveOnline(online, fetchFn) {
    var s = online || {};
    if (s.url) {
      var u = httpsUrl(s.url, "The download link");
      return { url: u, page: u, headers: {} };
    }
    if (s.manifest) {
      var doc = await fetchJson(fetchFn, httpsUrl(s.manifest, "The update file"));
      var url = doc.url || doc.download || (doc.latest && doc.latest.url);
      if (url) {
        var v = httpsUrl(url, "The link in the update file");
        return { url: v, page: v, headers: {} };
      }
    }
    if (s.github) {
      var page = "https://github.com/" + s.github + "/releases/latest";
      var rel = await fetchJson(
        fetchFn,
        "https://api.github.com/repos/" + s.github + "/releases/latest",
        { Accept: "application/vnd.github+json" },
      );
      var asset = (rel.assets || []).filter(function (a) {
        return /\.tcoaalmod$/i.test(a.name || "");
      })[0];
      if (asset && asset.url) {
        return {
          url: httpsUrl(asset.url, "The release asset"),
          page: page,
          headers: { Accept: "application/octet-stream" },
        };
      }
      throw new Error("The newest release of " + s.github + " has no .tcoaalmod attached.");
    }
    throw new Error("The file does not say where the mod is published.");
  }

  async function downloadOnline(placeholder, fetchFn, onProgress) {
    var src;
    try {
      src = await resolveOnline(placeholder.online, fetchFn);
    } catch (e) {
      throw new Error(
        'Could not find "' + (placeholder.name || placeholder.id) +
          '" to download: ' + ((e && e.message) || e),
      );
    }
    try {
      return await fetchBytes(fetchFn, src.url, src.headers, onProgress);
    } catch (e) {
      throw new Error(
        "This file is a link to the mod, not the mod itself, and the " +
          "download did not work here (" + ((e && e.message) || e) + "). " +
          "Download the .tcoaalmod from " + src.page + " and add that file.",
      );
    }
  }

  /*
   * A URL's body as bytes, reporting progress against Content-Length when
   * the server sends one. Shared with lang-shim's catalog install.
   */
  async function fetchBytes(fetchFn, url, headers, onProgress) {
    var res = await fetchFn(url, { headers: headers || {} });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var total = Number(res.headers && res.headers.get("content-length")) || 0;
    if (!res.body || !res.body.getReader) {
      return new Uint8Array(await res.arrayBuffer());
    }
    var reader = res.body.getReader();
    var chunks = [];
    var got = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      if (onProgress) onProgress(got, total);
    }
    var out = new Uint8Array(got);
    var o = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], o);
      o += chunks[i].length;
    }
    return out;
  }

  function quotaMessage(e) {
    var name = e && e.name;
    if (name === "QuotaExceededError" || /quota/i.test(String(e && e.message))) {
      return "Not enough storage space left in this browser for this mod.";
    }
    return null;
  }

  /*
   * Lay a package down under "mod:{id}:". Resolves to
   *   {id, manifest, variant, files, stats, icon, langFile, langData}
   * langData is the language file's parsed document as JSON text, or null.
   * and throws an Error whose message is written for a player.
   *
   * opts:
   *   store       adapter (idbStore(db) in a page)
   *   bytes       the .tcoaalmod (Uint8Array)
   *   id          key to install under; defaults to the package's own id
   *   fetch       fetch() for an online placeholder; without it one is refused
   *   onProgress  (fraction 0..1, message)
   */
  async function install(opts) {
    var store = opts.store;
    var progress = opts.onProgress || function () {};
    progress(0, "Opening the mod...");

    var pkg;
    try {
      pkg = await P().open(opts.bytes);
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (/tcoaal-share\//.test(msg)) {
        throw new Error("This is an older project-space mod and cannot be installed here.");
      }
      if (/ZIP|mod\.json/.test(msg)) {
        throw new Error("That file is not a .tcoaalmod mod (" + msg + ").");
      }
      throw new Error(msg);
    }

    var downloaded = false;
    if (pkg.manifest.online) {
      if (!opts.fetch) {
        throw new Error("This file is a link to the mod, not the mod itself.");
      }
      var placeholder = pkg.manifest;
      var dl = await downloadOnline(placeholder, opts.fetch, function (got, total) {
        progress(
          total ? 0.5 * Math.min(1, got / total) : 0,
          "Downloading " + (placeholder.name || placeholder.id) + "...",
        );
      });
      pkg = await P().open(dl);
      downloaded = true;
      // One hop, and the download must answer to the placeholder's id:
      // the same two rules as install() in tools/mod-loader.js.
      if (pkg.manifest.online) {
        throw new Error("The download is another link, not the mod.");
      }
      if (pkg.manifest.id !== placeholder.id) {
        throw new Error(
          'The download is "' + pkg.manifest.id + '", not "' + placeholder.id + '".',
        );
      }
    }

    var manifest = pkg.manifest;
    var zip = pkg.zip;
    var id = opts.id || manifest.id;
    if (!safeId(id)) throw new Error('Invalid mod file: bad mod id "' + id + '".');
    if (!Array.isArray(manifest.variants) || !manifest.variants.length) {
      throw new Error("Invalid mod file: no base variants.");
    }

    var base = await describeBase(store);
    if (!base.files) {
      throw new Error("Import your copy of the game first: this mod is applied on top of it.");
    }
    var prefix = "mod:" + id + ":";
    // A download already filled the first half of the bar.
    var offset = downloaded ? 0.5 : 0;

    // Reads the files one variant is made of. `own(rel)` answers with what
    // this install has produced for rel so far (null when nothing): `from`
    // is read out of the tree as it stands, the install's own earlier write
    // first, the base game otherwise, like the native loader.
    // A fault of the package itself, which no game version would fix: it is
    // reported as it is rather than as a version mismatch.
    function packageFault(message) {
      var e = new Error(message);
      e.packageFault = true;
      return e;
    }

    function makeApplier(variant, own, stats) {
      async function sourceBytes(f) {
        var src = f.from || f.rel;
        if (f.from && !safeRel(f.from)) {
          throw packageFault('Refusing an unsafe path in "' + id + '": ' + f.from);
        }
        var raw = (await own(src)) || (await valueBytes(await store.get(src)));
        if (!raw) {
          throw new Error(
            '"' + (manifest.name || id) + '" needs ' + src + " for " + f.rel +
              ", which is missing from your game. Your copy does not match " +
              "the build this mod was made for (" + labelOf(variant) + ").",
          );
        }
        return C().dekit(raw, src);
      }

      return async function plainOf(f) {
        if (!safeRel(f.rel)) {
          throw packageFault('Refusing an unsafe path in "' + id + '": ' + f.rel);
        }
        if (f.type === "verbatim") {
          var body = await zip.read(f.payload);
          if (!body) {
            throw packageFault('"' + id + '" is incomplete: missing ' + f.payload + " for " + f.rel + ".");
          }
          stats.verbatim++;
          // A payload is stored as the modder shipped it; plain unless it
          // arrived in a TCOAAL container, which is decoded here like any
          // other game file.
          return C().dekit(body, f.rel);
        }
        if (f.type === "copy") {
          stats.copied++;
          return sourceBytes(f);
        }
        if (f.type === "patch") {
          var srcPlain = await sourceBytes(f);
          var out;
          try {
            var doc = JSON.parse(new TextDecoder().decode(srcPlain));
            out = J().apply(doc, f.ops || []);
          } catch (e) {
            throw new Error(
              '"' + (manifest.name || id) + '" cannot patch ' + f.rel +
                ": your copy of that file is not the one it was made for.",
            );
          }
          stats.patched++;
          return new TextEncoder().encode(JSON.stringify(out));
        }
        throw packageFault('Unknown entry type "' + f.type + '" for ' + f.rel + ".");
      };
    }

    function entriesOf(variant) {
      return (variant.files || []).filter(function (f) {
        return f.type !== "delete";
      });
    }

    /*
     * Whether `variant` applies to this game, WITHOUT writing anything:
     * every copy and patch is replayed against the player's files and every
     * payload is looked up. Resolves to null when it applies, else to the
     * reason. This is what lets a mod built on another release be tried at
     * all, and what makes a refusal leave the store exactly as it was (the
     * installed version of an update included) instead of half-written.
     * A payload is only read when a later entry takes it as its `from`;
     * only those outputs are held.
     */
    async function checkVariant(variant) {
      var entries = entriesOf(variant);
      var wanted = Object.create(null);
      entries.forEach(function (f) {
        wanted[f.from || f.rel] = true;
      });
      var made = new Map();
      var plainOf = makeApplier(
        variant,
        async function (rel) {
          return made.get(rel) || null;
        },
        { written: 0, copied: 0, patched: 0, verbatim: 0, deleted: 0 },
      );
      try {
        for (var n = 0; n < entries.length; n++) {
          var f = entries[n];
          if (f.type === "verbatim" && !wanted[f.rel]) {
            if (!safeRel(f.rel)) {
              throw packageFault('Refusing an unsafe path in "' + id + '": ' + f.rel);
            }
            if (!zip.has(f.payload)) {
              throw packageFault('"' + id + '" is incomplete: missing ' + f.payload + " for " + f.rel + ".");
            }
            continue;
          }
          var out = await plainOf(f);
          if (wanted[f.rel]) made.set(f.rel, out);
        }
      } catch (e) {
        if (e && e.packageFault) throw e;
        return String((e && e.message) || e);
      }
      return null;
    }

    var ranked = rankVariants(manifest, base);
    var variant = null;
    var problems = [];
    for (var vi = 0; vi < ranked.length && !variant; vi++) {
      progress(offset, "Checking your game...");
      var problem = await checkVariant(ranked[vi]);
      if (problem) problems.push(labelOf(ranked[vi]) + ": " + problem);
      else variant = ranked[vi];
    }
    if (!variant) {
      var refusal = versionRequirement(manifest, base);
      refusal.problems = problems;
      throw refusal;
    }

    var entries = entriesOf(variant);
    var written = Object.create(null);
    var pending = Object.create(null);
    var stats = { written: 0, copied: 0, patched: 0, verbatim: 0, deleted: 0 };
    stats.deleted = (variant.files || []).length - entries.length;
    // This install's own write wins over the base: still in the batch being
    // assembled, or already flushed under the mod's prefix.
    var plainOf = makeApplier(
      variant,
      async function (rel) {
        if (pending[rel]) return pending[rel];
        if (written[rel]) return valueBytes(await store.get(prefix + rel));
        return null;
      },
      stats,
    );

    var total = entries.length;
    var files = [];
    var langCandidates = [];
    try {
      for (var i = 0; i < total; i += BATCH) {
        var batch = [];
        pending = Object.create(null);
        for (var j = i; j < Math.min(total, i + BATCH); j++) {
          var f = entries[j];
          var bytes = await plainOf(f);
          // An ArrayBuffer of exactly the file: a view into a larger buffer
          // (a stored ZIP entry, a dekit result) would otherwise be cloned
          // into IndexedDB whole.
          var buf =
            bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
              ? bytes.buffer
              : bytes.slice().buffer;
          if (mayBeLangFile(f.rel, bytes)) {
            langCandidates.push({ rel: f.rel, bytes: bytes });
          }
          batch.push([prefix + f.rel, buf]);
          pending[f.rel] = bytes;
          written[f.rel] = true;
          files.push(f.rel);
        }
        await store.putMany(batch);
        stats.written += batch.length;
        var done = Math.min(total, i + BATCH);
        progress(offset + (1 - offset) * 0.97 * (done / total), "Installing...");
      }
    } catch (e) {
      throw new Error(quotaMessage(e) || String((e && e.message) || e));
    }

    // A reinstall (or an update) must not leave a file the new package no
    // longer ships, which the overlay would go on serving over the base.
    var keep = Object.create(null);
    for (var k = 0; k < files.length; k++) keep[prefix + files[k]] = true;
    var stale = (await store.keys(prefix)).filter(function (key) {
      return !keep[key];
    });
    if (stale.length) await store.deleteMany(stale);

    var icon = null;
    if (manifest.icon && zip.has(manifest.icon)) icon = await zip.read(manifest.icon);

    var lang = pickLangData(langCandidates);
    progress(1, "Installed!");
    return {
      id: id,
      manifest: manifest,
      variant: variant,
      files: files,
      stats: stats,
      icon: icon,
      langFile: lang ? lang.rel : null,
      langData: lang ? lang.json : null,
    };
  }

  /* Remove every key a package install wrote for `id`. */
  async function remove(store, id) {
    var keys = await store.keys("mod:" + id + ":");
    if (keys.length) await store.deleteMany(keys);
    return keys.length;
  }

  // The IndexedDB adapter. Keys are strings; `keys(prefix)` returns every key
  // starting with prefix ("" for all) via a key-only range read.
  function idbStore(db, storeName) {
    var name = storeName || "assets";
    function req(r) {
      return new Promise(function (resolve, reject) {
        r.onsuccess = function () {
          resolve(r.result);
        };
        r.onerror = function () {
          reject(r.error);
        };
      });
    }
    function done(tx) {
      return new Promise(function (resolve, reject) {
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
        tx.onabort = function () {
          reject(tx.error || new Error("IndexedDB transaction aborted"));
        };
      });
    }
    return {
      get: function (key) {
        return req(db.transaction(name, "readonly").objectStore(name).get(key)).then(
          function (v) {
            return v === undefined ? null : v;
          },
        );
      },
      putMany: function (pairs) {
        var tx = db.transaction(name, "readwrite");
        var os = tx.objectStore(name);
        for (var i = 0; i < pairs.length; i++) os.put(pairs[i][1], pairs[i][0]);
        return done(tx);
      },
      keys: function (prefix) {
        var os = db.transaction(name, "readonly").objectStore(name);
        var range = prefix ? IDBKeyRange.bound(prefix, prefix + "\uffff") : null;
        return req(os.getAllKeys(range)).then(function (ks) {
          return ks.map(String);
        });
      },
      deleteMany: function (keys) {
        var tx = db.transaction(name, "readwrite");
        var os = tx.objectStore(name);
        for (var i = 0; i < keys.length; i++) os.delete(keys[i]);
        return done(tx);
      },
    };
  }

  root.ModInstall = {
    install: install,
    remove: remove,
    idbStore: idbStore,
    fetchBytes: fetchBytes,
    selectVariant: selectVariant,
    rankVariants: rankVariants,
    variantGameVersion: variantGameVersion,
    detectLangFile: detectLangFile,
    mayBeLangFile: mayBeLangFile,
    pickLangData: pickLangData,
    describeBase: describeBase,
    resolveOnline: resolveOnline,
    safeRel: safeRel,
    safeId: safeId,
  };
})(typeof self !== "undefined" ? self : this);

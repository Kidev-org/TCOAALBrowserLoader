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
 * The community mods: GitHub repositories known to publish a TCOAAL mod as a
 * .tcoaalmod attached to their releases, listed in app/community-mods.json.
 * A list of what exists, not a seal of approval: nothing on it is reviewed.
 * The desktop mod loader offers them for download beside the mods already
 * installed (tools/mod-loader.js --community, the "Available online" half of
 * the app's mod menu), and this is where a repository becomes what a row
 * shows. It never downloads a whole mod.
 *
 * Per repository:
 *   version      the latest release's tag ("v1.0.5" -> "1.0.5")
 *   package      that release's .tcoaalmod asset (its github.com download
 *                URL, which is not rate-limited like the API)
 *   .config/mod.json at the default branch's latest commit, the file the
 *                release workflow builds from (see tools/build-mod.js):
 *                "name" (default: the repository's name), "author" (the
 *                owner), "description" (the repository's description) and
 *                "thumbnail" (see thumbnailUrls), all optional
 *   id           the package's own mod id, read off the start of the package
 *                (mod.json is its first entry, so this costs a fraction of
 *                the download) and reused while the release asset is the
 *                same one (`known`)
 * A repository with no .config/mod.json falls back to its package's name and
 * description.
 *
 * GitHub serves release assets from a host that sends no CORS header, so
 * this runs where CORS does not apply (Node, in the mod loader). Needs
 * ModPackage (mod-package.js) loaded first; every network call goes through
 * the fetch function passed in.
 */
(function (root) {
  var FORMAT = "tcoaal-community-mods/1";
  // The repository's copy first, so a repo added to the list reaches every
  // launcher with one commit; the site's copy when GitHub cannot be reached.
  var LIST_URLS = [
    "https://raw.githubusercontent.com/Kidev-org/TCOAALBrowserLoader/main/app/community-mods.json",
    "https://tcoaal.app/community-mods.json",
  ];
  var API = "https://api.github.com/repos/";
  var RAW = "https://raw.githubusercontent.com/";

  function isRepo(s) {
    return (
      typeof s === "string" &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(s) &&
      !/\/\.\.?$/.test(s)
    );
  }

  // The same rule as ModInstall.safeId: the id becomes a storage prefix.
  function isModId(id) {
    return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
  }

  function str(v, max) {
    return typeof v === "string" ? v.trim().slice(0, max || 500) : "";
  }

  /* The valid, distinct repositories of a community-mods.json document. */
  function parseList(doc) {
    if (!doc || doc.format !== FORMAT || !Array.isArray(doc.repos)) {
      throw new Error("Not a community mods list (" + FORMAT + ").");
    }
    var seen = Object.create(null);
    var out = [];
    doc.repos.forEach(function (r) {
      if (!isRepo(r) || seen[r.toLowerCase()]) return;
      seen[r.toLowerCase()] = true;
      out.push(r);
    });
    return out;
  }

  async function getJson(fetchFn, url, headers) {
    var res = await fetchFn(url, { headers: headers || {}, cache: "no-store" });
    if (!res.ok) {
      var err = new Error(url + " answered " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function fetchList(fetchFn, urls) {
    var list = urls || LIST_URLS;
    var last = null;
    for (var i = 0; i < list.length; i++) {
      try {
        return parseList(await getJson(fetchFn, list[i]));
      } catch (e) {
        last = e;
      }
    }
    throw last || new Error("No community mods list.");
  }

  var DEFAULT_THUMBNAIL = "img/titles1/Book.png";

  // A path inside the repository as clean segments, or null for one that
  // would leave it.
  function repoPath(rel) {
    var parts = String(rel || "")
      .replace(/^\.\//, "")
      .split("/");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === "." || parts[i] === ".." || parts[i].indexOf("\\") !== -1) {
        return null;
      }
    }
    return parts;
  }

  /* A file of the repository at its default branch's latest commit. */
  function rawUrl(repo, rel) {
    var parts = repoPath(rel);
    return parts ? RAW + repo + "/HEAD/" + parts.map(encodeURIComponent).join("/") : null;
  }

  /*
   * Where the list icon may be, most likely first. `thumbnail` is an https
   * URL, a path from the repository root ("/art/thumb.png"), or a path in
   * the mod's www folder ("img/titles1/Book.png", the default: the title art
   * every RPG Maker MV game has, which an overhaul redraws). The www folder
   * is found the way tools/build-mod.js finds it (contentRoot): `content`'s
   * www/ when there is one, else `content` itself, and a raw URL cannot tell
   * which, so both are tried.
   */
  function thumbnailUrls(repo, cfg) {
    var t = str(cfg.thumbnail, 300) || DEFAULT_THUMBNAIL;
    if (/^https:\/\//i.test(t)) return [t];
    if (/^[a-z]+:/i.test(t)) return [];
    if (t.charAt(0) === "/") {
      var abs = rawUrl(repo, t.replace(/^\/+/, ""));
      return abs ? [abs] : [];
    }
    var content = str(cfg.content, 300).replace(/^\.?\/+|\/+$/g, "");
    if (content === ".") content = "";
    var base = content ? content + "/" : "";
    return [base + "www/" + t, base + t]
      .map(function (rel) {
        return rawUrl(repo, rel);
      })
      .filter(Boolean);
  }

  async function resolve(repo, fetchFn, known) {
    if (!isRepo(repo)) throw new Error("Not a repository: " + repo);
    var rel = await getJson(fetchFn, API + repo + "/releases/latest", {
      Accept: "application/vnd.github+json",
    });
    var asset = (rel.assets || []).filter(function (a) {
      return /\.tcoaalmod$/i.test(a.name || "");
    })[0];
    if (!asset || !asset.browser_download_url) {
      throw new Error("The latest release of " + repo + " has no .tcoaalmod.");
    }
    var tag = String(rel.tag_name || "");
    var packageUrl = asset.browser_download_url;

    var cfg = null;
    try {
      var doc = await getJson(fetchFn, RAW + repo + "/HEAD/.config/mod.json");
      if (doc && typeof doc === "object" && !Array.isArray(doc)) cfg = doc;
    } catch (e) {
      // A repository without the file (404) is still listed, from its package.
    }
    var info = cfg || {};

    var pkg;
    if (known && known.assetId === asset.id && isModId(known.id)) {
      pkg = { id: known.id, name: known.packageName, description: known.packageDescription };
    } else {
      var bytes = await root.ModPackage.fetchEntry(packageUrl, "mod.json", fetchFn);
      if (!bytes) throw new Error("Could not read the mod in the latest release of " + repo + ".");
      var m = JSON.parse(new TextDecoder().decode(bytes));
      pkg = { id: m.id, name: str(m.name, 60), description: str(m.description) };
    }
    if (!isModId(pkg.id)) throw new Error("The mod in " + repo + " has no valid id.");

    var owner = repo.split("/")[0];
    var repoName = repo.split("/")[1];
    var description = str(info.description);
    if (!description && cfg) description = await repoDescription(repo, fetchFn);

    return {
      repo: repo,
      id: pkg.id,
      name: str(info.name, 60) || (cfg ? "" : pkg.name) || repoName,
      author: str(info.author, 60) || owner,
      description: description || pkg.description || "",
      thumbnails: thumbnailUrls(repo, info),
      // The icon create.html's GitHub setup puts beside mod.json.
      configIcon: RAW + repo + "/HEAD/.config/icon.png",
      version: tag.replace(/^v/i, ""),
      tag: tag,
      publishedAt: String(rel.published_at || ""),
      page: "https://github.com/" + repo,
      assetId: asset.id,
      assetName: String(asset.name),
      size: Number(asset.size) || 0,
      package: packageUrl,
      packageName: pkg.name || "",
      packageDescription: pkg.description || "",
    };
  }

  // The repository's own description, "" when it has none or the API
  // cannot be reached (it is a default, never a reason to drop the row).
  async function repoDescription(repo, fetchFn) {
    try {
      var r = await getJson(fetchFn, API + repo, { Accept: "application/vnd.github+json" });
      return str(r && r.description);
    } catch (e) {
      return "";
    }
  }

  /*
   * Every repository of `repos`, resolved side by side. One that fails (no
   * release yet, a rate limit, a broken package) is reported in `errors` and
   * left out; `known` maps a repository to its previous result.
   */
  async function resolveAll(repos, fetchFn, known) {
    var results = await Promise.all(
      repos.map(function (repo) {
        return resolve(repo, fetchFn, known && known[repo]).then(
          function (mod) {
            return { mod: mod };
          },
          function (e) {
            return { error: { repo: repo, message: String((e && e.message) || e) } };
          },
        );
      }),
    );
    var mods = [];
    var errors = [];
    results.forEach(function (r) {
      if (r.mod) mods.push(r.mod);
      else errors.push(r.error);
    });
    return { mods: mods, errors: errors };
  }

  root.CommunityMods = {
    FORMAT: FORMAT,
    LIST_URLS: LIST_URLS,
    isRepo: isRepo,
    parseList: parseList,
    fetchList: fetchList,
    DEFAULT_THUMBNAIL: DEFAULT_THUMBNAIL,
    rawUrl: rawUrl,
    thumbnailUrls: thumbnailUrls,
    resolve: resolve,
    resolveAll: resolveAll,
  };
})(typeof self !== "undefined" ? self : this);

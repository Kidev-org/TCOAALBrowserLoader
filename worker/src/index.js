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
/*
 * Install counter for the Mods menu.
 *
 * Runs on the tcoaal.app/api/* route (same origin as the player, so the client
 * needs no CORS and the Android WebView works unchanged), backed by D1:
 *
 *   POST /api/dl/{modId}  -> count one install of {modId}. 204, no body.
 *   GET  /api/dl          -> every count as {"<modId>": <n>, ...}.
 *
 * It also backs the Achievements menu's player count and per-achievement
 * completion rates (see achievements-shim.js):
 *
 *   POST /api/achv/{mask}      -> count the achievements in {mask}. 204.
 *   POST /api/achv/{mask}?new=1 -> ... and count this browser as a new player.
 *   GET  /api/achv             -> {"players": <n>, "counts": {"<id>": <n>}}.
 *
 * The counts are deliberately public and unauthenticated: they say roughly how
 * popular a mod is (or how rare an achievement is), and nothing more. Anyone
 * can POST, so do not read them as audited figures.
 *
 * Neither id list is baked in here. Mod ids are validated against the live
 * mods.json, achievement ids against the ACHIEVEMENTS registry in the live
 * achievements-shim.js -- in both cases the one place that list already
 * exists. Adding a mod or an achievement therefore needs no redeploy of this
 * Worker, and there is no second copy to drift. Those checks are also what
 * keep the tables bounded to real ids: without them, anyone could write
 * unbounded junk rows.
 */

// Where the id allowlist comes from. Same origin as this Worker's route; the
// fetch goes back out through the edge, which serves it from cache.
const MODS_URL = "https://tcoaal.app/mods.json";

// The only site whose pages may count an install.
const ALLOWED_ORIGIN = "https://tcoaal.app";

// How long a fetched id list stays usable, in ms. Only bounds how soon a newly
// published mod can be counted, so minutes are fine and keep the origin quiet.
const IDS_TTL_MS = 10 * 60 * 1000;

// How long the edge may serve a cached GET /api/dl. The Mods menu is not a
// live dashboard: a few minutes stale keeps D1 reads near zero.
const COUNTS_TTL_S = 300;

// Where the achievement ids come from: the player's own shim, on this same
// origin. There is exactly ONE list of achievements in the project (the
// ACHIEVEMENTS registry in that file) and this reads it, for the same reason
// mod ids come from the live mods.json rather than a baked-in copy: a second
// list here would be a second thing to keep in step, with nothing to notice
// when it drifted. Adding an achievement needs no redeploy of this Worker.
const ACHV_SHIM_URL = "https://tcoaal.app/js/libs/achievements-shim.js";

// Hard ceiling on the achievement count. JavaScript's bitwise operators coerce
// to 32-bit SIGNED integers, so bit 31 is the sign bit (1 << 31 is negative)
// and bit 32 wraps silently onto bit 0 -- a 33rd achievement would quietly
// inflate the first one's count instead of failing. 31 usable bits (0..30) is
// the honest limit of a single-number mask; there are 20 today.
//
// Growing past this needs a real wire change (a second mask, or a list of
// ids). Refuse the whole list rather than corrupt counts in production.
const MAX_ACHIEVEMENTS = 31;

// Reserved row in the achievements table holding the total player count. Not a
// legal achievement id (the game's are `[A-Z0-9_]+`), so it can never collide.
const PLAYERS_ROW = "__players__";

// Isolate-local memo. Worker isolates are recycled freely, so treat this as a
// best-effort cache and never as the only guard: cf.cacheTtl below does the
// real work across isolates.
let _types = null;
let _typesAt = 0;

/**
 * Map of countable mod id -> its mods.json `type`. Doubles as the id allowlist
 * (a miss is a 404) and as the input to which rate limit applies.
 */
async function modTypes(now) {
  if (_types && now - _typesAt < IDS_TTL_MS) return _types;
  const res = await fetch(MODS_URL, { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error("mods.json " + res.status);
  const data = await res.json();
  const map = new Map();
  for (const [id, entry] of Object.entries(data)) {
    map.set(id, (entry && entry.type) || "");
  }
  _types = map;
  _typesAt = now;
  return map;
}

let _achvIds = null;
let _achvIdsAt = 0;

/**
 * Achievement ids in BIT ORDER (index i is bit `1 << i` of a posted mask),
 * read from the ACHIEVEMENTS registry in the shim.
 *
 * Scoped to that one array literal by bracket depth rather than scanning the
 * whole file: `id:` appears elsewhere in the shim, and picking up a stray one
 * would shift every bit after it.
 *
 * Doubles as the allowlist that bounds the achievements table: a mask bit with
 * no id here is rejected, so nothing but these rows can ever be written.
 */
async function achievementIds(now) {
  if (_achvIds && now - _achvIdsAt < IDS_TTL_MS) return _achvIds;
  const res = await fetch(ACHV_SHIM_URL, { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error("achievements-shim.js " + res.status);
  const src = await res.text();

  // Match the declaration TOGETHER WITH the start of its first entry.
  //
  // The deployed shim is terser-minified onto a single line (see the web
  // deploy workflow), so anchoring to a line start finds nothing in
  // production; and a bare search for the declaration can be fooled by a
  // comment quoting it, which broke this once already. Requiring `[{id:"` to
  // follow satisfies both: minification only removes whitespace between those
  // tokens, and prose about the registry is never followed by a real entry.
  const decl = /var\s+ACHIEVEMENTS\s*=\s*\[\s*\{\s*id\s*:\s*"/.exec(src);
  if (!decl) throw new Error("ACHIEVEMENTS registry not found");
  const open = src.indexOf("[", decl.index);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ACHIEVEMENTS registry unterminated");

  const ids = [];
  const re = /\bid:\s*"([A-Z0-9_]+)"/g;
  let m;
  while ((m = re.exec(src.slice(open, end + 1)))) ids.push(m[1]);

  // Treat anything unexpected as "cannot validate" (-> 503) rather than
  // guessing: a truncated or reshaped file must never become wrong rows.
  if (!ids.length) throw new Error("ACHIEVEMENTS registry empty");
  if (ids.length > MAX_ACHIEVEMENTS) {
    throw new Error(
      "ACHIEVEMENTS has " +
        ids.length +
        " entries; a 32-bit mask holds at most " +
        MAX_ACHIEVEMENTS,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("ACHIEVEMENTS has duplicate ids");
  }

  _achvIds = ids;
  _achvIdsAt = now;
  return ids;
}

function json(body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      extraHeaders || {},
    ),
  });
}

/**
 * True when this POST came from a page on some OTHER site.
 *
 * A cross-origin POST with no custom headers is a "simple request", so any
 * third-party page could otherwise make its visitors silently count installs
 * for us. Browsers set Origin on such a POST and it cannot be forged from page
 * script, so a foreign value is a reliable reject.
 *
 * A MISSING Origin is allowed through on purpose: curl never sends one (and
 * could trivially send ours anyway), so demanding it would block honest
 * clients and stop nobody. This narrows drive-by abuse from other people's
 * websites; it is not, and cannot be, a defence against a scripted attacker.
 */
function isForeignOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== ALLOWED_ORIGIN;
}

/**
 * Canonical Cache API key for GET /api/dl: a bare GET on this path, query
 * string dropped. Both the read (allCounts) and the write's invalidation
 * (countInstall) must build it the same way or the delete misses the entry.
 */
function countsCacheKey(url) {
  return new Request(url.origin + "/api/dl", { method: "GET" });
}

/** The same canonical-key trick for GET /api/achv. See countsCacheKey. */
function achvCacheKey(url) {
  return new Request(url.origin + "/api/achv", { method: "GET" });
}

/** POST /api/dl/{modId} */
async function countInstall(modId, env, now, request, ctx) {
  let types;
  try {
    types = await modTypes(now);
  } catch (e) {
    // mods.json unreachable: refuse rather than accept an unvalidated id, so a
    // blip upstream can never become junk rows we then have to clean out.
    return new Response("Cannot validate mod id", { status: 503 });
  }
  if (!types.has(modId)) return new Response("Unknown mod id", { status: 404 });

  // Per-IP ceiling, bucketed by how fast the honest version of this event can
  // repeat. Buckets are independent, so exhausting one never blocks another.
  //
  //   overhaul     2/min  ~1200 files, about a minute each: unreachable by hand
  //   translation  8/min  counted at ACTIVATION, not download (see
  //                       trackModInstall): each one costs a page reload, but
  //                       sampling several of the 14 languages is a real
  //                       pattern and must not be throttled into a bias
  //   plugin/other 5/min  1-3 files, ~1s each; a user may add a few in a row
  //
  // Note these limits are per Cloudflare location, not global: they blunt one
  // machine in a loop, not a distributed attacker. The WAF rule on /api/dl* is
  // what protects the account-wide Workers quota, since this check only runs
  // once the Worker is already executing.
  const type = types.get(modId);
  const limiter =
    type === "overhaul"
      ? env.OVERHAUL_LIMITER
      : type === "translation"
        ? env.TRANSLATION_LIMITER
        : env.PLUGIN_LIMITER;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await limiter.limit({ key: ip });
  if (!success) return new Response("Too many installs", { status: 429 });

  await env.DB.prepare(
    "INSERT INTO installs (mod_id, count, updated_at) VALUES (?1, 1, ?2)" +
      " ON CONFLICT(mod_id) DO UPDATE SET count = count + 1, updated_at = ?2",
  )
    .bind(modId, new Date(now).toISOString())
    .run();

  // Drop the edge-cached GET so the next read rebuilds it from D1. Without this
  // the write stays hidden for up to COUNTS_TTL_S: a user installs a mod, opens
  // the Mods menu, and is served the pre-install snapshot -- the count looks
  // broken. Cache.delete is per-colo, which covers the common "install then
  // look" loop from one place; other colos age out on their own TTL.
  ctx.waitUntil(caches.default.delete(countsCacheKey(new URL(request.url))));

  return new Response(null, { status: 204 });
}

/** GET (or HEAD) /api/dl */
async function allCounts(url, env, ctx) {
  // Canonical key (countsCacheKey): a bare GET for this path, query string
  // dropped.
  //
  // Keying on the live request would fold in its method and headers, so a HEAD
  // probe would miss the entry a GET populated (and Cache API rejects a put()
  // keyed on HEAD anyway). Keeping the query string would be worse: this
  // endpoint ignores it, so `?rand=1`, `?rand=2`, ... would each be a fresh
  // key, missing the cache and hitting D1 every time. Dropping it means every
  // spelling of this URL shares one cached response.
  const cache = caches.default;
  const key = countsCacheKey(url);
  const hit = await cache.match(key);
  if (hit) return hit;

  const { results } = await env.DB.prepare(
    "SELECT mod_id, count FROM installs",
  ).all();

  const out = {};
  for (const row of results || []) out[row.mod_id] = row.count;

  const res = json(out, {
    // max-age keeps the browser quiet between menu opens; s-maxage is what the
    // edge honours for the cache.put below.
    "Cache-Control": `public, max-age=60, s-maxage=${COUNTS_TTL_S}`,
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/**
 * POST /api/achv/{mask}[?new=1]
 *
 * `mask` is a decimal bitmask over ACHIEVEMENT_IDS naming the achievements to
 * count, each worth +1. `new=1` additionally counts this browser as one player.
 *
 * One number instead of one request per achievement: a browser that has played
 * offline for a while reports its whole backlog in a single POST, and the
 * common case (one fresh unlock) is a mask with one bit set.
 *
 * Counting once per browser is enforced on the client, which remembers what it
 * has already reported in localStorage keys our own clear-data buttons spare
 * (see reportUnlocks in achievements-shim.js). That is the same honour system
 * as the install counter: clearing site data lets someone count twice, which
 * costs them effort and buys them a slightly wrong popularity figure.
 */
async function countAchievements(maskRaw, isNew, env, now, request, ctx) {
  // Parse strictly. The route regex already bounds the length, so this only
  // has to reject a value that is out of range for the current id list.
  const mask = Number(maskRaw);
  if (!Number.isSafeInteger(mask) || mask < 0) {
    return new Response("Bad mask", { status: 400 });
  }
  if (mask === 0 && !isNew) return new Response(null, { status: 204 });

  let ids;
  try {
    ids = await achievementIds(now);
  } catch (e) {
    // Shim unreachable or unparseable: refuse rather than write rows we cannot
    // name, so a blip upstream can never become junk we have to clean out.
    // Same call as modTypes makes for mods.json.
    return new Response("Cannot validate achievements", { status: 503 });
  }
  // Every set bit must name a known achievement, or the client is running a
  // registry we do not have (or is making things up): refuse the whole POST
  // rather than silently dropping bits, so a version skew is loud.
  if (mask >= Math.pow(2, ids.length)) {
    return new Response("Unknown achievement bit", { status: 400 });
  }

  // One bucket for both events, and the tightest on this Worker: a first
  // launch reports its whole backlog in ONE masked POST, and after that it is
  // one POST per new unlock, tens of minutes apart. See wrangler.toml for how
  // the number was picked. A 429 makes the client roll back and retry on its
  // next boot, so throttling delays a count rather than losing it.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await env.ACHV_LIMITER.limit({ key: ip });
  if (!success) return new Response("Too many achievements", { status: 429 });

  const ts = new Date(now).toISOString();
  const upsert = env.DB.prepare(
    "INSERT INTO achievements (achv_id, count, updated_at) VALUES (?1, 1, ?2)" +
      " ON CONFLICT(achv_id) DO UPDATE SET count = count + 1, updated_at = ?2",
  );
  const stmts = [];
  if (isNew) stmts.push(upsert.bind(PLAYERS_ROW, ts));
  for (let i = 0; i < ids.length; i++) {
    if (mask & (1 << i)) stmts.push(upsert.bind(ids[i], ts));
  }
  // Bounded at 21 statements by the mask check above.
  await env.DB.batch(stmts);

  // Same reasoning as countInstall: drop the edge copy so the user who just
  // unlocked something does not open the menu and see the pre-unlock snapshot.
  ctx.waitUntil(caches.default.delete(achvCacheKey(new URL(request.url))));

  return new Response(null, { status: 204 });
}

/** GET (or HEAD) /api/achv */
async function allAchievements(url, env, ctx) {
  const cache = caches.default;
  const key = achvCacheKey(url);
  const hit = await cache.match(key);
  if (hit) return hit;

  const { results } = await env.DB.prepare(
    "SELECT achv_id, count FROM achievements",
  ).all();

  let players = 0;
  const counts = {};
  for (const row of results || []) {
    if (row.achv_id === PLAYERS_ROW) players = row.count;
    else counts[row.achv_id] = row.count;
  }

  const res = json(
    { players, counts },
    {
      "Cache-Control": `public, max-age=60, s-maxage=${COUNTS_TTL_S}`,
    },
  );
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Date.now() is called once per request and passed down: a Worker only
    // advances its clock on I/O, so this is the request's single timestamp.
    const now = Date.now();

    if (url.pathname === "/api/dl") {
      // HEAD as well as GET: a server that answers GET should answer HEAD, and
      // `curl -I` (the obvious way to poke at this) sends HEAD.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      return allCounts(url, env, ctx);
    }

    if (url.pathname === "/api/achv") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      return allAchievements(url, env, ctx);
    }

    // Up to 10 digits: comfortably past the 20-bit masks we accept, and short
    // enough that countAchievements' range check works on an exact Number.
    const a = url.pathname.match(/^\/api\/achv\/(\d{1,10})$/);
    if (a) {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (isForeignOrigin(request)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      return countAchievements(
        a[1],
        url.searchParams.get("new") === "1",
        env,
        now,
        request,
        ctx,
      );
    }

    const m = url.pathname.match(/^\/api\/dl\/([A-Za-z0-9_-]+)$/);
    if (m) {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (isForeignOrigin(request)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      return countInstall(m[1], env, now, request, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

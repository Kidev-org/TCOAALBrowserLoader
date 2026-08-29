-- Install counter for the Mods menu (see worker/src/index.js).
--
-- One row per mod, created on that mod's first install. Ids are validated
-- against the live mods.json before any write, so this table only ever holds
-- real mods (~34 rows today) and stays far inside D1's free storage.
--
-- Apply with:
--   wrangler d1 execute tcoaal-installs --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS installs (
  mod_id     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Achievement counters for the Achievements menu (see worker/src/index.js).
--
-- One row per achievement id, plus the single reserved row '__players__'
-- holding how many browsers have ever reported in. A menu row's percentage is
-- count / players, so both live in one table and are read in one query.
--
-- Keyed by ID rather than by bit index on purpose: the client sends a bitmask
-- (one number for all 20 achievements), but the wire order is a detail that
-- must not leak into stored data. Storing ids keeps the table readable and
-- survives any future reordering of the client registry.
--
-- Bounded at 21 rows: ACHIEVEMENT_IDS in src/index.js is the allowlist, so
-- nothing else can ever be written here.
CREATE TABLE IF NOT EXISTS achievements (
  achv_id    TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

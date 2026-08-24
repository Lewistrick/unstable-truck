-- Leaderboard storage: one row per (seed, nickname, difficulty), holding that
-- player's personal best for the day on that difficulty. input_log is the same
-- tick-index array the client stores locally, stored as JSONB so a selected
-- leaderboard entry can be replayed as a ghost exactly like a local personal
-- best. difficulty is an int rather than an enum so more tiers can be added
-- later without a migration: easy=1, hard=5 (gap left on purpose).
CREATE TABLE IF NOT EXISTS scores (
  seed TEXT NOT NULL,
  nickname TEXT NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 5,
  time_seconds DOUBLE PRECISION NOT NULL,
  stability DOUBLE PRECISION NOT NULL,
  input_log JSONB NOT NULL,
  medal TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seed, nickname, difficulty)
);

-- Leaderboard queries sort by time within a (seed, difficulty) pair; this index
-- covers both the WHERE filter and the ORDER BY time_seconds.
CREATE INDEX IF NOT EXISTS idx_scores_seed_difficulty_time ON scores (seed, difficulty, time_seconds);

-- The champion-medal threshold time for a (seed, difficulty) pair: any player
-- finishing at or under it earns the (top-tier) champion medal. It is derived
-- from that difficulty's gold par and the current world-record time on that
-- board, and is only ever lowered while the seed is the current day/week - once
-- that period passes the value is frozen, so a later record set on an old map
-- moves the leaderboard but not the medal. Stored separately from scores
-- because it is per-(seed, difficulty), not per-player.
CREATE TABLE IF NOT EXISTS champions (
  seed TEXT NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 5,
  champion_time DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seed, difficulty)
);

-- Precomputed "Optimal" solver routes: one row per daily seed, holding the
-- near-optimal delivery route the headless solver found (server/optimal.ts),
-- stored as the same tick-index input_log a ghost replays from. Solved ahead of
-- time so no player waits on the ~15s search, and frozen once written (a daily
-- map never changes). ticks/method/solver_ms are diagnostics.
CREATE TABLE IF NOT EXISTS optimal_routes (
  seed TEXT PRIMARY KEY,
  time_seconds DOUBLE PRECISION NOT NULL,
  stability DOUBLE PRECISION NOT NULL,
  input_log JSONB NOT NULL,
  ticks INTEGER,
  method TEXT,
  solver_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only run log: one row per run-lifecycle event, for inspecting what
-- players actually do (e.g. why a finish never reached the leaderboard). A run
-- emits a "started" row when it begins and one terminal row - "finished",
-- "cargo_fell_off", or "out_of_bounds" - when it ends, each stamped with the
-- number of warehouses collected so far and the server's clock. Purely
-- diagnostic: it never feeds scoring or the leaderboard.
-- Besides runs, this also captures home-screen interactions (navigation, mode
-- switches, pause/resume, replay start/stop, help open/toggle, username change).
-- `comment` is optional free-form context (e.g. an old->new nickname). Rows are
-- pruned after 7 days (see pruneOldRunLogs).
CREATE TABLE IF NOT EXISTS run_logs (
  id BIGSERIAL PRIMARY KEY,
  nickname TEXT NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL,
  collected INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Most inspection is "runs for this seed, newest first".
CREATE INDEX IF NOT EXISTS idx_run_logs_seed_created ON run_logs (seed, created_at DESC);
-- Global newest-first ordering (the /logs list) and the retention prune.
CREATE INDEX IF NOT EXISTS idx_run_logs_created ON run_logs (created_at DESC);

-- Cross-device sync: a token links multiple browsers to a shared identity.
-- The token is a short, human-readable code (e.g. "TRUCK-a3f9x2") that
-- players generate from one device and enter on another. The server stores
-- the synced state so any linked device can push/pull it.
CREATE TABLE IF NOT EXISTS accounts (
  token TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  difficulty TEXT,
  completed JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registered players. The username is the leaderboard identity: scores are
-- keyed by nickname text, so registering a name is what makes it protected
-- (see the submission guard in server/routes.ts).
--
-- username_lower is generated rather than written by hand so it can never drift
-- from username. It exists because uniqueness has to be case-insensitive while
-- the scores primary key is case-sensitive - without it, registering "Erick"
-- would leave "erick" free for someone else to submit under.
--
-- email is optional and UNVERIFIED: nothing is ever sent to it as things stand,
-- and nothing should be until a confirmation step exists.
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT GENERATED ALWAYS AS (lower(username)) STORED UNIQUE,
  password_hash  TEXT NOT NULL,
  email          TEXT,
  notify_daily   BOOLEAN NOT NULL DEFAULT FALSE,
  notify_updates BOOLEAN NOT NULL DEFAULT FALSE,
  is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Everything that used to live only in the browser's localStorage: completed
  -- and played days, the difficulty preference, total play time, the
  -- first-touch acquisition source, and the truck's appearance. One JSONB
  -- column rather than a table per concept, because it is read and written
  -- whole and never queried by field. See server/account-state.ts.
  country        TEXT,
  timezone       TEXT,
  user_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ
);

-- Login sessions. The client holds an opaque bearer token; only its SHA-256
-- hash is stored, so a database dump isn't a pile of live logins.
--
-- A bearer token rather than a cookie on purpose: the game is also served
-- inside a third-party iframe on itch.io, where third-party cookies are blocked
-- outright in Safari and in Chrome with 3p cookies off. An Authorization header
-- sidesteps all of it.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Deleting a user cascades to their sessions; the expiry sweep scans by date.
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

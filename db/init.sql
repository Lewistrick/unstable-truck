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

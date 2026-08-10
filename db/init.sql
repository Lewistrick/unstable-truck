-- Leaderboard storage: one row per (seed, nickname), holding that player's
-- personal best for the day. input_log is the same tick-index array the
-- client stores locally, stored as JSONB so a selected leaderboard entry can
-- be replayed as a ghost exactly like a local personal best.
CREATE TABLE IF NOT EXISTS scores (
  seed TEXT NOT NULL,
  nickname TEXT NOT NULL,
  time_seconds DOUBLE PRECISION NOT NULL,
  stability DOUBLE PRECISION NOT NULL,
  input_log JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seed, nickname)
);

-- Leaderboard queries sort by time within a seed; this index covers both the
-- WHERE seed = $1 filter and the ORDER BY time_seconds.
CREATE INDEX IF NOT EXISTS idx_scores_seed_time ON scores (seed, time_seconds);

-- The champion-medal threshold time for a seed: any player finishing at or
-- under it earns the (top-tier) champion medal. It is derived from the seed's
-- gold par and the current world-record time, and is only ever lowered while
-- the seed is the current day/week - once that period passes the value is
-- frozen, so a later record set on an old map moves the leaderboard but not the
-- medal. Stored separately from scores because it is per-seed, not per-player.
CREATE TABLE IF NOT EXISTS champions (
  seed TEXT PRIMARY KEY,
  champion_time DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only run log: one row per run-lifecycle event, for inspecting what
-- players actually do (e.g. why a finish never reached the leaderboard). A run
-- emits a "started" row when it begins and one terminal row - "finished",
-- "cargo_fell_off", or "out_of_bounds" - when it ends, each stamped with the
-- number of warehouses collected so far and the server's clock. Purely
-- diagnostic: it never feeds scoring or the leaderboard.
CREATE TABLE IF NOT EXISTS run_logs (
  id BIGSERIAL PRIMARY KEY,
  nickname TEXT NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL,
  collected INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Most inspection is "runs for this seed, newest first".
CREATE INDEX IF NOT EXISTS idx_run_logs_seed_created ON run_logs (seed, created_at DESC);

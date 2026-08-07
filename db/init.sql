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

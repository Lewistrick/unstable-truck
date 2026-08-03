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

import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface LeaderboardEntry {
  rank: number;
  nickname: string;
  time: number;
  stability: number;
}

/** Inserts or updates a player's score for a seed, but only takes effect if
 * it's better than what's already stored (or nothing is stored yet).
 * Returns whether the new score was actually saved. */
export async function upsertScoreIfBetter(params: {
  seed: string;
  nickname: string;
  time: number;
  stability: number;
  inputLog: number[];
}): Promise<boolean> {
  const { seed, nickname, time, stability, inputLog } = params;
  const result = await pool.query(
    `INSERT INTO scores (seed, nickname, time_seconds, stability, input_log)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (seed, nickname) DO UPDATE
       SET time_seconds = EXCLUDED.time_seconds,
           stability = EXCLUDED.stability,
           input_log = EXCLUDED.input_log,
           updated_at = now()
       WHERE scores.time_seconds > EXCLUDED.time_seconds
     RETURNING seed`,
    [seed, nickname, time, stability, JSON.stringify(inputLog)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Every score for a seed, ranked fastest-first. Fetched in full (rather
 * than paginated) since a single day's leaderboard is small at this scale;
 * callers slice out the top N and any rank-context window they need. */
export async function getSeedLeaderboard(seed: string): Promise<LeaderboardEntry[]> {
  const result = await pool.query<{ nickname: string; time_seconds: number; stability: number }>(
    `SELECT nickname, time_seconds, stability FROM scores WHERE seed = $1 ORDER BY time_seconds ASC`,
    [seed],
  );
  return result.rows.map((row, i) => ({
    rank: i + 1,
    nickname: row.nickname,
    time: row.time_seconds,
    stability: row.stability,
  }));
}

export interface StoredGhost {
  seed: string;
  nickname: string;
  time: number;
  stability: number;
  inputLog: number[];
}

/** A single player's full recording for a seed, including the input log -
 * used to build a ghost when a leaderboard row is selected. */
export async function getScore(seed: string, nickname: string): Promise<StoredGhost | null> {
  const result = await pool.query<{ nickname: string; time_seconds: number; stability: number; input_log: number[] }>(
    `SELECT nickname, time_seconds, stability, input_log FROM scores WHERE seed = $1 AND nickname = $2`,
    [seed, nickname],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { seed, nickname: row.nickname, time: row.time_seconds, stability: row.stability, inputLog: row.input_log };
}

export async function checkDatabaseHealth(): Promise<void> {
  await pool.query("SELECT 1");
}

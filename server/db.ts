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

/** Creates any tables that a fresh DB gets from db/init.sql but an already-
 * initialised one (whose init.sql ran before this table existed) would be
 * missing. init.sql only runs on first cluster init, so new tables need this
 * idempotent guard at startup. Safe to call every boot. */
export async function ensureSchema(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS champions (
       seed TEXT PRIMARY KEY,
       champion_time DOUBLE PRECISION NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** Lowers a seed's stored champion-medal threshold to `championTime`, but only
 * if it's lower than what's stored (or nothing is stored yet). The threshold
 * therefore only ratchets down - matching new world records - and a slower
 * submission (whose candidate threshold is higher) leaves it untouched. Callers
 * must gate this on the seed being the current period so past maps stay frozen.
 * Returns whether the stored value changed. */
export async function lowerChampionTime(seed: string, championTime: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO champions (seed, champion_time)
     VALUES ($1, $2)
     ON CONFLICT (seed) DO UPDATE
       SET champion_time = EXCLUDED.champion_time,
           updated_at = now()
       WHERE champions.champion_time > EXCLUDED.champion_time
     RETURNING seed`,
    [seed, championTime],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The stored champion-medal threshold for a seed, or null if none is set
 * (no record has beaten the gold par yet). */
export async function getChampionTime(seed: string): Promise<number | null> {
  const result = await pool.query<{ champion_time: number }>(
    `SELECT champion_time FROM champions WHERE seed = $1`,
    [seed],
  );
  return result.rows[0]?.champion_time ?? null;
}

/** Champion thresholds for several seeds at once, as a { seed: time } map
 * (seeds with no stored threshold are simply absent). Used to colour the
 * streak calendar without a per-day round trip. */
export async function getChampionTimes(seeds: string[]): Promise<Record<string, number>> {
  if (seeds.length === 0) return {};
  const result = await pool.query<{ seed: string; champion_time: number }>(
    `SELECT seed, champion_time FROM champions WHERE seed = ANY($1)`,
    [seeds],
  );
  const map: Record<string, number> = {};
  for (const row of result.rows) map[row.seed] = row.champion_time;
  return map;
}

export async function checkDatabaseHealth(): Promise<void> {
  await pool.query("SELECT 1");
}

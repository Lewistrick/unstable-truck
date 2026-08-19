import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Difficulty as stored in the DB: an int rather than an enum so more tiers can
 * be added later without a migration. Left a gap between the two (1, 5) for
 * that. Kept in sync with the client's "easy"/"hard" labels by the routes
 * layer, which is the only place the int and the label meet. */
export type DifficultyCode = 1 | 5;
export const EASY_CODE: DifficultyCode = 1;
export const HARD_CODE: DifficultyCode = 5;

export interface LeaderboardEntry {
  rank: number;
  nickname: string;
  time: number;
  stability: number;
}

/** Inserts or updates a player's score for a (seed, difficulty), but only
 * takes effect if it's better than what's already stored (or nothing is
 * stored yet). Returns whether the new score was actually saved. */
export async function upsertScoreIfBetter(params: {
  seed: string;
  nickname: string;
  difficulty: DifficultyCode;
  time: number;
  stability: number;
  inputLog: number[];
}): Promise<boolean> {
  const { seed, nickname, difficulty, time, stability, inputLog } = params;
  const result = await pool.query(
    `INSERT INTO scores (seed, nickname, difficulty, time_seconds, stability, input_log)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (seed, nickname, difficulty) DO UPDATE
       SET time_seconds = EXCLUDED.time_seconds,
           stability = EXCLUDED.stability,
           input_log = EXCLUDED.input_log,
           updated_at = now()
       WHERE scores.time_seconds > EXCLUDED.time_seconds
     RETURNING seed`,
    [seed, nickname, difficulty, time, stability, JSON.stringify(inputLog)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Every score for a (seed, difficulty), ranked fastest-first. Fetched in full
 * (rather than paginated) since a single day's leaderboard is small at this
 * scale; callers slice out the top N and any rank-context window they need. */
export async function getSeedLeaderboard(seed: string, difficulty: DifficultyCode): Promise<LeaderboardEntry[]> {
  const result = await pool.query<{ nickname: string; time_seconds: number; stability: number }>(
    `SELECT nickname, time_seconds, stability FROM scores WHERE seed = $1 AND difficulty = $2 ORDER BY time_seconds ASC`,
    [seed, difficulty],
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

/** A single player's full recording for a (seed, difficulty), including the
 * input log - used to build a ghost when a leaderboard row is selected. */
export async function getScore(seed: string, nickname: string, difficulty: DifficultyCode): Promise<StoredGhost | null> {
  const result = await pool.query<{ nickname: string; time_seconds: number; stability: number; input_log: number[] }>(
    `SELECT nickname, time_seconds, stability, input_log FROM scores WHERE seed = $1 AND nickname = $2 AND difficulty = $3`,
    [seed, nickname, difficulty],
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
       seed TEXT NOT NULL,
       difficulty INTEGER NOT NULL DEFAULT 5,
       champion_time DOUBLE PRECISION NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (seed, difficulty)
     )`,
  );
  // Difficulty split: every score and champion row gets a difficulty column
  // (easy=1, hard=5, default hard so pre-existing rows - all recorded before
  // difficulty existed - read back as hard runs), and each table's primary key
  // widens to include it so a player can hold a separate best per difficulty.
  // Guarded on the current PK's column count so this migration runs exactly
  // once per table, not on every boot.
  await pool.query(`ALTER TABLE scores ADD COLUMN IF NOT EXISTS difficulty INTEGER NOT NULL DEFAULT 5`);
  await pool.query(`ALTER TABLE champions ADD COLUMN IF NOT EXISTS difficulty INTEGER NOT NULL DEFAULT 5`);
  await pool.query(`
    DO $$
    BEGIN
      IF (
        SELECT COUNT(*) FROM information_schema.key_column_usage
        WHERE table_name = 'scores' AND constraint_name = 'scores_pkey'
      ) < 3 THEN
        ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_pkey;
        ALTER TABLE scores ADD CONSTRAINT scores_pkey PRIMARY KEY (seed, nickname, difficulty);
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF (
        SELECT COUNT(*) FROM information_schema.key_column_usage
        WHERE table_name = 'champions' AND constraint_name = 'champions_pkey'
      ) < 2 THEN
        ALTER TABLE champions DROP CONSTRAINT IF EXISTS champions_pkey;
        ALTER TABLE champions ADD CONSTRAINT champions_pkey PRIMARY KEY (seed, difficulty);
      END IF;
    END $$;
  `);
  // The old seed-only index is superseded by the (seed, difficulty, time) one
  // below; drop it once so it doesn't sit around as unused dead weight.
  await pool.query(`DROP INDEX IF EXISTS idx_scores_seed_time`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scores_seed_difficulty_time ON scores (seed, difficulty, time_seconds)`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS optimal_routes (
       seed TEXT PRIMARY KEY,
       time_seconds DOUBLE PRECISION NOT NULL,
       stability DOUBLE PRECISION NOT NULL,
       input_log JSONB NOT NULL,
       ticks INTEGER,
       method TEXT,
       solver_ms INTEGER,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS run_logs (
       id BIGSERIAL PRIMARY KEY,
       nickname TEXT NOT NULL,
       seed TEXT NOT NULL,
       status TEXT NOT NULL,
       collected INTEGER NOT NULL DEFAULT 0,
       comment TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  // Add the free-form comment column to run_logs tables created before it existed.
  await pool.query(`ALTER TABLE run_logs ADD COLUMN IF NOT EXISTS comment TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_logs_seed_created ON run_logs (seed, created_at DESC)`);
  // Global newest-first ordering (the /logs list) and the retention prune both
  // scan by created_at.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_logs_created ON run_logs (created_at DESC)`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS accounts (
       token TEXT PRIMARY KEY,
       nickname TEXT NOT NULL,
       difficulty TEXT,
       completed JSONB NOT NULL DEFAULT '[]',
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** Every kind of event written to run_logs. Kept in sync with the client's own
 * labels (src/game/api.ts). A run emits "started" then one terminal state;
 * everything else is a home-screen / session interaction. */
export type RunStatus =
  | "game_started"
  | "started"
  | "finished"
  | "cargo_fell_off"
  | "out_of_bounds"
  | "navigated"
  | "mode_switched"
  | "difficulty_switched"
  | "paused"
  | "resumed"
  | "replay_started"
  | "replay_stopped"
  | "help_opened"
  | "help_toggled"
  | "tutorial_started"
  | "tutorial_ended"
  | "menu_shown"
  | "shared"
  | "username_changed";

/** Appends one event to run_logs (server clock stamps it). `comment` is optional
 * free-form context (e.g. an old->new nickname). Purely diagnostic - callers
 * treat it as best-effort and log/swallow any failure so it never affects
 * gameplay or scoring. */
export async function logRun(params: {
  nickname: string;
  seed: string;
  status: RunStatus;
  collected: number;
  comment?: string | null;
}): Promise<void> {
  const { nickname, seed, status, collected, comment } = params;
  await pool.query(`INSERT INTO run_logs (nickname, seed, status, collected, comment) VALUES ($1, $2, $3, $4, $5)`, [
    nickname,
    seed,
    status,
    collected,
    comment ?? null,
  ]);
}

/** Deletes run_logs rows older than 7 days. Best-effort retention so the log
 * doesn't grow unbounded; returns how many rows were removed. */
export async function pruneOldRunLogs(): Promise<number> {
  const result = await pool.query(`DELETE FROM run_logs WHERE created_at < now() - INTERVAL '7 days'`);
  return result.rowCount ?? 0;
}

export interface RunLogRow {
  nickname: string;
  seed: string;
  status: string;
  collected: number;
  comment: string | null;
  createdAt: string;
}

/** A page of run-log rows, newest first, for the /logs inspector. */
export async function listRuns(limit: number, offset: number): Promise<RunLogRow[]> {
  const result = await pool.query<{
    nickname: string;
    seed: string;
    status: string;
    collected: number;
    comment: string | null;
    created_at: Date;
  }>(
    `SELECT nickname, seed, status, collected, comment, created_at
       FROM run_logs
       ORDER BY created_at DESC, id DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map((r) => ({
    nickname: r.nickname,
    seed: r.seed,
    status: r.status,
    collected: r.collected,
    comment: r.comment,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/** Lowers a (seed, difficulty)'s stored champion-medal threshold to
 * `championTime`, but only if it's lower than what's stored (or nothing is
 * stored yet). The threshold therefore only ratchets down - matching new world
 * records - and a slower submission (whose candidate threshold is higher)
 * leaves it untouched. Callers must gate this on the seed being the current
 * period so past maps stay frozen. Returns whether the stored value changed. */
export async function lowerChampionTime(seed: string, difficulty: DifficultyCode, championTime: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO champions (seed, difficulty, champion_time)
     VALUES ($1, $2, $3)
     ON CONFLICT (seed, difficulty) DO UPDATE
       SET champion_time = EXCLUDED.champion_time,
           updated_at = now()
       WHERE champions.champion_time > EXCLUDED.champion_time
     RETURNING seed`,
    [seed, difficulty, championTime],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Sets a (seed, difficulty)'s champion threshold only if none is stored yet,
 * then leaves it frozen (ON CONFLICT DO NOTHING never touches an existing
 * row). Used to seed a threshold for a day whose record already beats gold but
 * that never got one live - e.g. maps that predate this feature, or any past
 * day being viewed for the first time. Because it only ever fills a gap, a
 * later record on that day can't change the frozen value. Returns whether a
 * row was created. */
export async function backfillChampionTime(seed: string, difficulty: DifficultyCode, championTime: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO champions (seed, difficulty, champion_time)
     VALUES ($1, $2, $3)
     ON CONFLICT (seed, difficulty) DO NOTHING
     RETURNING seed`,
    [seed, difficulty, championTime],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The stored champion-medal threshold for a (seed, difficulty), or null if
 * none is set (no record has beaten the gold par yet). */
export async function getChampionTime(seed: string, difficulty: DifficultyCode): Promise<number | null> {
  const result = await pool.query<{ champion_time: number }>(
    `SELECT champion_time FROM champions WHERE seed = $1 AND difficulty = $2`,
    [seed, difficulty],
  );
  return result.rows[0]?.champion_time ?? null;
}

/** Champion thresholds for several seeds at once on one difficulty, as a
 * { seed: time } map (seeds with no stored threshold are simply absent). Used
 * to colour the streak calendar without a per-day round trip. */
export async function getChampionTimes(seeds: string[], difficulty: DifficultyCode): Promise<Record<string, number>> {
  if (seeds.length === 0) return {};
  const result = await pool.query<{ seed: string; champion_time: number }>(
    `SELECT seed, champion_time FROM champions WHERE seed = ANY($1) AND difficulty = $2`,
    [seeds, difficulty],
  );
  const map: Record<string, number> = {};
  for (const row of result.rows) map[row.seed] = row.champion_time;
  return map;
}

// --- Precomputed "Optimal" solver routes -----------------------------------
// One row per daily seed: the near-optimal route the solver found, stored in the
// same input-log format a leaderboard ghost uses so the client can race it
// directly. Computed ahead of time (see server/optimal.ts) so no player ever
// waits on the ~15s solve, and frozen once written - a daily map never changes.

export interface OptimalRoute {
  seed: string;
  time: number;
  stability: number;
  inputLog: number[];
}

/** The precomputed optimal route for a seed, or null if it hasn't been solved
 * (and stored) yet. */
export async function getOptimalRoute(seed: string): Promise<OptimalRoute | null> {
  const result = await pool.query<{ time_seconds: number; stability: number; input_log: number[] }>(
    `SELECT time_seconds, stability, input_log FROM optimal_routes WHERE seed = $1`,
    [seed],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { seed, time: row.time_seconds, stability: row.stability, inputLog: row.input_log };
}

/** Stores a solved route for a seed if none is stored yet (ON CONFLICT DO
 * NOTHING freezes the first result, so a daily map's Optimal ghost is stable).
 * `ticks`, `method`, and `solverMs` are diagnostics. Returns whether a row was
 * written. */
export async function saveOptimalRoute(params: {
  seed: string;
  time: number;
  stability: number;
  inputLog: number[];
  ticks?: number;
  method?: string;
  solverMs?: number;
}): Promise<boolean> {
  const { seed, time, stability, inputLog, ticks, method, solverMs } = params;
  const result = await pool.query(
    `INSERT INTO optimal_routes (seed, time_seconds, stability, input_log, ticks, method, solver_ms)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (seed) DO NOTHING
     RETURNING seed`,
    [seed, time, stability, JSON.stringify(inputLog), ticks ?? null, method ?? null, solverMs ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Which of the given seeds already have a stored optimal route, so a precompute
 * sweep can skip them without a query per seed. */
export async function getSolvedSeeds(seeds: string[]): Promise<Set<string>> {
  if (seeds.length === 0) return new Set();
  const result = await pool.query<{ seed: string }>(
    `SELECT seed FROM optimal_routes WHERE seed = ANY($1)`,
    [seeds],
  );
  return new Set(result.rows.map((r) => r.seed));
}

// --- Cross-device sync accounts ---------------------------------------------

export interface AccountData {
  token: string;
  nickname: string;
  difficulty: string | null;
  completed: string[];
}

export async function createAccount(token: string, nickname: string, difficulty: string | null, completed: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO accounts (token, nickname, difficulty, completed) VALUES ($1, $2, $3, $4::jsonb)`,
    [token, nickname, difficulty, JSON.stringify(completed)],
  );
}

export async function getAccount(token: string): Promise<AccountData | null> {
  const result = await pool.query<{ token: string; nickname: string; difficulty: string | null; completed: string[] }>(
    `SELECT token, nickname, difficulty, completed FROM accounts WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { token: row.token, nickname: row.nickname, difficulty: row.difficulty, completed: row.completed };
}

export async function updateAccount(token: string, nickname: string, difficulty: string | null, completed: string[]): Promise<boolean> {
  const result = await pool.query(
    `UPDATE accounts SET nickname = $2, difficulty = $3, completed = $4::jsonb, updated_at = now() WHERE token = $1 RETURNING token`,
    [token, nickname, difficulty, JSON.stringify(completed)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function checkDatabaseHealth(): Promise<void> {
  await pool.query("SELECT 1");
}

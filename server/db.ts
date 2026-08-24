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
  medal: string | null;
}): Promise<boolean> {
  const { seed, nickname, difficulty, time, stability, inputLog, medal } = params;
  const result = await pool.query(
    `INSERT INTO scores (seed, nickname, difficulty, time_seconds, stability, input_log, medal)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (seed, nickname, difficulty) DO UPDATE
       SET time_seconds = EXCLUDED.time_seconds,
           stability = EXCLUDED.stability,
           input_log = EXCLUDED.input_log,
           medal = EXCLUDED.medal,
           updated_at = now()
       WHERE scores.time_seconds > EXCLUDED.time_seconds
     RETURNING seed`,
    [seed, nickname, difficulty, time, stability, JSON.stringify(inputLog), medal],
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
  await pool.query(`ALTER TABLE scores ADD COLUMN IF NOT EXISTS medal TEXT`);
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
  // Registered players and their login sessions. See db/init.sql for why
  // username_lower is a generated column and why sessions store a hash.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS users (
       id             BIGSERIAL PRIMARY KEY,
       username       TEXT NOT NULL,
       username_lower TEXT GENERATED ALWAYS AS (lower(username)) STORED UNIQUE,
       password_hash  TEXT NOT NULL,
       email          TEXT,
       notify_daily   BOOLEAN NOT NULL DEFAULT FALSE,
       notify_updates BOOLEAN NOT NULL DEFAULT FALSE,
       is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
       country        TEXT,
       timezone       TEXT,
       user_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
       created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
       last_seen_at   TIMESTAMPTZ
     )`,
  );
  // For users tables created before these columns existed.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_state JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS sessions (
       token_hash   TEXT PRIMARY KEY,
       user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
       last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       expires_at   TIMESTAMPTZ NOT NULL
     )`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)`);
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

/** Deletes run_logs rows older than the retention window. Best-effort, so the
 * log doesn't grow unbounded; returns how many rows were removed.
 *
 * 90 days rather than the week this started as: the log is no longer only a
 * debugging aid, it's the source for acquisition and retention analysis. Both
 * a player's arrival and their return have to sit inside the window to be
 * counted as a return at all, so a short one silently under-reports exactly
 * the number that matters most - and makes the ?src= attribution on
 * game_started useless for anyone who comes back more than a week later. */
const RUN_LOG_RETENTION_DAYS = 90;

export async function pruneOldRunLogs(): Promise<number> {
  // Interpolated rather than bound: a bound parameter would have to be cast
  // into an interval, and INTERVAL wants a literal. Safe here because the value
  // is a numeric constant in this file, never anything user-supplied.
  const result = await pool.query(
    `DELETE FROM run_logs WHERE created_at < now() - INTERVAL '${RUN_LOG_RETENTION_DAYS} days'`,
  );
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

/** Every stored recording for a player, newest first.
 *
 * Capped rather than unbounded: input logs are the bulk of each row, and this
 * is fetched in one go when a player logs in on a new device. The cap sits well
 * above what the client can even use - it prunes daily bests at 30 days and
 * weekly ones at about a year. */
export async function getPlayerScores(
  nickname: string,
  limit: number,
): Promise<{ seed: string; difficulty: DifficultyCode; time: number; stability: number; inputLog: number[] }[]> {
  const result = await pool.query<{
    seed: string;
    difficulty: DifficultyCode;
    time_seconds: number;
    stability: number;
    input_log: number[];
  }>(
    `SELECT seed, difficulty, time_seconds, stability, input_log
     FROM scores WHERE nickname = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [nickname, limit],
  );
  return result.rows.map((row) => ({
    seed: row.seed,
    difficulty: row.difficulty,
    time: row.time_seconds,
    stability: row.stability,
    inputLog: row.input_log,
  }));
}

export interface PlayerStats {
  totalScores: number;
  worldFirsts: number;
  medals: { champion: number; gold: number; silver: number; bronze: number; none: number };
}

export async function getPlayerStats(nickname: string, difficulty: DifficultyCode): Promise<PlayerStats> {
  const result = await pool.query<{
    total_scores: string;
    world_firsts: string;
    champion: string;
    gold: string;
    silver: string;
    bronze: string;
    none: string;
  }>(
    `WITH ranked AS (
       SELECT nickname, medal,
              ROW_NUMBER() OVER (PARTITION BY seed ORDER BY time_seconds ASC) AS rn
       FROM scores
       WHERE difficulty = $2
         AND seed IN (SELECT seed FROM scores WHERE nickname = $1 AND difficulty = $2)
     )
     SELECT
       COUNT(*) AS total_scores,
       COUNT(*) FILTER (WHERE rn = 1) AS world_firsts,
       COUNT(*) FILTER (WHERE medal = 'champion') AS champion,
       COUNT(*) FILTER (WHERE medal = 'gold') AS gold,
       COUNT(*) FILTER (WHERE medal = 'silver') AS silver,
       COUNT(*) FILTER (WHERE medal = 'bronze') AS bronze,
       COUNT(*) FILTER (WHERE medal IS NULL) AS none
     FROM ranked
     WHERE nickname = $1`,
    [nickname, difficulty],
  );
  const row = result.rows[0]!;
  return {
    totalScores: Number(row.total_scores),
    worldFirsts: Number(row.world_firsts),
    medals: {
      champion: Number(row.champion),
      gold: Number(row.gold),
      silver: Number(row.silver),
      bronze: Number(row.bronze),
      none: Number(row.none),
    },
  };
}

// --- User accounts ----------------------------------------------------------

/** A user as the rest of the server sees them. Deliberately never carries
 * password_hash, so it can be returned to a client as-is. */
export interface UserRecord {
  id: number;
  username: string;
  email: string | null;
  notifyDaily: boolean;
  notifyUpdates: boolean;
  country: string | null;
  timezone: string | null;
  isAdmin: boolean;
}

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  notify_daily: boolean;
  notify_updates: boolean;
  country: string | null;
  timezone: string | null;
  is_admin: boolean;
}

// id is BIGSERIAL, which pg hands back as a string to avoid precision loss.
// Numbers this small are exactly representable, so narrowing here keeps the
// rest of the server dealing in plain numbers.
function toUserRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    notifyDaily: row.notify_daily,
    notifyUpdates: row.notify_updates,
    country: row.country,
    timezone: row.timezone,
    isAdmin: row.is_admin,
  };
}

const USER_COLUMNS = "id, username, email, notify_daily, notify_updates, country, timezone, is_admin";

/** Creates a user, or returns null if the username is already taken
 * (case-insensitively - see the generated username_lower column).
 *
 * Uses ON CONFLICT rather than catching a unique-violation error code, so a
 * taken username is an ordinary result rather than an exception that has to be
 * told apart from a real database failure. */
export async function createUser(params: {
  username: string;
  passwordHash: string;
  email: string | null;
  notifyDaily: boolean;
  notifyUpdates: boolean;
  country: string | null;
  timezone: string | null;
}): Promise<UserRecord | null> {
  const { username, passwordHash, email, notifyDaily, notifyUpdates, country, timezone } = params;
  const result = await pool.query<UserRow>(
    `INSERT INTO users (username, password_hash, email, notify_daily, notify_updates, country, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (username_lower) DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [username, passwordHash, email, notifyDaily, notifyUpdates, country, timezone],
  );
  const row = result.rows[0];
  return row ? toUserRecord(row) : null;
}

/** Looks a user up by name for login, including the stored password hash.
 * Case-insensitive, matching how usernames are made unique. */
export async function getUserForLogin(username: string): Promise<{ user: UserRecord; passwordHash: string } | null> {
  const result = await pool.query<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username_lower = lower($1)`,
    [username],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { user: toUserRecord(row), passwordHash: row.password_hash };
}

/** The stored password hash for a user id, used to confirm destructive changes
 * (password change, account deletion) against a live session. */
export async function getPasswordHash(userId: number): Promise<string | null> {
  const result = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.password_hash ?? null;
}

/** Whether a username is registered. This is the check that makes a name
 * protected on the leaderboard. */
export async function isUsernameTaken(username: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM users WHERE username_lower = lower($1)`, [username]);
  return (result.rowCount ?? 0) > 0;
}

export async function updateUserContactPrefs(
  userId: number,
  email: string | null,
  notifyDaily: boolean,
  notifyUpdates: boolean,
  country: string | null,
  timezone: string | null,
): Promise<UserRecord | null> {
  const result = await pool.query<UserRow>(
    `UPDATE users SET email = $2, notify_daily = $3, notify_updates = $4, country = $5, timezone = $6
     WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [userId, email, notifyDaily, notifyUpdates, country, timezone],
  );
  const row = result.rows[0];
  return row ? toUserRecord(row) : null;
}

export async function updateUserPassword(userId: number, passwordHash: string): Promise<void> {
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
}

/** Deletes a user; their sessions go with them via ON DELETE CASCADE.
 *
 * Their scores do NOT: those rows are keyed by nickname text, and deleting them
 * would tear holes in past leaderboards and break any ghost replaying against
 * them. It does mean the username becomes registerable again, and whoever takes
 * it inherits those scores. */
export async function deleteUser(userId: number): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

/** The account's stored state blob, exactly as written. Callers parse it -
 * db.ts stays SQL and knows nothing about the shape. */
export async function getUserState(userId: number): Promise<unknown> {
  const result = await pool.query<{ user_state: unknown }>(`SELECT user_state FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.user_state ?? null;
}

export async function saveUserState(userId: number, state: unknown): Promise<void> {
  await pool.query(`UPDATE users SET user_state = $2::jsonb WHERE id = $1`, [userId, JSON.stringify(state)]);
}

/** Grants admin to exactly the named users and revokes it from everyone else,
 * reporting whatever actually changed.
 *
 * Driven by the ADMIN_USERNAMES env var, so deployment config is the single
 * source of truth: taking a name out of it removes the rights on the next boot
 * rather than leaving a forgotten admin in the database. Idempotent - the WHERE
 * clause means a boot with nothing to change writes no rows at all.
 *
 * A name with no account is silently ignored; admin is granted the moment that
 * username registers. */
export async function syncAdmins(usernames: string[]): Promise<{ promoted: string[]; demoted: string[] }> {
  const lowered = usernames.map((u) => u.toLowerCase());
  const result = await pool.query<{ username: string; is_admin: boolean }>(
    `UPDATE users SET is_admin = (username_lower = ANY($1))
     WHERE is_admin <> (username_lower = ANY($1))
     RETURNING username, is_admin`,
    [lowered],
  );
  return {
    promoted: result.rows.filter((row) => row.is_admin).map((row) => row.username),
    demoted: result.rows.filter((row) => !row.is_admin).map((row) => row.username),
  };
}

export async function touchUserLastSeen(userId: number): Promise<void> {
  await pool.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);
}

// --- Sessions ---------------------------------------------------------------

export async function createSession(tokenHash: string, userId: number, expiresAt: Date): Promise<void> {
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

/** The user behind a session token hash, or null if there is no such session or
 * it has expired. Expiry is enforced here rather than left to the prune sweep,
 * so a token is dead the moment it lapses. */
export async function getSessionUser(tokenHash: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRow>(
    `SELECT u.id, u.username, u.email, u.notify_daily, u.notify_updates, u.country, u.timezone, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? toUserRecord(row) : null;
}

/** Slides a session's expiry forward on use, so an active player is never
 * logged out mid-streak. Rate-limited to once an hour by the WHERE clause -
 * without it this would be an extra write on every authenticated request. */
export async function touchSession(tokenHash: string, expiresAt: Date): Promise<void> {
  await pool.query(
    `UPDATE sessions SET last_used_at = now(), expires_at = $2
     WHERE token_hash = $1 AND last_used_at < now() - INTERVAL '1 hour'`,
    [tokenHash, expiresAt],
  );
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

/** Drops every session a user has. Called on password change, so changing a
 * password actually evicts whoever else was logged in. */
export async function deleteUserSessions(userId: number): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

/** Deletes lapsed sessions; returns how many. Runs on the same daily schedule
 * as the run-log prune. Expired sessions are already refused by
 * getSessionUser(), so this is housekeeping, not enforcement. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return result.rowCount ?? 0;
}

export async function checkDatabaseHealth(): Promise<void> {
  await pool.query("SELECT 1");
}

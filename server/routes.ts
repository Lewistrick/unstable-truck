import { Router, type Request } from "express";
import {
  backfillChampionTime,
  createAccount,
  EASY_CODE,
  getAccount,
  isUsernameTaken,
  getChampionTime,
  getChampionTimes,
  getOptimalRoute,
  getPlayerStats,
  getScore,
  getSeedLeaderboard,
  HARD_CODE,
  listRuns,
  logRun,
  lowerChampionTime,
  updateAccount,
  upsertScoreIfBetter,
  type DifficultyCode,
  type RunStatus,
  type UserRecord,
} from "./db.js";
import crypto from "node:crypto";
import { authenticate, requireAdmin } from "./auth.js";
import { ensureOptimalRoute } from "./optimal.js";
import { RateLimiter } from "./rate-limit.js";
import { validateReplay } from "./replay.js";
import type { Response } from "express";

export const scoresRouter = Router();

const MINUTE = 60_000;

const scoreByIp = new RateLimiter(30, MINUTE);
const scoreByAccount = new RateLimiter(10, MINUTE);
const runLogByIp = new RateLimiter(120, MINUTE);
const championByIp = new RateLimiter(30, MINUTE);
const championByAccount = new RateLimiter(10, MINUTE);

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

function tooManyRequests(res: Response, retryAfterSeconds: number): void {
  res.set("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "too many attempts, try again later" });
}

// Daily seeds are dates (YYYY-MM-DD); weekly seeds are ISO year+week
// (YYYY-Www, e.g. 2026-W31). Both are stored in the same scores table.
const DAILY_SEED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKLY_SEED_PATTERN = /^\d{4}-W\d{2}$/;
const isValidSeed = (seed: string): boolean => DAILY_SEED_PATTERN.test(seed) || WEEKLY_SEED_PATTERN.test(seed);
const MAX_NICKNAME_LENGTH = 16;
const TOP_N = 10;

/** Whether this request may submit under `nickname`.
 *
 * Anonymous play still works: a name nobody has registered is free for anyone,
 * exactly as before. Registering a name is what protects it - from then on only
 * a request carrying that account's session token may use it, which is what
 * makes a leaderboard row mean something.
 *
 * Comparison is case-insensitive on both sides. It has to be: the scores
 * primary key is case-sensitive, so matching exactly would leave "erick" open
 * to anyone the moment "Erick" registered. */
async function mayUseNickname(user: UserRecord | null, nickname: string): Promise<boolean> {
  if (!(await isUsernameTaken(nickname))) return true;
  return user !== null && user.username.toLowerCase() === nickname.toLowerCase();
}

/** Parses a client-supplied "easy"/"hard" difficulty label into its DB code,
 * defaulting to hard for anything else (missing, malformed, or - for old
 * clients that predate this feature - simply absent). Mirrors the client's
 * own default-to-hard rule for reading pre-difficulty data. */
function parseDifficulty(value: unknown): DifficultyCode {
  return value === "easy" ? EASY_CODE : HARD_CODE;
}
// run_logs accepts any seed the client actually played, including shared/orphan
// maps that aren't a live daily/weekly period, so it's length-capped rather than
// pattern-checked. Statuses mirror the client's labels; comments are free-form
// but length-capped.
const MAX_SEED_LENGTH = 64;
const MAX_COMMENT_LENGTH = 200;
const RUN_STATUSES = new Set<RunStatus>([
  "game_started",
  "started",
  "finished",
  "cargo_fell_off",
  "out_of_bounds",
  "navigated",
  "mode_switched",
  "difficulty_switched",
  "paused",
  "resumed",
  "replay_started",
  "replay_stopped",
  "help_opened",
  "help_toggled",
  "tutorial_started",
  "tutorial_ended",
  "menu_shown",
  "shared",
  "username_changed",
]);
// Cap the batch champions lookup so a single request can't ask for an unbounded
// number of seeds (the client only ever needs a month of daily seeds).
const MAX_CHAMPION_SEEDS = 40;

const VALID_MEDALS = new Set(["champion", "gold", "silver", "bronze"]);

interface SubmitBody {
  nickname: string;
  difficulty: DifficultyCode;
  time: number;
  stability: number;
  inputLog: number[];
  medal: string | null;
  /** The champion-medal threshold this run implies (gold + 3*time)/4, or null
   * when the run is slower than gold so it can't lower the threshold. */
  championCandidate: number | null;
  /** Whether this seed is the submitting client's *current* day/week. Only then
   * may the champion threshold move; past maps stay frozen. The client owns the
   * notion of "current" because seeds are keyed to its local date. */
  isCurrentPeriod: boolean;
}

function parseSubmission(body: unknown): SubmitBody | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const nickname = typeof b.nickname === "string" ? b.nickname.trim().slice(0, MAX_NICKNAME_LENGTH) : "";
  if (
    nickname.length === 0 ||
    typeof b.time !== "number" ||
    !Number.isFinite(b.time) ||
    b.time <= 0 ||
    typeof b.stability !== "number" ||
    !Number.isFinite(b.stability) ||
    !Array.isArray(b.inputLog) ||
    !b.inputLog.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)
  ) {
    return null;
  }
  // Champion fields are optional (older clients omit them); accept only a
  // positive finite number as a candidate, anything else means "no update".
  const championCandidate =
    typeof b.championCandidate === "number" && Number.isFinite(b.championCandidate) && b.championCandidate > 0
      ? b.championCandidate
      : null;
  const medal = typeof b.medal === "string" && VALID_MEDALS.has(b.medal) ? b.medal : null;
  return {
    nickname,
    difficulty: parseDifficulty(b.difficulty),
    time: b.time,
    stability: b.stability,
    inputLog: b.inputLog,
    medal,
    championCandidate,
    isCurrentPeriod: b.isCurrentPeriod === true,
  };
}

/** Submits a run's result. Only takes effect if it beats the player's
 * existing best for that seed (or they have none yet). */
scoresRouter.post("/api/scores/:seed", async (req: Request<{ seed: string }>, res) => {
  const { seed } = req.params;
  if (!isValidSeed(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD or YYYY-Www" });
    return;
  }
  const submission = parseSubmission(req.body);
  if (!submission) {
    res.status(400).json({ error: "invalid submission" });
    return;
  }
  const ipCheck = scoreByIp.check(clientIp(req));
  if (!ipCheck.allowed) { tooManyRequests(res, ipCheck.retryAfterSeconds); return; }

  const { championCandidate, isCurrentPeriod, ...score } = submission;
  try {
    // Resolved once and reused below: authenticate() slides the session's
    // expiry as a side effect, so calling it twice would double that write.
    const user = await authenticate(req);
    if (user) {
      const acctCheck = scoreByAccount.check(String(user.id));
      if (!acctCheck.allowed) { tooManyRequests(res, acctCheck.retryAfterSeconds); return; }
    }
    if (!(await mayUseNickname(user, score.nickname))) {
      res.status(403).json({ error: "that name is registered - log in to submit under it" });
      return;
    }

    const replayDifficulty = score.difficulty === EASY_CODE ? "easy" : "hard";
    try {
      const replay = await validateReplay(seed, replayDifficulty, score.inputLog, score.time);
      if (!replay.valid) {
        console.warn(`Replay rejected for ${seed} by ${score.nickname}: ${replay.reason}`);
        res.status(422).json({ error: replay.reason });
        return;
      }
    } catch (err) {
      console.error(`Replay validation error for ${seed}:`, (err as Error).message);
      res.status(503).json({ saved: false, error: "validation unavailable" });
      return;
    }

    const saved = await upsertScoreIfBetter({ seed, ...score });

    // Move the champion threshold down toward this run only while the seed is the
    // player's current period. lowerChampionTime() ignores candidates that aren't
    // lower than what's stored, so a non-record run never raises it and only a
    // genuine new world record ratchets it down.
    //
    // Lowering it also needs a logged-in submitter. The threshold only ever
    // ratchets down and is frozen once the period passes, so an unauthenticated
    // candidate of 0.001 would make a seed's champion medal permanently
    // unobtainable. An anonymous run is still saved and still ranks - only the
    // threshold is left alone, so the medal stays where it was until a logged-in
    // player beats it.
    if (isCurrentPeriod && championCandidate != null && user !== null) {
      const clamped = Math.max(championCandidate, score.time);
      await lowerChampionTime(seed, score.difficulty, clamped);
    }
    res.json({ saved });
  } catch (err) {
    // Surface a storage delivery failure (DB unreachable, etc.) in the server
    // logs - the client's submitScore silently swallows the non-2xx, so this is
    // where an otherwise-invisible drop becomes visible.
    console.error(`score submit failed for seed ${seed}:`, (err as Error).message);
    res.status(503).json({ saved: false, error: "storage unavailable" });
  }
});

/** Records one event: a run starting/ending, or a home-screen interaction
 * (navigation, mode switch, pause/resume, replay start/stop, help open/toggle,
 * username change). Best-effort diagnostics: it never gates gameplay, so a bad
 * payload is a 400 and a storage failure is a logged 503, but the client ignores
 * the outcome either way. */
scoresRouter.post("/api/runs", async (req, res) => {
  const ipCheck = runLogByIp.check(clientIp(req));
  if (!ipCheck.allowed) { tooManyRequests(res, ipCheck.retryAfterSeconds); return; }

  const b = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const nickname = typeof b.nickname === "string" ? b.nickname.trim().slice(0, MAX_NICKNAME_LENGTH) : "";
  const seed = typeof b.seed === "string" ? b.seed.slice(0, MAX_SEED_LENGTH) : "";
  const status = typeof b.status === "string" ? b.status : "";
  const collected =
    typeof b.collected === "number" && Number.isInteger(b.collected) && b.collected >= 0 ? b.collected : 0;
  const difficulty = typeof b.difficulty === "string" && (b.difficulty === "easy" || b.difficulty === "hard")
    ? b.difficulty : null;
  const comment = typeof b.comment === "string" && b.comment.length > 0 ? b.comment.slice(0, MAX_COMMENT_LENGTH) : null;
  if (nickname.length === 0 || seed.length === 0 || !RUN_STATUSES.has(status as RunStatus)) {
    res.status(400).json({ error: "invalid run log" });
    return;
  }
  try {
    // Same protected-name rule as score submission, but failing open: the row is
    // dropped and the client still gets a 200. logRun is best-effort diagnostics
    // (see src/game/api.ts) and must never become a source of user-visible
    // errors - and a forged log line is a far smaller problem than a forged
    // score.
    if (!(await mayUseNickname(await authenticate(req), nickname))) {
      res.json({ logged: false });
      return;
    }
    await logRun({ nickname, seed, status: status as RunStatus, collected, difficulty, comment });
    res.json({ logged: true });
  } catch (err) {
    console.error(`run log failed for seed ${seed} (${status}):`, (err as Error).message);
    res.status(503).json({ logged: false, error: "storage unavailable" });
  }
});

/** A page of run-log rows (newest first) for the /logs inspector. `limit` is
 * capped at 200; `offset` pages back through history.
 *
 * Admins only. Every row carries a player's name, the seed they were on, and
 * their acquisition source - being unlinked was never the same as being
 * private, and this is about to be reachable from an audience rather than just
 * from me. */
scoresRouter.get(
  "/api/runs",
  requireAdmin(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? ""), 10) || 100));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? ""), 10) || 0);
    const include = typeof req.query.include === "string" && req.query.include
      ? req.query.include.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const exclude = typeof req.query.exclude === "string" && req.query.exclude
      ? req.query.exclude.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    try {
      res.json(await listRuns(limit, offset, { include, exclude }));
    } catch (err) {
      console.error("run log list failed:", (err as Error).message);
      res.status(503).json({ error: "storage unavailable" });
    }
  }),
);

/** Seeds a seed's champion threshold if it doesn't have one yet (frozen once
 * set). Lets a client freeze the threshold for a day whose record already beats
 * gold but that never got one live - the client computes it from the level's
 * gold par and the day's record. Never overwrites an existing value, so it
 * can't move a frozen past-day threshold. */
scoresRouter.post("/api/champions/:seed", async (req: Request<{ seed: string }>, res) => {
  const ipCheck = championByIp.check(clientIp(req));
  if (!ipCheck.allowed) { tooManyRequests(res, ipCheck.retryAfterSeconds); return; }

  const { seed } = req.params;
  if (!isValidSeed(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD or YYYY-Www" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const championTime = body?.championTime;
  if (typeof championTime !== "number" || !Number.isFinite(championTime) || championTime <= 0) {
    res.status(400).json({ error: "championTime must be a positive number" });
    return;
  }
  const user = await authenticate(req);
  if (user === null) {
    res.status(401).json({ error: "not logged in" });
    return;
  }
  const acctCheck = championByAccount.check(String(user.id));
  if (!acctCheck.allowed) { tooManyRequests(res, acctCheck.retryAfterSeconds); return; }

  const created = await backfillChampionTime(seed, parseDifficulty(body?.difficulty), championTime);
  res.json({ created });
});

/** Champion-medal thresholds for a comma-separated list of seeds on one
 * difficulty, as a { seed: time } map. Powers the streak calendar's per-day
 * medal colours. */
scoresRouter.get("/api/champions", async (req: Request, res) => {
  const raw = typeof req.query.seeds === "string" ? req.query.seeds : "";
  const seeds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isValidSeed(s))
    .slice(0, MAX_CHAMPION_SEEDS);
  res.json(await getChampionTimes(seeds, parseDifficulty(req.query.difficulty)));
});

/** Top 10 for the (seed, difficulty), plus (if a nickname is given and isn't
 * already in the top 10) a rank-1/rank/rank+1 context window so an
 * off-the-charts player can still see where they stand. */
scoresRouter.get("/api/scores/:seed", async (req: Request<{ seed: string }>, res) => {
  const { seed } = req.params;
  if (!isValidSeed(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD or YYYY-Www" });
    return;
  }
  const nickname = typeof req.query.nickname === "string" ? req.query.nickname : null;
  const difficulty = parseDifficulty(req.query.difficulty);

  const [all, championTime] = await Promise.all([getSeedLeaderboard(seed, difficulty), getChampionTime(seed, difficulty)]);
  const top = all.slice(0, TOP_N);

  let context: typeof all = [];
  if (nickname) {
    const idx = all.findIndex((e) => e.nickname === nickname);
    if (idx >= TOP_N) {
      context = all.slice(idx - 1, idx + 2);
    }
  }

  res.json({ seed, top, context, championTime, total: all.length });
});

/** The precomputed near-optimal solver route for a daily seed, as a ghost
 * recording the client can race. Returns 404 when it hasn't been solved yet and
 * kicks off a background solve (the client falls back to solving locally that
 * once); the sweep in server/optimal.ts keeps the whole window filled so this is
 * usually a cache hit. Daily maps only - the solver targets the daily format. */
scoresRouter.get("/api/optimal/:seed", async (req: Request<{ seed: string }>, res) => {
  const { seed } = req.params;
  if (!DAILY_SEED_PATTERN.test(seed)) {
    res.status(400).json({ error: "optimal routes are only computed for daily (YYYY-MM-DD) seeds" });
    return;
  }
  try {
    const route = await getOptimalRoute(seed);
    if (route) {
      res.json(route);
      return;
    }
    void ensureOptimalRoute(seed); // start solving in the background for next time
    res.status(404).json({ error: "not computed yet" });
  } catch (err) {
    console.error(`optimal route lookup failed for seed ${seed}:`, (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

/** A specific player's full recording for a (seed, difficulty), for racing
 * their ghost. */
scoresRouter.get("/api/scores/:seed/:nickname", async (req: Request<{ seed: string; nickname: string }>, res) => {
  const { seed, nickname } = req.params;
  if (!isValidSeed(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD or YYYY-Www" });
    return;
  }
  const row = await getScore(seed, nickname, parseDifficulty(req.query.difficulty));
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

/** Aggregate statistics for a player on one difficulty. */
scoresRouter.get("/api/stats/:nickname", async (req: Request<{ nickname: string }>, res) => {
  const nickname = req.params.nickname.trim().slice(0, MAX_NICKNAME_LENGTH);
  if (!nickname) {
    res.status(400).json({ error: "nickname required" });
    return;
  }
  try {
    const stats = await getPlayerStats(nickname, parseDifficulty(req.query.difficulty));
    res.json(stats);
  } catch (err) {
    console.error(`stats lookup failed for ${nickname}:`, (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

// --- Cross-device sync accounts -------------------------------------------

function generateToken(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += chars[bytes[i]! % chars.length];
  return code;
}

const TOKEN_PATTERN = /^[a-z2-9]{6}$/;

/** Creates a new sync account from the current device's state and returns the
 * token. The client stores this token and uses it to push/pull state. */
scoresRouter.post("/api/account", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const nickname = typeof body.nickname === "string" ? body.nickname.trim().slice(0, MAX_NICKNAME_LENGTH) : "";
  if (!nickname) {
    res.status(400).json({ error: "nickname required" });
    return;
  }
  const difficulty = body.difficulty === "easy" || body.difficulty === "hard" ? body.difficulty : null;
  const completed = Array.isArray(body.completed) ? body.completed.filter((s): s is string => typeof s === "string") : [];
  const token = generateToken();
  try {
    await createAccount(token, nickname, difficulty, completed);
    res.json({ token });
  } catch (err) {
    console.error("account create failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

/** Fetches the synced state for a token. Used when linking a new device or
 * pulling updates. */
scoresRouter.get("/api/account/:token", async (req: Request<{ token: string }>, res) => {
  const { token } = req.params;
  if (!TOKEN_PATTERN.test(token)) {
    res.status(400).json({ error: "invalid token" });
    return;
  }
  try {
    const account = await getAccount(token);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(account);
  } catch (err) {
    console.error("account fetch failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

/** Pushes the current device's state to the server, merging completed days. */
scoresRouter.put("/api/account/:token", async (req: Request<{ token: string }>, res) => {
  const { token } = req.params;
  if (!TOKEN_PATTERN.test(token)) {
    res.status(400).json({ error: "invalid token" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const nickname = typeof body.nickname === "string" ? body.nickname.trim().slice(0, MAX_NICKNAME_LENGTH) : "";
  if (!nickname) {
    res.status(400).json({ error: "nickname required" });
    return;
  }
  const difficulty = body.difficulty === "easy" || body.difficulty === "hard" ? body.difficulty : null;
  const localCompleted = Array.isArray(body.completed) ? body.completed.filter((s): s is string => typeof s === "string") : [];
  try {
    const existing = await getAccount(token);
    if (!existing) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const merged = [...new Set([...existing.completed, ...localCompleted])].sort();
    await updateAccount(token, nickname, difficulty, merged);
    res.json({ token, nickname, difficulty, completed: merged });
  } catch (err) {
    console.error("account sync failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

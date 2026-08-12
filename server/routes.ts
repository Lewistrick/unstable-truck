import { Router, type Request } from "express";
import {
  backfillChampionTime,
  getChampionTime,
  getChampionTimes,
  getOptimalRoute,
  getScore,
  getSeedLeaderboard,
  listRuns,
  logRun,
  lowerChampionTime,
  upsertScoreIfBetter,
  type RunStatus,
} from "./db.js";
import { ensureOptimalRoute } from "./optimal.js";

export const scoresRouter = Router();

// Daily seeds are dates (YYYY-MM-DD); weekly seeds are ISO year+week
// (YYYY-Www, e.g. 2026-W31). Both are stored in the same scores table.
const DAILY_SEED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKLY_SEED_PATTERN = /^\d{4}-W\d{2}$/;
const isValidSeed = (seed: string): boolean => DAILY_SEED_PATTERN.test(seed) || WEEKLY_SEED_PATTERN.test(seed);
const MAX_NICKNAME_LENGTH = 24;
const TOP_N = 10;
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

interface SubmitBody {
  nickname: string;
  time: number;
  stability: number;
  inputLog: number[];
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
  return {
    nickname,
    time: b.time,
    stability: b.stability,
    inputLog: b.inputLog,
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
  const { championCandidate, isCurrentPeriod, ...score } = submission;
  try {
    const saved = await upsertScoreIfBetter({ seed, ...score });

    // Move the champion threshold down toward this run only while the seed is the
    // player's current period. lowerChampionTime() ignores candidates that aren't
    // lower than what's stored, so a non-record run never raises it and only a
    // genuine new world record ratchets it down.
    if (isCurrentPeriod && championCandidate != null) {
      await lowerChampionTime(seed, championCandidate);
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
  const b = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const nickname = typeof b.nickname === "string" ? b.nickname.trim().slice(0, MAX_NICKNAME_LENGTH) : "";
  const seed = typeof b.seed === "string" ? b.seed.slice(0, MAX_SEED_LENGTH) : "";
  const status = typeof b.status === "string" ? b.status : "";
  const collected =
    typeof b.collected === "number" && Number.isInteger(b.collected) && b.collected >= 0 ? b.collected : 0;
  const comment = typeof b.comment === "string" && b.comment.length > 0 ? b.comment.slice(0, MAX_COMMENT_LENGTH) : null;
  if (nickname.length === 0 || seed.length === 0 || !RUN_STATUSES.has(status as RunStatus)) {
    res.status(400).json({ error: "invalid run log" });
    return;
  }
  try {
    await logRun({ nickname, seed, status: status as RunStatus, collected, comment });
    res.json({ logged: true });
  } catch (err) {
    console.error(`run log failed for seed ${seed} (${status}):`, (err as Error).message);
    res.status(503).json({ logged: false, error: "storage unavailable" });
  }
});

/** A page of run-log rows (newest first) for the /logs inspector. `limit` is
 * capped at 200; `offset` pages back through history. */
scoresRouter.get("/api/runs", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? ""), 10) || 100));
  const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? ""), 10) || 0);
  try {
    res.json(await listRuns(limit, offset));
  } catch (err) {
    console.error("run log list failed:", (err as Error).message);
    res.status(503).json({ error: "storage unavailable" });
  }
});

/** Seeds a seed's champion threshold if it doesn't have one yet (frozen once
 * set). Lets a client freeze the threshold for a day whose record already beats
 * gold but that never got one live - the client computes it from the level's
 * gold par and the day's record. Never overwrites an existing value, so it
 * can't move a frozen past-day threshold. */
scoresRouter.post("/api/champions/:seed", async (req: Request<{ seed: string }>, res) => {
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
  const created = await backfillChampionTime(seed, championTime);
  res.json({ created });
});

/** Champion-medal thresholds for a comma-separated list of seeds, as a
 * { seed: time } map. Powers the streak calendar's per-day medal colours. */
scoresRouter.get("/api/champions", async (req: Request, res) => {
  const raw = typeof req.query.seeds === "string" ? req.query.seeds : "";
  const seeds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isValidSeed(s))
    .slice(0, MAX_CHAMPION_SEEDS);
  res.json(await getChampionTimes(seeds));
});

/** Top 10 for the seed, plus (if a nickname is given and isn't already in
 * the top 10) a rank-1/rank/rank+1 context window so an off-the-charts
 * player can still see where they stand. */
scoresRouter.get("/api/scores/:seed", async (req: Request<{ seed: string }>, res) => {
  const { seed } = req.params;
  if (!isValidSeed(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD or YYYY-Www" });
    return;
  }
  const nickname = typeof req.query.nickname === "string" ? req.query.nickname : null;

  const [all, championTime] = await Promise.all([getSeedLeaderboard(seed), getChampionTime(seed)]);
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

/** A specific player's full recording for a seed, for racing their ghost. */
scoresRouter.get("/api/scores/:seed/:nickname", async (req: Request<{ seed: string; nickname: string }>, res) => {
  const { seed, nickname } = req.params;
  if (!isValidSeed(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD or YYYY-Www" });
    return;
  }
  const row = await getScore(seed, nickname);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

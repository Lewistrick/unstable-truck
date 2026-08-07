import { Router, type Request } from "express";
import {
  getChampionTime,
  getChampionTimes,
  getScore,
  getSeedLeaderboard,
  lowerChampionTime,
  upsertScoreIfBetter,
} from "./db.js";

export const scoresRouter = Router();

// Daily seeds are dates (YYYY-MM-DD); weekly seeds are ISO year+week
// (YYYY-Www, e.g. 2026-W31). Both are stored in the same scores table.
const DAILY_SEED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKLY_SEED_PATTERN = /^\d{4}-W\d{2}$/;
const isValidSeed = (seed: string): boolean => DAILY_SEED_PATTERN.test(seed) || WEEKLY_SEED_PATTERN.test(seed);
const MAX_NICKNAME_LENGTH = 24;
const TOP_N = 10;
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
  const saved = await upsertScoreIfBetter({ seed, ...score });

  // Move the champion threshold down toward this run only while the seed is the
  // player's current period. lowerChampionTime() ignores candidates that aren't
  // lower than what's stored, so a non-record run never raises it and only a
  // genuine new world record ratchets it down.
  if (isCurrentPeriod && championCandidate != null) {
    await lowerChampionTime(seed, championCandidate);
  }
  res.json({ saved });
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

  res.json({ seed, top, context, championTime });
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

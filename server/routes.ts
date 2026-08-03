import { Router, type Request } from "express";
import { getScore, getSeedLeaderboard, upsertScoreIfBetter } from "./db.js";

export const scoresRouter = Router();

const SEED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NICKNAME_LENGTH = 24;
const TOP_N = 10;

interface SubmitBody {
  nickname: string;
  time: number;
  stability: number;
  inputLog: number[];
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
  return { nickname, time: b.time, stability: b.stability, inputLog: b.inputLog };
}

/** Submits a run's result. Only takes effect if it beats the player's
 * existing best for that seed (or they have none yet). */
scoresRouter.post("/api/scores/:seed", async (req: Request<{ seed: string }>, res) => {
  const { seed } = req.params;
  if (!SEED_PATTERN.test(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD" });
    return;
  }
  const submission = parseSubmission(req.body);
  if (!submission) {
    res.status(400).json({ error: "invalid submission" });
    return;
  }
  const saved = await upsertScoreIfBetter({ seed, ...submission });
  res.json({ saved });
});

/** Top 10 for the seed, plus (if a nickname is given and isn't already in
 * the top 10) a rank-1/rank/rank+1 context window so an off-the-charts
 * player can still see where they stand. */
scoresRouter.get("/api/scores/:seed", async (req: Request<{ seed: string }>, res) => {
  const { seed } = req.params;
  if (!SEED_PATTERN.test(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD" });
    return;
  }
  const nickname = typeof req.query.nickname === "string" ? req.query.nickname : null;

  const all = await getSeedLeaderboard(seed);
  const top = all.slice(0, TOP_N);

  let context: typeof all = [];
  if (nickname) {
    const idx = all.findIndex((e) => e.nickname === nickname);
    if (idx >= TOP_N) {
      context = all.slice(idx - 1, idx + 2);
    }
  }

  res.json({ seed, top, context });
});

/** A specific player's full recording for a seed, for racing their ghost. */
scoresRouter.get("/api/scores/:seed/:nickname", async (req: Request<{ seed: string; nickname: string }>, res) => {
  const { seed, nickname } = req.params;
  if (!SEED_PATTERN.test(seed)) {
    res.status(400).json({ error: "seed must be YYYY-MM-DD" });
    return;
  }
  const row = await getScore(seed, nickname);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

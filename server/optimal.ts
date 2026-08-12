import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getOptimalRoute, getSolvedSeeds, saveOptimalRoute } from "./db.js";

/** Server-side precompute of the daily "Optimal" solver routes.
 *
 * The point is that no player ever waits on the ~15s search: every browsable
 * daily map is solved ahead of time and stored, so the client just fetches the
 * finished route. This module owns a single reused worker thread (so the solve
 * never blocks HTTP handling) fed by a serial queue, plus a sweep that keeps the
 * whole browsable window solved and re-runs daily to pick up each new day. */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/dist/optimal.js -> project root is two levels up; the client build is
// its dist/ subtree. Both are present in the runtime image (see Dockerfile).
const projectRoot = path.join(__dirname, "..", "..");
const DIST_BASE = pathToFileURL(path.join(projectRoot, "dist") + path.sep).href;
const WORKER_URL = pathToFileURL(path.join(__dirname, "optimal-worker.js"));

// A gentle budget for the background solves - still lands gold on daily maps
// while leaving headroom well under the 60s / 1.5GB envelope.
const PRECOMPUTE_BUDGET_MS = 12000;

// The browsable daily window the client can navigate (must match main.ts's
// MAX_PAST_DAYS), plus a couple of days ahead so tomorrow's map is ready the
// instant the date rolls over for any client's timezone.
const PAST_DAYS = 30;
const FUTURE_DAYS = 2;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DAILY_SEED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface SolveReply {
  ok: boolean;
  seed: string;
  time?: number;
  stability?: number;
  inputLog?: number[];
  ticks?: number;
  method?: string;
  solverMs?: number;
  error?: string;
}

let worker: Worker | null = null;
const queue: string[] = [];
const queued = new Set<string>();
let draining = false;

/** Lazily starts (and, after a crash, restarts) the solver worker thread. */
function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    const w = new Worker(WORKER_URL);
    w.on("error", (err: Error) => {
      console.error("Optimal-route worker error:", err.message);
    });
    w.on("exit", () => {
      if (worker === w) worker = null;
    });
    worker = w;
    return w;
  } catch (err) {
    console.error("Optimal-route worker failed to start:", (err as Error).message);
    return null;
  }
}

/** Solves one seed on the worker thread. Serialized by the drain loop, so a
 * single in-flight solve means replies can be matched to `seed` directly. */
function solveOnWorker(seed: string): Promise<SolveReply | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onMessage = (reply: SolveReply) => {
      if (reply.seed !== seed) return;
      cleanup();
      resolve(reply);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onError);
    };
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onError);
    w.postMessage({ seed, distBase: DIST_BASE, timeBudgetMs: PRECOMPUTE_BUDGET_MS });
  });
}

/** Works through the queue one seed at a time, saving each solved route. */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const seed = queue.shift()!;
      queued.delete(seed);
      // Re-check in case it was stored since being enqueued.
      if (await getOptimalRoute(seed)) continue;
      const reply = await solveOnWorker(seed);
      if (reply?.ok && reply.inputLog) {
        await saveOptimalRoute({
          seed,
          time: reply.time!,
          stability: reply.stability!,
          inputLog: reply.inputLog,
          ticks: reply.ticks,
          method: reply.method,
          solverMs: reply.solverMs,
        });
        console.log(`Precomputed optimal route for ${seed}: ${reply.time!.toFixed(2)}s (${reply.method})`);
      } else if (reply && !reply.ok) {
        console.warn(`Optimal solve for ${seed} found no route: ${reply.error ?? "unknown"}`);
      }
    }
  } catch (err) {
    console.error("Optimal precompute drain failed:", (err as Error).message);
  } finally {
    draining = false;
  }
}

/** Queues a daily seed for solving if it isn't already stored or pending. */
function enqueue(seed: string): void {
  if (!DAILY_SEED_PATTERN.test(seed) || queued.has(seed)) return;
  queued.add(seed);
  queue.push(seed);
  void drain();
}

/** Ensures a seed's optimal route exists: returns it if already stored,
 * otherwise kicks off a background solve and returns null (the caller can serve
 * a "not ready yet" and the client falls back to its own local solve once). */
export async function ensureOptimalRoute(seed: string): Promise<Awaited<ReturnType<typeof getOptimalRoute>>> {
  if (!DAILY_SEED_PATTERN.test(seed)) return null;
  const existing = await getOptimalRoute(seed);
  if (existing) return existing;
  enqueue(seed);
  return null;
}

let genMods: { todaySeed: () => string; shiftSeed: (seed: string, delta: number) => string } | null = null;
async function loadGen(): Promise<NonNullable<typeof genMods>> {
  if (!genMods) {
    const mod = await import(new URL("level/generate.js", DIST_BASE).href);
    genMods = { todaySeed: mod.todaySeed, shiftSeed: mod.shiftSeed };
  }
  return genMods;
}

/** Queues every daily seed in the browsable window (plus a couple ahead) that
 * isn't solved yet - today first, then upcoming days, then back through the
 * past. Best-effort: a failure to reach the DB or the client build just leaves
 * the window to be filled lazily on demand. */
export async function precomputeWindow(): Promise<void> {
  try {
    const { todaySeed, shiftSeed } = await loadGen();
    const today = todaySeed();

    const offsets: number[] = [0];
    for (let o = 1; o <= FUTURE_DAYS; o++) offsets.push(o);
    for (let o = 1; o <= PAST_DAYS; o++) offsets.push(-o);
    const seeds = offsets.map((o) => shiftSeed(today, o));

    const solved = await getSolvedSeeds(seeds);
    let queuedCount = 0;
    for (const seed of seeds) {
      if (!solved.has(seed)) {
        enqueue(seed);
        queuedCount++;
      }
    }
    if (queuedCount > 0) {
      console.log(`Optimal precompute: queued ${queuedCount} unsolved daily map(s) (window ${today} -${PAST_DAYS}d..+${FUTURE_DAYS}d)`);
    }
  } catch (err) {
    console.error("Optimal precompute sweep failed:", (err as Error).message);
  }
}

/** Runs the sweep now and every 24h so each new day gets solved automatically. */
export function startPrecomputeSchedule(): void {
  void precomputeWindow();
  setInterval(() => void precomputeWindow(), SWEEP_INTERVAL_MS).unref();
}

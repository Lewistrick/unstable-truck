import { generateLevel } from "../level/generate.js";
import { solve } from "./solver.js";
import type { GhostRecording } from "./ghost.js";

/** Web Worker that runs the route solver off the main thread, so the up-to-15s
 * search never janks the UI. It takes a `{ seed, timeBudgetMs? }` request and
 * posts back a ghost recording (the same shape a personal best uses) plus the
 * solve's stats, or an error. Kept deliberately tiny - all the real work lives in
 * solver.ts, which is plain, DOM-free logic reused verbatim here and by the CLI. */

interface SolveRequest {
  seed: string;
  timeBudgetMs?: number;
}

export interface OptimalSolveResponse {
  ok: boolean;
  seed: string;
  recording?: GhostRecording;
  time?: number;
  stability?: number;
  method?: string;
  error?: string;
}

// `self` is the worker global scope; typed as `any` here to avoid pulling the
// separate WebWorker lib into the project's DOM-oriented tsconfig.
const worker = self as unknown as {
  onmessage: ((e: MessageEvent<SolveRequest>) => void) | null;
  postMessage: (message: OptimalSolveResponse) => void;
};

worker.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { seed, timeBudgetMs } = e.data;
  try {
    const level = generateLevel(seed);
    const result = solve(level, timeBudgetMs ? { timeBudgetMs } : {});
    if (!result.success) {
      worker.postMessage({ ok: false, seed, error: "no route found" });
      return;
    }
    const recording: GhostRecording = {
      seed,
      time: result.time,
      stability: result.stability,
      inputLog: result.inputLog,
    };
    worker.postMessage({ ok: true, seed, recording, time: result.time, stability: result.stability, method: result.method });
  } catch (err) {
    worker.postMessage({ ok: false, seed, error: String(err) });
  }
};

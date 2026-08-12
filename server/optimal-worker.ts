import { parentPort } from "node:worker_threads";

/** Worker-thread side of the server's route precompute. The solver is a
 * synchronous, CPU-bound search (up to ~15s), so running it on the main thread
 * would block every HTTP request for that long - it runs here instead, one seed
 * at a time, and posts the resulting ghost recording back.
 *
 * The solver lives in the browser build (dist/, compiled by the client's own
 * tsconfig), so it's pulled in with a runtime dynamic import from a file:// base
 * URL the main thread passes in - deliberately not a static import, so the
 * server's TypeScript build stays decoupled from the client's output tree. */

interface SolveRequest {
  seed: string;
  /** file:// URL of the client dist/ directory (with trailing slash). */
  distBase: string;
  timeBudgetMs: number;
}

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

// Cache the dynamically-imported modules across requests (the worker is reused).
let mods: { generateLevel: (seed: string) => unknown; solve: (level: unknown, opts: unknown) => any } | null = null;

async function loadModules(distBase: string): Promise<NonNullable<typeof mods>> {
  if (mods) return mods;
  const generateMod = await import(new URL("level/generate.js", distBase).href);
  const solverMod = await import(new URL("game/solver.js", distBase).href);
  mods = { generateLevel: generateMod.generateLevel, solve: solverMod.solve };
  return mods;
}

parentPort?.on("message", async (req: SolveRequest) => {
  const { seed, distBase, timeBudgetMs } = req;
  try {
    const { generateLevel, solve } = await loadModules(distBase);
    const level = generateLevel(seed);
    const result = solve(level, { timeBudgetMs });
    const reply: SolveReply = result.success
      ? {
          ok: true,
          seed,
          time: result.time,
          stability: result.stability,
          inputLog: result.inputLog,
          ticks: result.ticks,
          method: result.method,
          solverMs: result.elapsedMs,
        }
      : { ok: false, seed, error: "no route found" };
    parentPort?.postMessage(reply);
  } catch (err) {
    parentPort?.postMessage({ ok: false, seed, error: String(err) } satisfies SolveReply);
  }
});

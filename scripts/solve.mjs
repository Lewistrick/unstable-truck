// Headless optimal-route solver, run from the command line:
//   npm run build:client && node scripts/solve.mjs <seed> [timeBudgetMs]
//
// It finds a near-optimal delivery route for a daily seed and prints the
// toggle-tick input log - the exact JSON array the game persists in a ghost
// recording (GameSession.inputLog) - to stdout, so it can be piped or saved.
// A one-line human summary (time, medal-ish stats, method, search size) goes to
// stderr so it doesn't pollute the JSON on stdout.
//
// Resource envelope (mirrors the in-browser worker): a single core, a wall-clock
// budget (default 15s, capped to stay well under 60s), and A*'s state map bounded
// by the auto-scaled discretization - comfortably inside 1.5 GB for daily maps.
import { generateLevel } from "../dist/level/generate.js";
import { solve } from "../dist/game/solver.js";
import { computeMedalPars, medalFor } from "../dist/game/medals.js";

const seed = process.argv[2];
if (!seed) {
  console.error("usage: node scripts/solve.mjs <seed> [timeBudgetMs]");
  process.exit(2);
}
const timeBudgetMs = process.argv[3] ? Number(process.argv[3]) : undefined;

const level = generateLevel(seed);
const pickups = level.warehouses.filter((w) => w.kind === "pickup").length;
const result = solve(level, timeBudgetMs ? { timeBudgetMs } : {});

const pars = computeMedalPars(level);
const medal = result.success ? (medalFor(result.time, pars) ?? "none") : "n/a";

console.error(
  `seed=${seed} theme=${level.theme} pickups=${pickups} ` +
    `success=${result.success} time=${result.time.toFixed(2)}s (${result.ticks} ticks) ` +
    `medal=${medal} gold=${pars.gold}s stability=${Math.round(result.stability)}% ` +
    `method=${result.method} expanded=${result.expanded} elapsed=${result.elapsedMs}ms`,
);

// stdout: just the toggle-tick array, the replay/ghost inputLog format.
process.stdout.write(JSON.stringify(result.inputLog) + "\n");

if (!result.success) process.exit(1);

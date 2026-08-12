// Framework-free checks for the headless optimal-route solver, run like the
// other checks:
//   npm run build:client && node scripts/solver-check.mjs
//
// Two things are guarded here:
//   1. The solver's headless sim (game/sim.ts) must advance IDENTICALLY to a real
//      GameSession. The solver only produces valid routes because it steps the
//      same physics live play does; if the two ever drift, a "solved" input log
//      wouldn't reproduce when replayed as a ghost. We drive both from the same
//      pseudo-random input streams and assert their truck state matches tick for
//      tick.
//   2. A solved route must actually complete when replayed through a real
//      GameSession from just its toggle-tick input log (the exact ghost format),
//      finishing at the reported time without dropping cargo - and be at least
//      respectably fast (under the bronze par).
import { GameSession } from "../dist/game/session.js";
import { createSimContext, createSimState, stepSim } from "../dist/game/sim.js";
import { solve } from "../dist/game/solver.js";
import { generateLevel } from "../dist/level/generate.js";
import { computeMedalPars } from "../dist/game/medals.js";

const FIXED_DT = 1 / 60;

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

/** Whether the input was held at `tick`, from a toggle-tick log (mirrors the
 * private helper in game/ghost.ts). */
function heldAtTick(inputLog, tick) {
  let toggles = 0;
  for (const t of inputLog) {
    if (t > tick) break;
    toggles++;
  }
  return toggles % 2 === 1;
}

// --- 1. Headless sim matches GameSession tick for tick ---------------------
{
  const seeds = ["2026-01-01", "2026-08-11", "2026-03-17", "2026-11-30"];
  let allMatch = true;
  for (const seed of seeds) {
    const level = generateLevel(seed);
    const session = new GameSession(level);
    const ctx = createSimContext(level);
    const s = createSimState(ctx);

    // A varied but deterministic held pattern with occasional long holds, so both
    // straight driving and hard turns are exercised.
    let held = false;
    for (let tick = 0; tick < 2500; tick++) {
      if (tick % 37 === 0 || tick % 53 === 0) held = !held;
      session.update(FIXED_DT, held);
      stepSim(ctx, s, held, FIXED_DT);

      const a = session.truck;
      const b = s.truck;
      const same =
        a.pos.x === b.pos.x &&
        a.pos.y === b.pos.y &&
        a.heading === b.heading &&
        a.speed === b.speed &&
        a.angularVel === b.angularVel &&
        session.status === s.status &&
        session.visited.size === s.visitedCount;
      if (!same) {
        console.error(
          `  divergence on ${seed} at tick ${tick}: ` +
            `session=(${a.pos.x.toFixed(4)},${a.pos.y.toFixed(4)},${session.status}) ` +
            `sim=(${b.pos.x.toFixed(4)},${b.pos.y.toFixed(4)},${s.status})`,
        );
        allMatch = false;
        break;
      }
      if (session.status !== "playing") break;
    }
  }
  check("headless sim tracks GameSession exactly across seeds", allMatch, true);
}

// --- 2. Solved routes are valid and fast when replayed ---------------------
{
  const seeds = ["2026-08-05", "2026-08-01", "2026-08-11"];
  for (const seed of seeds) {
    const level = generateLevel(seed);
    const result = solve(level, { timeBudgetMs: 6000 });
    check(`${seed}: solve succeeded`, result.success, true);
    if (!result.success) continue;

    // Replay the toggle-tick log through a fresh, real GameSession exactly as a
    // ghost would, and confirm it delivers at the reported tick.
    const session = new GameSession(level);
    const finishTick = Math.round(result.time / FIXED_DT);
    while (session.status === "playing" && session.currentTick < finishTick) {
      session.update(FIXED_DT, heldAtTick(result.inputLog, session.currentTick));
    }
    check(`${seed}: replay of solved log reaches success`, session.status, "success");
    check(`${seed}: replay finishes at the reported tick`, session.currentTick, finishTick);

    const pars = computeMedalPars(level);
    check(`${seed}: solved time beats bronze par (${pars.bronze}s)`, result.time <= pars.bronze, true);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall solver checks passed");

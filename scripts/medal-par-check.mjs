// Framework-free checks that pin the geometry-derived medal pars for a few fixed
// seeds, run against compiled dist/ output:
//   npm run build:client && node scripts/medal-par-check.mjs
//
// computeMedalPars() sets gold/silver/bronze from a 2-opt-optimized ideal route
// and the DETOUR_FACTOR / GOLD_SPEED / multiplier constants (medals.ts), then
// rounds each tier up to a whole second with a half-second of headroom first
// (ceil(raw + 0.5)). These pin the resulting times for fixed seeds so any change
// to the route heuristic or the difficulty constants shows up as an intentional
// diff here rather than a silent shift in how hard medals are. Seeds are fixed
// strings (not date-derived) so the expected values never drift with the clock.
import { computeMedalPars } from "../dist/game/medals.js";
import { generateLevel, generateWeeklyLevel } from "../dist/level/generate.js";

let failures = 0;
function approx(name, actual, expected, tol = 0.01) {
  if (Math.abs(actual - expected) > tol) {
    console.error(`FAIL: ${name} - expected ~${expected}, got ${actual.toFixed(4)}`);
    failures++;
  } else {
    console.log(`ok: ${name} (${actual.toFixed(2)}s)`);
  }
}
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// Pinned medal times (whole seconds) for these fixed seeds, after the
// ceil(raw + 0.5) rounding. The raw geometry gold is noted alongside for
// reference (e.g. 11.3674 -> ceil(11.8674) = 12).
const cases = [
  { name: "daily 2026-08-01", level: generateLevel("2026-08-01"), gold: 12, silver: 14, bronze: 17 }, // raw gold ~11.37
  { name: "daily 2026-07-15", level: generateLevel("2026-07-15"), gold: 18, silver: 21, bronze: 26 }, // raw gold ~17.20
  { name: "weekly 2026-W30", level: generateWeeklyLevel("2026-W30"), gold: 158, silver: 187, bronze: 229 }, // raw gold ~157.42
];

for (const { name, level, gold, silver, bronze } of cases) {
  const pars = computeMedalPars(level);
  // Every tier is a whole number of seconds.
  check(`${name} tiers are whole seconds`, [pars.gold, pars.silver, pars.bronze].every(Number.isInteger));
  approx(`${name} gold`, pars.gold, gold);
  approx(`${name} silver`, pars.silver, silver);
  approx(`${name} bronze`, pars.bronze, bronze);
  // Tiers must stay strictly ordered fastest -> slowest.
  check(`${name} gold < silver < bronze`, pars.gold < pars.silver && pars.silver < pars.bronze);
}

if (failures > 0) {
  console.error(`\n${failures} medal-par check(s) failed`);
  process.exit(1);
}
console.log("\nall medal-par checks passed");

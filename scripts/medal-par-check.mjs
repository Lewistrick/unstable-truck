// Framework-free checks that pin the geometry-derived medal pars for a few fixed
// seeds, run against compiled dist/ output:
//   npm run build:client && node scripts/medal-par-check.mjs
//
// computeMedalPars() sets gold/silver/bronze from a 2-opt-optimized ideal route
// and the DETOUR_FACTOR / GOLD_SPEED / multiplier constants (medals.ts). These
// pin the resulting times for fixed seeds so any change to the route heuristic
// or the difficulty constants shows up as an intentional diff here rather than a
// silent shift in how hard medals are. Seeds are fixed strings (not date-derived)
// so the expected values never drift with the clock.
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

// Pinned gold times (seconds) for these fixed seeds. Silver/bronze follow from
// the multipliers, asserted separately below.
const cases = [
  { name: "daily 2026-08-01", level: generateLevel("2026-08-01"), gold: 11.3674 },
  { name: "daily 2026-07-15", level: generateLevel("2026-07-15"), gold: 17.2001 },
  { name: "weekly 2026-W30", level: generateWeeklyLevel("2026-W30"), gold: 157.4224 },
];

for (const { name, level, gold } of cases) {
  const pars = computeMedalPars(level);
  approx(`${name} gold`, pars.gold, gold);
  // Silver/bronze are the trimmed multiples of gold (method E: 1.18 / 1.45).
  approx(`${name} silver = gold * 1.18`, pars.silver, pars.gold * 1.18);
  approx(`${name} bronze = gold * 1.45`, pars.bronze, pars.gold * 1.45);
  // Tiers must stay strictly ordered fastest -> slowest.
  check(`${name} gold < silver < bronze`, pars.gold < pars.silver && pars.silver < pars.bronze);
}

if (failures > 0) {
  console.error(`\n${failures} medal-par check(s) failed`);
  process.exit(1);
}
console.log("\nall medal-par checks passed");

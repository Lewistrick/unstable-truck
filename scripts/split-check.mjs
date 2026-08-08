// Framework-free checks for the live split-time comparison, run the same way as
// the other checks:
//   npm run build:client && node scripts/split-check.mjs
//
// splitDelta() compares the player and a ghost by the *number* of warehouses
// collected (not which ones), at the player's latest checkpoint: (player tick -
// ghost tick) * dt. Negative = player ahead. This guards that count-based,
// order-independent comparison plus its null (no-checkpoint) cases.
import { splitDelta } from "../dist/game/ghost.js";

const DT = 0.1; // a round dt so the expected seconds are easy to read

let failures = 0;
function check(name, actual, expected) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) < 1e-9 : actual === expected;
  if (!ok) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// Player reached checkpoint 3 at tick 30; ghost at tick 40 -> 1.0s ahead.
check("ahead when the player's latest checkpoint is earlier", splitDelta([10, 20, 30], [12, 25, 40], DT), -1.0);

// Player slower to its 1st checkpoint -> positive (behind).
check("behind when the player's checkpoint is later", splitDelta([10], [5], DT), 0.5);

// Same tick -> exactly zero (counts as ahead/tied for coloring).
check("zero when the checkpoints tie", splitDelta([10, 20], [10, 20], DT), 0);

// Order-independent: it compares the k-th collection by time, whichever
// warehouse that was. Here both collected 2, so the 2nd ticks are compared.
check("compares by count, not which warehouse", splitDelta([10, 20], [15, 18], DT), 0.2);

// No checkpoint reached yet -> null (nothing to show).
check("null before any checkpoint", splitDelta([], [5, 9], DT), null);

// Player has collected more than the ghost ever did -> null (no counterpart).
check("null when the player is past the ghost's last checkpoint", splitDelta([1, 2, 3, 4], [1, 2, 3], DT), null);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall split checks passed");

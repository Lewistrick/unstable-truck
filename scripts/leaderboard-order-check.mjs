// Framework-free checks for where the solver's "Optimal" benchmark row sorts
// into the leaderboard, run like the other checks:
//   npm run build:client && node scripts/leaderboard-order-check.mjs
//
// The Optimal ghost is a benchmark time, not a pinned banner: it must slot into
// the fastest-first board by its own time, so a real player who out-drives it
// ranks ABOVE it. (Regression guard for the bug where it stayed pinned on top.)
import { optimalRowIndex } from "../dist/game/leaderboard-order.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// Fastest-first entry times used across the cases.
const board = [10.0, 12.5, 15.0, 20.0];

check("optimal faster than everyone -> top", optimalRowIndex(board, 8.0), 0);
check("optimal beats all but the leader", optimalRowIndex(board, 11.0), 1);
check("optimal in the middle", optimalRowIndex(board, 14.0), 2);
check("optimal beaten by a real player (the reported bug)", optimalRowIndex(board, 16.0), 3);
check("optimal slower than everyone -> last", optimalRowIndex(board, 25.0), board.length);

// A real entry that exactly ties the optimal time keeps its place above it.
check("exact tie keeps the real player above optimal", optimalRowIndex([10.0, 14.0], 14.0), 2);

// Degenerate boards.
check("empty board -> index 0", optimalRowIndex([], 12.0), 0);
check("single slower entry -> optimal first", optimalRowIndex([30.0], 12.0), 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall leaderboard-order checks passed");

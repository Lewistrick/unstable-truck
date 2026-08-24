// Framework-free checks for account state parsing and merging, run against
// compiled server output:
//   npm run build:server && node scripts/account-state-check.mjs
//
// or, without a Node toolchain on the host:
//   scripts/server-check.sh
//
// The merge rules are the part worth pinning down: getting them wrong silently
// loses a player's streak, and nothing in the game would obviously break.
import { EMPTY_STATE, mergeState, parseState } from "../server/dist/account-state.js";

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${name} - expected ${e}, got ${a}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// --- parsing is tolerant ----------------------------------------------------

check("null parses to empty", parseState(null), EMPTY_STATE);
check("garbage parses to empty", parseState("nonsense"), EMPTY_STATE);
check("unknown fields are dropped", parseState({ hax: 1 }), EMPTY_STATE);

// Seeds are client-supplied, so anything not shaped like one is discarded.
check(
  "only well-formed seeds survive",
  parseState({ completed: ["2026-08-21", "2026-W31", "'; DROP TABLE", "", 42] }).completed,
  ["2026-08-21", "2026-W31"],
);
check("duplicate seeds collapse", parseState({ played: ["2026-08-21", "2026-08-21"] }).played, ["2026-08-21"]);
check("bad difficulty becomes null", parseState({ difficulty: "brutal" }).difficulty, null);
check("good difficulty survives", parseState({ difficulty: "easy" }).difficulty, "easy");
check("negative play time floors at zero", parseState({ playTimeSeconds: -5 }).playTimeSeconds, 0);
check("play time is truncated to whole seconds", parseState({ playTimeSeconds: 12.7 }).playTimeSeconds, 12);
check("absurd play time is capped", parseState({ playTimeSeconds: 1e12 }).playTimeSeconds < 1e12, true);

// --- truck appearance -------------------------------------------------------

const truck = { primary: "#3a4653", secondary: "#2b3440", pattern: "diagonal" };
check("a valid truck survives", parseState({ truck }).truck, truck);
check("a bad pattern rejects the truck", parseState({ truck: { ...truck, pattern: "polkadot" } }).truck, null);
check("a bad colour rejects the truck", parseState({ truck: { ...truck, primary: "red" } }).truck, null);
check("a short hex rejects the truck", parseState({ truck: { ...truck, primary: "#abc" } }).truck, null);
check("a missing colour rejects the truck", parseState({ truck: { pattern: "striped" } }).truck, null);

// --- merging can only ever add ----------------------------------------------

const stored = parseState({
  completed: ["2026-08-20"],
  played: ["2026-08-20"],
  difficulty: "hard",
  playTimeSeconds: 600,
  source: "reddit",
});
const incoming = parseState({
  completed: ["2026-08-21"],
  played: ["2026-08-21"],
  difficulty: "easy",
  playTimeSeconds: 100,
  source: "itch",
});
const merged = mergeState(stored, incoming);

// A day delivered on a phone and a day delivered on a laptop are both real.
check("completed days are unioned", merged.completed, ["2026-08-20", "2026-08-21"]);
check("played days are unioned", merged.played, ["2026-08-20", "2026-08-21"]);
// A running total: the larger number has seen more of the player's history.
check("play time takes the larger", merged.playTimeSeconds, 600);
// A setting follows the person, so the account is the authority.
check("the account's difficulty wins", merged.difficulty, "hard");
// First-touch: the channel that won a player stays the answer.
check("the first acquisition source is kept", merged.source, "reddit");

// An account with nothing set yet adopts what the device brings.
const fresh = mergeState(EMPTY_STATE, incoming);
check("an empty account adopts the device's difficulty", fresh.difficulty, "easy");
check("an empty account adopts the device's source", fresh.source, "itch");
check("an empty account adopts the device's truck", mergeState(EMPTY_STATE, parseState({ truck })).truck, truck);

// Merging is idempotent and order-independent, which is what makes a dropped
// concurrent push heal itself on the next one rather than losing a day.
check("merging twice changes nothing", mergeState(merged, incoming), merged);
check("merge order doesn't matter for the union", mergeState(incoming, stored).completed, merged.completed);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall account-state checks passed");

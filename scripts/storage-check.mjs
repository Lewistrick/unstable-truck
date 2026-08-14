// Framework-free checks for the session-scoped ghost-race preferences and the
// persisted personal-best / difficulty storage, run the same way as
// scripts/collision-check.mjs (against the compiled dist/ output):
//   npm run build:client && node scripts/storage-check.mjs
//
// Guards the fix for the bug where the "race my own ghost" toggle wasn't
// remembered across levels, plus the per-seed leaderboard-ghost memory and the
// pruning of selections for maps that have aged out of the browse window - and,
// since the Easy/Hard split, that Easy and Hard keep entirely separate personal
// bests and leaderboard-ghost selections, and that a Hard personal best saved
// before that split still reads back correctly.
// sessionStorage/localStorage don't exist in Node, so we install a minimal
// in-memory mock before importing the module (which only touches storage when
// its functions are called, never at import time).

class MockStorage {
  #map = new Map();
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(key, String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
  key(i) {
    return [...this.#map.keys()][i] ?? null;
  }
  get length() {
    return this.#map.size;
  }
}

globalThis.sessionStorage = new MockStorage();
globalThis.localStorage = new MockStorage();

const {
  loadRacePbGhostPref,
  saveRacePbGhostPref,
  loadSelectedLeaderboardGhost,
  saveSelectedLeaderboardGhost,
  pruneLeaderboardGhosts,
  loadPersonalBest,
  savePersonalBestIfBetter,
  loadDifficultyPref,
  saveDifficultyPref,
} = await import("../dist/game/storage.js");

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// --- Global "race my own ghost" toggle ------------------------------------

// Defaults to on so a first-ever personal best still shows its ghost.
check("pb-ghost pref defaults to on", loadRacePbGhostPref(), true);

// Turning it off sticks (this is the bug: the choice must survive, not reset).
saveRacePbGhostPref(false);
check("pb-ghost pref remembers off", loadRacePbGhostPref(), false);

saveRacePbGhostPref(true);
check("pb-ghost pref remembers on again", loadRacePbGhostPref(), true);

// --- Per-seed, per-difficulty leaderboard opponent -------------------------

check("no leaderboard ghost remembered by default", loadSelectedLeaderboardGhost("2026-08-07", "hard"), null);

saveSelectedLeaderboardGhost("2026-08-07", "hard", "Racer42");
check("leaderboard ghost round-trips per seed", loadSelectedLeaderboardGhost("2026-08-07", "hard"), "Racer42");

// Selections are independent per seed.
check("a different seed has no selection", loadSelectedLeaderboardGhost("2026-08-06", "hard"), null);

// ...and independent per difficulty on the *same* seed - a ghost picked on
// Hard shouldn't leak into Easy's selection or vice versa.
check("the same seed's easy board has no selection yet", loadSelectedLeaderboardGhost("2026-08-07", "easy"), null);
saveSelectedLeaderboardGhost("2026-08-07", "easy", "EasyRacer");
check("hard selection is unaffected by the easy one", loadSelectedLeaderboardGhost("2026-08-07", "hard"), "Racer42");
check("easy selection round-trips independently", loadSelectedLeaderboardGhost("2026-08-07", "easy"), "EasyRacer");

// Passing null clears it (deselecting the opponent).
saveSelectedLeaderboardGhost("2026-08-07", "hard", null);
check("leaderboard ghost can be cleared", loadSelectedLeaderboardGhost("2026-08-07", "hard"), null);
check("clearing hard's selection leaves easy's alone", loadSelectedLeaderboardGhost("2026-08-07", "easy"), "EasyRacer");
saveSelectedLeaderboardGhost("2026-08-07", "easy", null);

// --- Pruning old maps ------------------------------------------------------

saveSelectedLeaderboardGhost("2026-08-07", "hard", "LiveRacer"); // still browsable
saveSelectedLeaderboardGhost("2026-06-01", "hard", "OldRacer"); // aged out
saveRacePbGhostPref(false); // global key must be left alone

pruneLeaderboardGhosts(new Set(["2026-08-07", "2026-08-06"]));

check("prune keeps a live map's selection", loadSelectedLeaderboardGhost("2026-08-07", "hard"), "LiveRacer");
check("prune drops an aged-out map's selection", loadSelectedLeaderboardGhost("2026-06-01", "hard"), null);
check("prune leaves the global pb-ghost pref untouched", loadRacePbGhostPref(), false);

// --- Per-difficulty personal bests -----------------------------------------

const seed = "2026-08-10";
check("no personal best on either difficulty yet", loadPersonalBest(seed, "hard"), null);
check("no personal best on easy yet either", loadPersonalBest(seed, "easy"), null);

const hardRun = { seed, time: 40, stability: 90, inputLog: [1, 2] };
savePersonalBestIfBetter(hardRun, "hard");
check("hard personal best is saved", loadPersonalBest(seed, "hard")?.time, 40);
check("saving a hard best doesn't touch easy", loadPersonalBest(seed, "easy"), null);

const easyRun = { seed, time: 55, stability: 95, inputLog: [3, 4] };
savePersonalBestIfBetter(easyRun, "easy");
check("easy personal best is saved independently", loadPersonalBest(seed, "easy")?.time, 55);
check("saving an easy best doesn't touch hard", loadPersonalBest(seed, "hard")?.time, 40);

// A slower time on either difficulty doesn't overwrite the existing best.
const slowerHard = { seed, time: 45, stability: 80, inputLog: [] };
check("a slower hard run isn't saved", savePersonalBestIfBetter(slowerHard, "hard"), false);
check("the faster hard best survives", loadPersonalBest(seed, "hard")?.time, 40);

// A Hard best saved under the pre-difficulty key format (no "hard:" segment)
// is still read back as a Hard personal best - old saves must survive the
// upgrade to per-difficulty storage.
const legacySeed = "2026-08-11";
localStorage.setItem(
  `unstable-truck:pb:${legacySeed}`,
  JSON.stringify({ seed: legacySeed, time: 30, stability: 100, inputLog: [], version: 2, savedAt: Date.now() }),
);
check("a legacy (pre-difficulty) save reads back as hard", loadPersonalBest(legacySeed, "hard")?.time, 30);
check("a legacy save is never read as easy", loadPersonalBest(legacySeed, "easy"), null);

// --- Difficulty preference --------------------------------------------------

check("no difficulty preference stored by default", loadDifficultyPref(), null);
saveDifficultyPref("easy");
check("difficulty preference remembers easy", loadDifficultyPref(), "easy");
saveDifficultyPref("hard");
check("difficulty preference remembers hard", loadDifficultyPref(), "hard");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall storage checks passed");

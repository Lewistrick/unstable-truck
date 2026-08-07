// Framework-free checks for the session-scoped ghost-race preferences, run the
// same way as scripts/collision-check.mjs (against the compiled dist/ output):
//   npm run build:client && node scripts/storage-check.mjs
//
// Guards the fix for the bug where the "race my own ghost" toggle wasn't
// remembered across levels, plus the per-seed leaderboard-ghost memory and the
// pruning of selections for maps that have aged out of the browse window.
// sessionStorage doesn't exist in Node, so we install a minimal in-memory mock
// before importing the module (which only touches storage when its functions
// are called, never at import time).

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

// --- Per-seed leaderboard opponent ----------------------------------------

check("no leaderboard ghost remembered by default", loadSelectedLeaderboardGhost("2026-08-07"), null);

saveSelectedLeaderboardGhost("2026-08-07", "Racer42");
check("leaderboard ghost round-trips per seed", loadSelectedLeaderboardGhost("2026-08-07"), "Racer42");

// Selections are independent per seed.
check("a different seed has no selection", loadSelectedLeaderboardGhost("2026-08-06"), null);

// Passing null clears it (deselecting the opponent).
saveSelectedLeaderboardGhost("2026-08-07", null);
check("leaderboard ghost can be cleared", loadSelectedLeaderboardGhost("2026-08-07"), null);

// --- Pruning old maps ------------------------------------------------------

saveSelectedLeaderboardGhost("2026-08-07", "LiveRacer"); // still browsable
saveSelectedLeaderboardGhost("2026-06-01", "OldRacer"); // aged out
saveRacePbGhostPref(false); // global key must be left alone

pruneLeaderboardGhosts(new Set(["2026-08-07", "2026-08-06"]));

check("prune keeps a live map's selection", loadSelectedLeaderboardGhost("2026-08-07"), "LiveRacer");
check("prune drops an aged-out map's selection", loadSelectedLeaderboardGhost("2026-06-01"), null);
check("prune leaves the global pb-ghost pref untouched", loadRacePbGhostPref(), false);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall storage checks passed");

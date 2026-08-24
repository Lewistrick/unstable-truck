// Keeping the account's copy of a player's progress and this device's copy in
// step.
//
// The model is local-first: localStorage stays the working copy that makes the
// game playable with no network at all, and the account is the durable one that
// survives a cleared browser or a new device. Nothing here is on the hot path -
// a failed sync is a no-op, never an error the player sees.
import { fetchAccountBests, pushAccountState, type AccountState } from "./api.js";
import { isLoggedIn } from "./auth.js";
import {
  loadAcquisitionSource,
  loadCompletedDays,
  loadDifficultyPref,
  loadPlayTime,
  loadPlayedDays,
  loadTruckAppearance,
  recordAcquisitionSource,
  recordCompletion,
  recordPlayed,
  saveDifficultyPref,
  savePersonalBestIfBetter,
  saveTruckAppearance,
  setPlayTime,
} from "./storage.js";

/** This device's state, in the shape the account stores. */
export function localAccountState(): AccountState {
  return {
    completed: [...loadCompletedDays()],
    played: [...loadPlayedDays()],
    difficulty: loadDifficultyPref(),
    playTimeSeconds: loadPlayTime(),
    source: loadAcquisitionSource(),
    truck: loadTruckAppearance(),
  };
}

/** Writes a merged state back to this device.
 *
 * Every write here is additive by design, matching the server's merge rules:
 * days are recorded, never removed, and play time only moves forward. The
 * difficulty preference is persisted but the live setting is left alone -
 * switching a player from Hard to Easy underneath them because another device
 * once preferred it would be worse than the inconsistency. */
export function applyAccountState(state: AccountState): void {
  for (const seed of state.completed) recordCompletion(seed);
  for (const seed of state.played) recordPlayed(seed);
  if (state.difficulty) saveDifficultyPref(state.difficulty);
  setPlayTime(state.playTimeSeconds);
  if (state.source) recordAcquisitionSource(state.source);
  if (state.truck) saveTruckAppearance(state.truck);
}

/** Pushes local state and applies whatever comes back. One round trip: the
 * server returns the merged result, so this is a pull as well.
 *
 * Returns whether anything was applied, so the caller knows whether the UI
 * needs repainting. */
export async function syncAccountState(): Promise<boolean> {
  if (!isLoggedIn()) return false;
  const merged = await pushAccountState(localAccountState());
  if (!merged) return false;
  applyAccountState(merged);
  return true;
}

/** Rebuilds this device's personal bests from the account's stored recordings.
 *
 * Only ever saves one that beats what is here already, so a device that is
 * ahead of the server keeps its own. Returns how many were actually taken,
 * which is zero on the common path where nothing has changed. */
export async function pullAccountBests(): Promise<number> {
  if (!isLoggedIn()) return 0;
  let taken = 0;
  for (const best of await fetchAccountBests()) {
    const recording = { seed: best.seed, time: best.time, stability: best.stability, inputLog: best.inputLog };
    if (savePersonalBestIfBetter(recording, best.difficulty)) taken++;
  }
  return taken;
}

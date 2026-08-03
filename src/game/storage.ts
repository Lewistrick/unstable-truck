import type { GhostRecording } from "./ghost.js";

const STORAGE_PREFIX = "unstable-truck:pb:";

/** Loads the stored personal-best recording for a given day's seed, if any. */
export function loadPersonalBest(seed: string): GhostRecording | null {
  const raw = localStorage.getItem(STORAGE_PREFIX + seed);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GhostRecording;
    if (typeof parsed.time !== "number" || !Array.isArray(parsed.inputLog)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Saves the recording as the new personal best if it's faster than any
 * existing one for that seed. Returns true if it was saved. */
export function savePersonalBestIfBetter(recording: GhostRecording): boolean {
  const existing = loadPersonalBest(recording.seed);
  if (existing && existing.time <= recording.time) return false;
  localStorage.setItem(STORAGE_PREFIX + recording.seed, JSON.stringify(recording));
  return true;
}

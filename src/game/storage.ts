import type { GhostRecording } from "./ghost.js";

const STORAGE_PREFIX = "unstable-truck:pb:";
// Bumped when the stored shape changes incompatibly (e.g. inputLog switching
// from float seconds to integer ticks) so old, unreadable entries get
// discarded instead of misinterpreted.
const STORAGE_VERSION = 2;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredPersonalBest extends GhostRecording {
  version: number;
  /** Date.now() at save time, used to prune entries older than a week. */
  savedAt: number;
}

function isFresh(savedAt: unknown): boolean {
  return typeof savedAt === "number" && Date.now() - savedAt <= MAX_AGE_MS;
}

function isValid(parsed: Partial<StoredPersonalBest>): parsed is StoredPersonalBest {
  return parsed.version === STORAGE_VERSION && typeof parsed.time === "number" && Array.isArray(parsed.inputLog);
}

/** Loads the stored personal-best recording for a given day's seed, if any.
 * Discards (and removes) entries that are stale (older than a week) or in
 * an outdated, incompatible format. */
export function loadPersonalBest(seed: string): GhostRecording | null {
  const key = STORAGE_PREFIX + seed;
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  let parsed: Partial<StoredPersonalBest>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(key);
    return null;
  }

  if (!isValid(parsed) || !isFresh(parsed.savedAt)) {
    localStorage.removeItem(key);
    return null;
  }
  return parsed;
}

/** Saves the recording as the new personal best if it's faster than any
 * existing one for that seed. Returns true if it was saved. */
export function savePersonalBestIfBetter(recording: GhostRecording): boolean {
  const existing = loadPersonalBest(recording.seed);
  if (existing && existing.time <= recording.time) return false;
  const stored: StoredPersonalBest = { ...recording, version: STORAGE_VERSION, savedAt: Date.now() };
  localStorage.setItem(STORAGE_PREFIX + recording.seed, JSON.stringify(stored));
  return true;
}

/** Removes every stored personal best older than a week, across all seeds -
 * not just whichever ones happen to be loaded via loadPersonalBest() (the
 * home screen only ever loads the last 3 days, so anything older would
 * otherwise sit in localStorage forever). Also clears out anything saved in
 * an older, incompatible format. Call once at startup. */
export function pruneOldPersonalBests(): void {
  const staleKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;

    const raw = localStorage.getItem(key);
    let parsed: Partial<StoredPersonalBest> | null = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!parsed || !isValid(parsed) || !isFresh(parsed.savedAt)) {
      staleKeys.push(key);
    }
  }
  for (const key of staleKeys) localStorage.removeItem(key);
}

const NICKNAME_KEY = "unstable-truck:nickname";
const MAX_NICKNAME_LENGTH = 24;

/** Returns the stored nickname, generating and persisting a friendly default
 * on first visit so score submission works without forcing input up front. */
export function getOrCreateNickname(): string {
  const stored = localStorage.getItem(NICKNAME_KEY);
  if (stored) return stored;
  const generated = `Racer${Math.floor(1000 + Math.random() * 9000)}`;
  localStorage.setItem(NICKNAME_KEY, generated);
  return generated;
}

/** Saves a (trimmed, length-capped) nickname; ignores blank input. */
export function setNickname(name: string): void {
  const trimmed = name.trim().slice(0, MAX_NICKNAME_LENGTH);
  if (trimmed) localStorage.setItem(NICKNAME_KEY, trimmed);
}

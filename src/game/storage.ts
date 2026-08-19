import type { Difficulty } from "./api.js";
import type { GhostRecording } from "./ghost.js";

const STORAGE_PREFIX = "unstable-truck:pb:";
// Bumped when the stored shape changes incompatibly (e.g. inputLog switching
// from float seconds to integer ticks) so old, unreadable entries get
// discarded instead of misinterpreted.
const STORAGE_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
// Daily bests match the 30-day browse window; weekly bests are kept about a
// year so a personal-best ghost is still available for any browsable past week.
const DAILY_MAX_AGE_MS = 30 * DAY_MS;
const WEEKLY_MAX_AGE_MS = 53 * 7 * DAY_MS;

/** Weekly seeds look like "2026-W31"; daily seeds like "2026-08-03". */
function maxAgeForSeed(seed: string): number {
  return seed.includes("-W") ? WEEKLY_MAX_AGE_MS : DAILY_MAX_AGE_MS;
}

interface StoredPersonalBest extends GhostRecording {
  version: number;
  /** Date.now() at save time, used to prune entries past their retention age. */
  savedAt: number;
}

function isFresh(savedAt: unknown, maxAgeMs: number): boolean {
  return typeof savedAt === "number" && Date.now() - savedAt <= maxAgeMs;
}

function isValid(parsed: Partial<StoredPersonalBest>): parsed is StoredPersonalBest {
  return parsed.version === STORAGE_VERSION && typeof parsed.time === "number" && Array.isArray(parsed.inputLog);
}

/** Per-difficulty key, e.g. "unstable-truck:pb:easy:2026-08-03". Easy and Hard
 * keep entirely separate personal bests, since they're different physics and
 * different leaderboards. */
function pbKey(seed: string, difficulty: Difficulty): string {
  return `${STORAGE_PREFIX}${difficulty}:${seed}`;
}

/** The pre-difficulty key format ("unstable-truck:pb:2026-08-03"), read once as
 * a fallback for a Hard personal best saved before this feature existed - every
 * run before Easy/Hard was, by definition, a Hard run. */
function legacyHardKey(seed: string): string {
  return STORAGE_PREFIX + seed;
}

function readPb(key: string, seed: string): GhostRecording | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  let parsed: Partial<StoredPersonalBest>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(key);
    return null;
  }

  if (!isValid(parsed) || !isFresh(parsed.savedAt, maxAgeForSeed(seed))) {
    localStorage.removeItem(key);
    return null;
  }
  return parsed;
}

/** Loads the stored personal-best recording for a given day's seed and
 * difficulty, if any. Discards (and removes) entries that are stale (older
 * than 30 days for daily seeds) or in an outdated, incompatible format. A Hard
 * lookup that finds nothing at the per-difficulty key falls back once to the
 * pre-difficulty legacy key, migrating it forward (and removing the legacy
 * entry) so old personal bests survive the upgrade. */
export function loadPersonalBest(seed: string, difficulty: Difficulty): GhostRecording | null {
  const found = readPb(pbKey(seed, difficulty), seed);
  if (found) return found;
  if (difficulty !== "hard") return null;

  const legacy = readPb(legacyHardKey(seed), seed);
  if (!legacy) return null;
  localStorage.setItem(pbKey(seed, "hard"), JSON.stringify({ ...legacy, version: STORAGE_VERSION, savedAt: Date.now() }));
  localStorage.removeItem(legacyHardKey(seed));
  return legacy;
}

/** Saves the recording as the new personal best for (seed, difficulty) if it's
 * faster than any existing one there. Returns true if it was saved. */
export function savePersonalBestIfBetter(recording: GhostRecording, difficulty: Difficulty): boolean {
  const existing = loadPersonalBest(recording.seed, difficulty);
  if (existing && existing.time <= recording.time) return false;
  const stored: StoredPersonalBest = { ...recording, version: STORAGE_VERSION, savedAt: Date.now() };
  localStorage.setItem(pbKey(recording.seed, difficulty), JSON.stringify(stored));
  return true;
}

/** Removes every stored personal best past its retention age (30 days for daily
 * seeds, about a year for weekly ones), across all seeds and both difficulties
 * - not just whichever ones happen to be loaded via loadPersonalBest(), so old
 * entries can't sit in localStorage forever. Also clears out anything saved in
 * an older, incompatible format, including any not-yet-migrated legacy
 * (pre-difficulty) entry. Call once at startup. */
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

    // Strip the prefix, then peel off a leading "easy:"/"hard:" difficulty
    // segment if present; what's left is the seed either way.
    const rest = key.slice(STORAGE_PREFIX.length);
    const seed = rest.startsWith("easy:") ? rest.slice(5) : rest.startsWith("hard:") ? rest.slice(5) : rest;
    if (!parsed || !isValid(parsed) || !isFresh(parsed.savedAt, maxAgeForSeed(seed))) {
      staleKeys.push(key);
    }
  }
  for (const key of staleKeys) localStorage.removeItem(key);
}

const COMPLETED_KEY = "unstable-truck:completed";
// Completion history feeds the streak counter, which can legitimately outlive
// the 30-day personal-best window (play every day and the streak keeps
// growing), so it's kept far longer - just bounded so it can't grow forever.
const COMPLETED_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

function parseCompleted(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function isRecentSeed(seed: string): boolean {
  const [y, m, d] = seed.split("-").map(Number);
  if (!y || !m || !d) return false;
  return Date.now() - new Date(y, m - 1, d).getTime() <= COMPLETED_MAX_AGE_MS;
}

/** Records a day's seed as completed (a successful delivery). Idempotent -
 * completing the same day twice doesn't duplicate it - and prunes entries
 * older than the retention window on write so the set stays bounded. */
export function recordCompletion(seed: string): void {
  const set = new Set(parseCompleted(localStorage.getItem(COMPLETED_KEY)));
  set.add(seed);
  const kept = [...set].filter(isRecentSeed).sort();
  localStorage.setItem(COMPLETED_KEY, JSON.stringify(kept));
}

/** The set of day seeds (YYYY-MM-DD) the player has ever completed, within the
 * retention window. */
export function loadCompletedDays(): Set<string> {
  return new Set(parseCompleted(localStorage.getItem(COMPLETED_KEY)));
}

const TUTORIAL_SEEN_KEY = "unstable-truck:tutorial-seen";

/** Whether this browser has already been through (or dismissed) the new-player
 * tutorial. Absent on a genuine first visit, which is what auto-opens it. */
export function hasSeenTutorial(): boolean {
  return localStorage.getItem(TUTORIAL_SEEN_KEY) === "1";
}

/** Marks the tutorial as seen so it won't auto-open again (it stays reachable
 * from the Tutorial button). Set once the player completes or skips it. */
export function markTutorialSeen(): void {
  localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
}

const NICKNAME_KEY = "unstable-truck:nickname";
const MAX_NICKNAME_LENGTH = 16;

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

// --- Difficulty preference ---------------------------------------------------
// Persisted (not session-scoped) so it survives across visits and every map,
// matching the requested "sticks even across maps" behaviour. Only meaningful
// for daily play - weekly is Hard-only - but the preference itself is kept
// independent of the daily/weekly mode so switching back to daily restores it.

const DIFFICULTY_KEY = "unstable-truck:difficulty";

/** The player's stored Easy/Hard preference, or null if they've never set one
 * (a brand-new browser, or one that predates this feature). The caller decides
 * the default for that case. */
export function loadDifficultyPref(): Difficulty | null {
  const stored = localStorage.getItem(DIFFICULTY_KEY);
  return stored === "easy" || stored === "hard" ? stored : null;
}

/** Persists the Easy/Hard preference across visits and maps. */
export function saveDifficultyPref(difficulty: Difficulty): void {
  localStorage.setItem(DIFFICULTY_KEY, difficulty);
}

// --- Sync token ------------------------------------------------------------

const SYNC_TOKEN_KEY = "unstable-truck:sync-token";

export function loadSyncToken(): string | null {
  return localStorage.getItem(SYNC_TOKEN_KEY);
}

export function saveSyncToken(token: string): void {
  localStorage.setItem(SYNC_TOKEN_KEY, token);
}

export function clearSyncToken(): void {
  localStorage.removeItem(SYNC_TOKEN_KEY);
}

// --- Ghost-race preferences (session-scoped) ------------------------------
// These live in sessionStorage so a choice sticks while browsing between levels
// in the same session, then resets on a fresh visit. The "race my own ghost"
// toggle is one global preference (it follows you across every level and both
// daily/weekly modes); the selected leaderboard opponent is remembered per
// seed, since another player's ghost only makes sense on the level it was set.

const RACE_PB_GHOST_KEY = "unstable-truck:race-pb-ghost";
const LEADERBOARD_GHOST_PREFIX = "unstable-truck:lb-ghost:";

/** Whether to race your own personal-best ghost. Global (not per level), and
 * defaults to on so a first-time PB still shows its ghost. */
export function loadRacePbGhostPref(): boolean {
  return sessionStorage.getItem(RACE_PB_GHOST_KEY) !== "0";
}

/** Persists the global "race my own ghost" toggle for the rest of the session. */
export function saveRacePbGhostPref(on: boolean): void {
  sessionStorage.setItem(RACE_PB_GHOST_KEY, on ? "1" : "0");
}

/** The leaderboard opponent's nickname selected for a given (seed, difficulty),
 * if any. Easy and Hard keep separate selections - they're different boards,
 * and a ghost recorded on one can't race on the other. */
export function loadSelectedLeaderboardGhost(seed: string, difficulty: Difficulty): string | null {
  return sessionStorage.getItem(LEADERBOARD_GHOST_PREFIX + difficulty + ":" + seed);
}

/** Remembers (or, with null, clears) the selected leaderboard opponent for a
 * (seed, difficulty) for the rest of the session. */
export function saveSelectedLeaderboardGhost(seed: string, difficulty: Difficulty, nickname: string | null): void {
  const key = LEADERBOARD_GHOST_PREFIX + difficulty + ":" + seed;
  if (nickname) sessionStorage.setItem(key, nickname);
  else sessionStorage.removeItem(key);
}

/** Drops remembered leaderboard-ghost selections for maps that are no longer
 * browsable (their seed isn't in `liveSeeds`), so session storage can't pile up
 * old maps over a long-lived session. The global PB toggle is a single key, so
 * it needs no such pruning. */
export function pruneLeaderboardGhosts(liveSeeds: Set<string>): void {
  const staleKeys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key || !key.startsWith(LEADERBOARD_GHOST_PREFIX)) continue;
    // Strip the "easy:"/"hard:" difficulty segment to recover the bare seed.
    const rest = key.slice(LEADERBOARD_GHOST_PREFIX.length);
    const seed = rest.startsWith("easy:") ? rest.slice(5) : rest.startsWith("hard:") ? rest.slice(5) : rest;
    if (!liveSeeds.has(seed)) staleKeys.push(key);
  }
  for (const key of staleKeys) sessionStorage.removeItem(key);
}

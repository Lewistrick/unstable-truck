// The per-player state an account carries: everything that used to live only
// in the browser's localStorage, plus the truck's appearance.
//
// Stored whole, as one JSONB column on users. It is read and written as a unit
// and never queried by field, so a column beats a table per concept.
//
// Like password.ts and rate-limit.ts this imports nothing at all, which is what
// lets scripts/account-state-check.mjs exercise the merge rules directly - and
// the merge rules are exactly the part worth testing, since getting them wrong
// silently loses a player's streak.

export type TruckPattern = "horizontal" | "vertical" | "diagonal" | "striped" | "checkered";

const TRUCK_PATTERNS = new Set<string>(["horizontal", "vertical", "diagonal", "striped", "checkered"]);

/** How a player's truck looks. Stored and merged, but nothing reads it yet -
 * the renderer still draws the one fixed truck. */
export interface TruckAppearance {
  /** Body colour as "#rrggbb". */
  primary: string;
  /** Second colour, used by whichever pattern is chosen. */
  secondary: string;
  pattern: TruckPattern;
}

export interface AccountState {
  /** Seeds delivered successfully. Drives the streak. */
  completed: string[];
  /** Seeds a run was started on, whether or not it was finished. */
  played: string[];
  difficulty: "easy" | "hard" | null;
  playTimeSeconds: number;
  /** First-touch acquisition channel, never overwritten once set. */
  source: string | null;
  truck: TruckAppearance | null;
}

export const EMPTY_STATE: AccountState = {
  completed: [],
  played: [],
  difficulty: null,
  playTimeSeconds: 0,
  source: null,
  truck: null,
};

// Daily seeds are dates, weekly seeds ISO year+week. Anything else is junk and
// is dropped rather than stored - this column is client-supplied.
const SEED_PATTERN = /^\d{4}-\d{2}-\d{2}$|^\d{4}-W\d{2}$/;
const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;
// A daily game played every day for four years still fits well inside this.
// The cap exists so a hostile client can't grow one row without bound.
const MAX_SEEDS = 2000;
const MAX_SOURCE_LENGTH = 40;
// Ten years of continuous play, i.e. far past anything real.
const MAX_PLAY_TIME_SECONDS = 10 * 365 * 24 * 60 * 60;

function parseSeeds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && SEED_PATTERN.test(entry)) seen.add(entry);
    if (seen.size >= MAX_SEEDS) break;
  }
  return [...seen].sort();
}

function parseTruck(value: unknown): TruckAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.primary !== "string" || !HEX_COLOUR_PATTERN.test(t.primary)) return null;
  if (typeof t.secondary !== "string" || !HEX_COLOUR_PATTERN.test(t.secondary)) return null;
  if (typeof t.pattern !== "string" || !TRUCK_PATTERNS.has(t.pattern)) return null;
  return { primary: t.primary, secondary: t.secondary, pattern: t.pattern as TruckPattern };
}

/** Reads a state blob from whatever was stored or sent, keeping only what is
 * well-formed. Never throws: a corrupted row should cost a player their
 * preferences, not their ability to log in. */
export function parseState(raw: unknown): AccountState {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_STATE };
  const s = raw as Record<string, unknown>;
  const playTime =
    typeof s.playTimeSeconds === "number" && Number.isFinite(s.playTimeSeconds) && s.playTimeSeconds > 0
      ? Math.min(Math.floor(s.playTimeSeconds), MAX_PLAY_TIME_SECONDS)
      : 0;
  return {
    completed: parseSeeds(s.completed),
    played: parseSeeds(s.played),
    difficulty: s.difficulty === "easy" || s.difficulty === "hard" ? s.difficulty : null,
    playTimeSeconds: playTime,
    source: typeof s.source === "string" && s.source !== "" ? s.source.slice(0, MAX_SOURCE_LENGTH) : null,
    truck: parseTruck(s.truck),
  };
}

/** Folds a device's state into what the account already holds.
 *
 * The rules exist so that syncing can only ever add to what a player has:
 *
 * - completed and played are unioned. A day delivered on a phone and a day
 *   delivered on a laptop are both real, and no sync should be able to take one
 *   away.
 * - play time takes the larger. It is a running total, so the higher number is
 *   the one that has seen more of the player's history.
 * - the difficulty preference is the account's if it has one. A setting follows
 *   the person, so the account is the authority, not whichever device pushed
 *   last.
 * - the acquisition source is first-touch and never overwritten - the channel
 *   that originally won a player stays the answer, however they come back.
 * - the truck keeps whatever the account already has, for the same reason as
 *   difficulty. Nothing writes it yet.
 *
 * A read-modify-write race between two devices can drop one push, which the
 * next push re-merges: every rule here is idempotent and monotonic, so the
 * union heals itself rather than losing anything permanently. */
export function mergeState(stored: AccountState, incoming: AccountState): AccountState {
  return {
    completed: [...new Set([...stored.completed, ...incoming.completed])].sort().slice(0, MAX_SEEDS),
    played: [...new Set([...stored.played, ...incoming.played])].sort().slice(0, MAX_SEEDS),
    difficulty: stored.difficulty ?? incoming.difficulty,
    playTimeSeconds: Math.max(stored.playTimeSeconds, incoming.playTimeSeconds),
    source: stored.source ?? incoming.source,
    truck: stored.truck ?? incoming.truck,
  };
}

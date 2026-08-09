import { weekSeed } from "./generate.js";

// Where a `?s=<seed>` shared link should land. This is deliberately DOM-free and
// side-effect-free so it can be unit-tested directly (see
// scripts/seed-target-check.mjs); the DOM wiring lives in main.ts.

/** A live daily seed is a calendar date, YYYY-MM-DD. */
export const DAILY_SEED_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A live weekly seed is an ISO year+week, YYYY-Www (e.g. 2026-W31). */
export const WEEKLY_SEED_RE = /^\d{4}-W\d{2}$/;

type Mode = "daily" | "weekly";

/** How many days back a daily seed (YYYY-MM-DD) is from `today`: 0 today,
 * negative for the past, positive for the future. Null if it isn't a real
 * calendar date (bad format, or an impossible day like 2026-02-31). */
export function dailySeedDayOffset(seed: string, today: Date = new Date()): number | null {
  if (!DAILY_SEED_RE.test(seed)) return null;
  const [y, m, d] = seed.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  // Reject impossible dates: JS rolls 2026-02-31 over into March, which would
  // change the month/day back from what was parsed.
  if (date.getFullYear() !== y || date.getMonth() !== m! - 1 || date.getDate() !== d) return null;
  const midnight = new Date(today);
  midnight.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - midnight.getTime()) / 86_400_000);
}

/** The week offset (0 = this week, negative = past) for a weekly seed within the
 * browsable window `[0, -maxPastWeeks]`, or null if it's outside that window or
 * not a weekly seed. Matched by generation rather than parsed, so ISO
 * week-numbering edge cases stay consistent with weekSeed(). */
export function weeklySeedWeekOffset(seed: string, maxPastWeeks: number): number | null {
  if (!WEEKLY_SEED_RE.test(seed)) return null;
  for (let o = 0; o >= -maxPastWeeks; o--) if (weekSeed(o) === seed) return o;
  return null;
}

/** Where a shared-link seed should land: a live daily/weekly period we can
 * browse to (with a leaderboard), or an "orphan" - expired, future, or
 * non-standard - which is still generated and played but without a leaderboard.
 * An orphan keeps the weekly map for a weekly-shaped seed, else generates a
 * daily map. */
export type SeedTarget = { kind: "live"; mode: Mode; offset: number } | { kind: "orphan"; mode: Mode };

export function resolveSeedTarget(
  seed: string,
  maxPastDays: number,
  maxPastWeeks: number,
  today: Date = new Date(),
): SeedTarget {
  const dayOffset = dailySeedDayOffset(seed, today);
  if (dayOffset !== null && dayOffset <= 0 && dayOffset >= -maxPastDays) {
    return { kind: "live", mode: "daily", offset: dayOffset };
  }
  const weekOffset = weeklySeedWeekOffset(seed, maxPastWeeks);
  if (weekOffset !== null) return { kind: "live", mode: "weekly", offset: weekOffset };
  return { kind: "orphan", mode: WEEKLY_SEED_RE.test(seed) ? "weekly" : "daily" };
}

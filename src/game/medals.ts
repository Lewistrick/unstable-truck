import { distance } from "../util/vec2.js";
import type { Level, Warehouse } from "../level/types.js";

export type Medal = "gold" | "silver" | "bronze";

export interface MedalPars {
  /** Finish strictly under this time to earn the medal. */
  gold: number;
  silver: number;
  bronze: number;
}

export const MEDAL_ICON: Record<Medal, string> = {
  gold: "\u{1F947}", // 🥇
  silver: "\u{1F948}", // 🥈
  bronze: "\u{1F949}", // 🥉
};

export const MEDAL_LABEL: Record<Medal, string> = {
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
};

// Medal targets are derived purely from the level's geometry so they work
// fully offline, identically for every player, without needing any
// leaderboard data. They're a heuristic, not a measured par: the ideal route
// length (base -> nearest-unvisited pickup chain -> destination, straight
// line) is inflated by DETOUR_FACTOR to account for roads curving rather than
// running straight, then divided by an assumed "good driving" speed to get
// the gold time. Silver/bronze are progressively looser multiples of that.
// Tune these if medals feel too generous or too stingy across days.
const DETOUR_FACTOR = 1.35;
const GOLD_SPEED = 195; // px/s of effective forward progress for a strong run
const SILVER_MULTIPLIER = 1.3;
const BRONZE_MULTIPLIER = 1.7;

function findWarehouse(level: Level, kind: Warehouse["kind"]): Warehouse {
  const wh = level.warehouses.find((w) => w.kind === kind);
  if (!wh) throw new Error(`Level is missing a "${kind}" warehouse`);
  return wh;
}

/** Approximate ideal route length: start at the base, greedily hop to the
 * nearest not-yet-visited pickup each step, then finish at the destination.
 * Nearest-neighbour is a cheap stand-in for the true optimal tour, which is
 * plenty for setting a fair-ish medal target. */
function idealRouteLength(level: Level): number {
  const base = findWarehouse(level, "base");
  const destination = findWarehouse(level, "destination");
  const remaining = level.warehouses.filter((w) => w.kind === "pickup");

  let total = 0;
  let current = base.pos;
  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = distance(current, remaining[i]!.pos);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIndex = i;
      }
    }
    total += nearestDist;
    current = remaining[nearestIndex]!.pos;
    remaining.splice(nearestIndex, 1);
  }
  total += distance(current, destination.pos);
  return total;
}

/** Deterministic gold/silver/bronze target times for a level. */
export function computeMedalPars(level: Level): MedalPars {
  const gold = (idealRouteLength(level) * DETOUR_FACTOR) / GOLD_SPEED;
  return { gold, silver: gold * SILVER_MULTIPLIER, bronze: gold * BRONZE_MULTIPLIER };
}

/** Best medal earned for a finish time, or null if slower than bronze. */
export function medalFor(time: number, pars: MedalPars): Medal | null {
  if (time <= pars.gold) return "gold";
  if (time <= pars.silver) return "silver";
  if (time <= pars.bronze) return "bronze";
  return null;
}

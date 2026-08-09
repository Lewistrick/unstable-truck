import { distance, type Vec2 } from "../util/vec2.js";
import type { Level, Warehouse } from "../level/types.js";

// Ordered hardest to easiest. "champion" is a dynamic tier above gold, derived
// from the current #1 time rather than the level geometry.
export type Medal = "champion" | "gold" | "silver" | "bronze";

export interface MedalPars {
  /** Finish strictly under this time to earn the medal. */
  gold: number;
  silver: number;
  bronze: number;
}

export const MEDAL_ICON: Record<Medal, string> = {
  champion: "\u{1F3C6}", // 🏆
  gold: "\u{1F947}", // 🥇
  silver: "\u{1F948}", // 🥈
  bronze: "\u{1F949}", // 🥉
};

export const MEDAL_LABEL: Record<Medal, string> = {
  champion: "Champion",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
};

/** Champion threshold from the gold time `g` and the current top (#1) time
 * `t`: three quarters of the way from gold down to the record,
 * `g - 3*(g - t)/4` = `(g + 3*t)/4`. Returns null when there's no record
 * faster than gold (champion would just equal gold), so the tier is omitted. */
export function championTime(gold: number, topTime: number | null): number | null {
  if (topTime == null || topTime >= gold) return null;
  return (gold + 3 * topTime) / 4;
}

// Medal targets are derived purely from the level's geometry so they work
// fully offline, identically for every player, without needing any
// leaderboard data. They're a heuristic, not a measured par: the ideal route
// length (base -> optimized pickup tour -> destination, straight line) is
// inflated by DETOUR_FACTOR to account for roads curving rather than running
// straight, then divided by an assumed "good driving" speed to get the gold
// time. Silver/bronze are progressively looser multiples of that.
//
// The tour is 2-opt-optimized (not just nearest-neighbour), so `idealRouteLength`
// tracks the route a strong player actually drives rather than an inflated
// estimate - which is what previously made many-pickup maps (the weekly board
// especially) too easy. With these constants gold lands at 1.20/230 * len =
// ~1.36x the straight-line-at-top-speed floor (BASE_MAX_SPEED 260) on every map,
// so difficulty stays consistent regardless of pickup count. Tune DETOUR_FACTOR
// down / GOLD_SPEED up to make gold harder, and the reverse to soften it.
const DETOUR_FACTOR = 1.2;
const GOLD_SPEED = 230; // px/s of effective forward progress for a strong run
const SILVER_MULTIPLIER = 1.18;
const BRONZE_MULTIPLIER = 1.45;

function findWarehouse(level: Level, kind: Warehouse["kind"]): Warehouse {
  const wh = level.warehouses.find((w) => w.kind === kind);
  if (!wh) throw new Error(`Level is missing a "${kind}" warehouse`);
  return wh;
}

/** Length of the open path base -> (pickups in `order`) -> destination. */
function routeLength(base: Vec2, order: readonly Warehouse[], destination: Vec2): number {
  let total = 0;
  let current = base;
  for (const wh of order) {
    total += distance(current, wh.pos);
    current = wh.pos;
  }
  return total + distance(current, destination);
}

/** A greedy nearest-neighbour pickup ordering from the base - a decent starting
 * tour for the 2-opt refinement below. */
function nearestNeighbourOrder(base: Vec2, pickups: readonly Warehouse[]): Warehouse[] {
  const remaining = [...pickups];
  const order: Warehouse[] = [];
  let current = base;
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
    order.push(remaining[nearestIndex]!);
    current = remaining[nearestIndex]!.pos;
    remaining.splice(nearestIndex, 1);
  }
  return order;
}

/** Approximate ideal route length: start at the base, visit every pickup, end
 * at the destination, along the shortest tour we can cheaply find. A
 * nearest-neighbour tour is refined by 2-opt - repeatedly reversing any pickup
 * sub-sequence that shortens the whole path (the base/destination endpoints stay
 * fixed) - which lands close to the true optimal tour. That matters because
 * nearest-neighbour alone overestimates by ~20% on the many-pickup weekly map,
 * and a too-long "ideal" route is exactly what made its medals too soft. */
function idealRouteLength(level: Level): number {
  const base = findWarehouse(level, "base").pos;
  const destination = findWarehouse(level, "destination").pos;
  const order = nearestNeighbourOrder(
    base,
    level.warehouses.filter((w) => w.kind === "pickup"),
  );

  // 2-opt: for each pickup sub-sequence [i..k], reversing it only changes the
  // two edges at its ends, so the gain is a cheap O(1) check. Keep sweeping
  // until a full pass finds no improvement. Pickup counts are small (a handful
  // daily, up to ~25 weekly), so this converges in a few passes.
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      const prev = i === 0 ? base : order[i - 1]!.pos;
      for (let k = i + 1; k < order.length; k++) {
        const next = k === order.length - 1 ? destination : order[k + 1]!.pos;
        const a = order[i]!.pos;
        const b = order[k]!.pos;
        const gain = distance(prev, a) + distance(b, next) - distance(prev, b) - distance(a, next);
        if (gain > 1e-9) {
          // Reverse the sub-sequence in place.
          for (let lo = i, hi = k; lo < hi; lo++, hi--) {
            const tmp = order[lo]!;
            order[lo] = order[hi]!;
            order[hi] = tmp;
          }
          improved = true;
        }
      }
    }
  }
  return routeLength(base, order, destination);
}

/** Deterministic gold/silver/bronze target times for a level. */
export function computeMedalPars(level: Level): MedalPars {
  const gold = (idealRouteLength(level) * DETOUR_FACTOR) / GOLD_SPEED;
  return { gold, silver: gold * SILVER_MULTIPLIER, bronze: gold * BRONZE_MULTIPLIER };
}

/** Best medal earned for a finish time, or null if slower than bronze. Pass a
 * champion threshold (from championTime()) to enable the champion tier; it's
 * always faster than gold, so it's checked first. */
export function medalFor(time: number, pars: MedalPars, champion: number | null = null): Medal | null {
  if (champion != null && time <= champion) return "champion";
  if (time <= pars.gold) return "gold";
  if (time <= pars.silver) return "silver";
  if (time <= pars.bronze) return "bronze";
  return null;
}

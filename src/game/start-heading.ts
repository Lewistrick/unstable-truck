// Which way the truck faces at the start of a run.
//
// Lives in its own module because two places need the identical answer and used
// to compute it separately: GameSession (what the player and every ghost drive)
// and createSimState in sim.ts (what the solver searches). They drifted the
// moment one changed, and a solver route computed from a different start angle
// is not merely suboptimal - it doesn't complete the map at all.
import type { Level, Warehouse } from "../level/types.js";
import { distance, sub } from "../util/vec2.js";
import { mulberry32, randRange, seedFromString } from "../util/rng.js";

/** How far the start heading may be rocked off the road, either way. Enough to
 * stop every map opening with the same dead-straight launch, not enough to cost
 * the player a correction before they've begun. */
const MAX_HEADING_JITTER = (20 * Math.PI) / 180;

/** Physics revisions are keyed to the map's own date, never to today's.
 *
 * A stored replay re-simulates from its input log (see GhostPlayer), so a run
 * has to keep re-simulating under the rules it was driven under or every ghost
 * and precomputed route on that map silently goes off its recorded line. Dating
 * the rule instead of the clock means old maps keep old physics forever and
 * only maps from the cutoff on get the change. */
const ROAD_HEADING_FROM_DATE = "2026-08-28";

/** How close two road endpoints must be to count as the same junction. */
const JUNCTION_TOLERANCE = 40;

function mondayOfIsoWeek(year: number, week: number): Date {
  const DAY = 86_400_000;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return new Date(jan4.getTime() - jan4Dow * DAY + (week - 1) * 7 * DAY);
}

/** The calendar date a seed's map belongs to (YYYY-MM-DD), or null when the
 * seed carries no date at all - a shared one-off, say.
 *
 * A weekly seed resolves to the Monday its week starts on, so a week already
 * underway when a cutoff lands keeps the physics its existing scores were set
 * under; the change takes effect from the first week that starts after it. */
function seedDate(seed: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(seed)) return seed;
  const week = /^(\d{4})-W(\d{2})$/.exec(seed);
  if (week) return mondayOfIsoWeek(Number(week[1]), Number(week[2])).toISOString().slice(0, 10);
  return null;
}

/** Whether this map starts the truck along the road or with the original
 * aim-at-the-nearest-pickup rule. Campaign maps have always used the road
 * heading - the campaign postdates the change. */
function usesRoadHeading(level: Level): boolean {
  if (level.kind === "campaign") return true;
  const date = seedDate(level.seed);
  return date !== null && date >= ROAD_HEADING_FROM_DATE;
}

/** The direction the road leaves `pos`, or null on a level with no roads.
 *
 * Each segment contributes the endpoint nearer `pos` and the Bezier tangent
 * there, which points along the segment and so away from `pos`. Where several
 * roads meet - a daily map's base can sit on a hub - `towards` picks the exit
 * heading most nearly at the objectives.
 *
 * It chooses BETWEEN exits and never reverses one. An earlier version flipped a
 * single exit when it pointed away from the targets, which read as reasonable
 * and was badly wrong: these tangents run along real road, and the opposite of
 * a road that ends at your feet is not a road at all. */
function roadHeadingFrom(
  level: Level,
  pos: { x: number; y: number },
  towards: { x: number; y: number },
): number | null {
  const exits: { dir: { x: number; y: number }; d: number }[] = [];
  for (const seg of level.roads) {
    const atStart = distance(seg.p0, pos);
    const atEnd = distance(seg.p3, pos);
    exits.push(
      atStart <= atEnd
        ? { dir: sub(seg.p1, seg.p0), d: atStart }
        : { dir: sub(seg.p2, seg.p3), d: atEnd },
    );
  }
  let nearest = Infinity;
  for (const exit of exits) nearest = Math.min(nearest, exit.d);
  if (!Number.isFinite(nearest)) return null;

  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (const exit of exits) {
    if (exit.d > nearest + JUNCTION_TOLERANCE) continue;
    const len = Math.hypot(exit.dir.x, exit.dir.y);
    if (len === 0) continue;
    // Cosine against the objectives, so a longer segment doesn't outvote a
    // better-aimed short one.
    const score = (exit.dir.x * towards.x + exit.dir.y * towards.y) / len;
    if (score > bestScore) {
      bestScore = score;
      best = exit.dir;
    }
  }
  return best ? Math.atan2(best.y, best.x) : null;
}

/**
 * The truck's heading at tick 0.
 *
 * On a map past its cutoff, along the road leaving the base, nudged by a
 * per-seed offset of at most MAX_HEADING_JITTER. Otherwise the original rule:
 * straight at the nearest pickup, or the destination when there are none.
 */
export function startHeading(
  level: Level,
  base: Warehouse,
  pickups: readonly Warehouse[],
  destination: Warehouse,
): number {
  const targets = [...pickups, destination];
  const centroid = targets.reduce(
    (acc, w) => ({ x: acc.x + w.pos.x / targets.length, y: acc.y + w.pos.y / targets.length }),
    { x: 0, y: 0 },
  );
  const road = usesRoadHeading(level)
    ? roadHeadingFrom(level, base.pos, sub(centroid, base.pos))
    : null;
  if (road != null) {
    // Seeded off the level, so the offset is fixed per map: a replay must
    // re-simulate to the same run on both client and server.
    const jitter = mulberry32(seedFromString(`${level.seed}:heading`));
    return road + randRange(jitter, -MAX_HEADING_JITTER, MAX_HEADING_JITTER);
  }

  let firstTarget: Warehouse = destination;
  for (const wh of pickups) {
    if (firstTarget === destination || distance(base.pos, wh.pos) < distance(base.pos, firstTarget.pos)) {
      firstTarget = wh;
    }
  }
  return Math.atan2(firstTarget.pos.y - base.pos.y, firstTarget.pos.x - base.pos.x);
}

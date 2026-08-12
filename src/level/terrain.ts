import { distance, type Vec2 } from "../util/vec2.js";
import type { Level, MudObstacle } from "./types.js";

export interface TerrainSample {
  onRoad: boolean;
  inMud: boolean;
  mud: MudObstacle | null;
}

/** Just enough of the truck for terrain queries: its center and heading. */
export interface TruckPose {
  pos: Vec2;
  heading: number;
}

// Truck body half-extents, mirroring the drawn 32x22 body (and its rock
// collider in physics/truck.ts). Mud is tested against the whole body rather
// than just the center point, so the effect kicks in and lets go when the truck
// visibly enters and leaves the patch.
const TRUCK_HALF_LENGTH = 16;
const TRUCK_HALF_WIDTH = 11;
// Negative padding (mirroring the rock ROCK_FORGIVE and warehouse COLLECT_PAD):
// the probed body is a touch smaller than the drawn one, so mud registers only
// once the truck has visibly sunk into the patch - it looks like you almost
// drive through the edge rather than slowing the instant a corner grazes it.
const MUD_FORGIVE = 2;
const PROBE_HALF_LENGTH = TRUCK_HALF_LENGTH - MUD_FORGIVE;
const PROBE_HALF_WIDTH = TRUCK_HALF_WIDTH - MUD_FORGIVE;
const TRUCK_BODY_CORNERS: Array<[number, number]> = [
  [PROBE_HALF_LENGTH, PROBE_HALF_WIDTH],
  [PROBE_HALF_LENGTH, -PROBE_HALF_WIDTH],
  [-PROBE_HALF_LENGTH, PROBE_HALF_WIDTH],
  [-PROBE_HALF_LENGTH, -PROBE_HALF_WIDTH],
];

function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function isOnRoad(pos: Vec2, level: Level): boolean {
  for (const road of level.roads) {
    for (const sample of road.samples) {
      if (distance(pos, sample) <= road.width / 2) return true;
    }
  }
  return false;
}

export function sampleTerrain(truck: TruckPose, level: Level): TerrainSample {
  return sampleTerrainWith(truck, level, isOnRoad(truck.pos, level));
}

/** The body of {@link sampleTerrain} with the (potentially expensive) on-road
 * test lifted out, so a caller that already knows the answer - most importantly
 * the headless solver, which resolves on-road through a fast spatial index
 * (level/level-index.ts) - can supply it and still share this file's exact mud
 * probing rather than reimplementing it. */
export function sampleTerrainWith(truck: TruckPose, level: Level, onRoad: boolean): TerrainSample {
  // Probe the truck's center plus its four body corners; the truck counts as in
  // the mud if any of them fall inside a mud polygon. This makes an edge/wheel
  // over the mud register, matching the drawn patch instead of waiting for the
  // truck's center to cross in.
  const cos = Math.cos(truck.heading);
  const sin = Math.sin(truck.heading);
  const probes: Vec2[] = [truck.pos];
  for (const [ex, ey] of TRUCK_BODY_CORNERS) {
    probes.push({ x: truck.pos.x + ex * cos - ey * sin, y: truck.pos.y + ex * sin + ey * cos });
  }
  // Broad-phase reach from the truck center out to its farthest corner.
  const reach = Math.hypot(TRUCK_HALF_LENGTH, TRUCK_HALF_WIDTH);

  let inMud = false;
  let mud: MudObstacle | null = null;
  for (const m of level.muds) {
    if (distance(truck.pos, m.pos) > m.radius * 1.3 + reach) continue;
    if (probes.some((p) => pointInPolygon(p, m.points))) {
      inMud = true;
      mud = m;
      break;
    }
  }

  return { onRoad, inMud, mud };
}

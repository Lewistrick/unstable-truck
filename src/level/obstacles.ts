import { type Rng, randInt, randRange } from "../util/rng.js";
import { distance, v, type Vec2 } from "../util/vec2.js";
import type { MudObstacle, RockObstacle, Warehouse } from "./types.js";

const MIN_CLEARANCE_FROM_WAREHOUSE = 90;

/** Deliberate placement of obstacles along the racing line.
 *
 * The default scatter is terrain-driven and road-blind, which on a large map
 * means most obstacles land somewhere the player never drives. This biases a
 * share of them onto the road corridor instead, so they actually shape the
 * route: rocks offset far enough to pinch a lane rather than wall it off, mud
 * allowed to straddle the centreline (it's passable, just punishing). */
export interface RoadsideBias {
  /** Points along the road centreline to cluster around. */
  points: Vec2[];
  /** Share of each obstacle type placed this way rather than scattered. */
  fraction: number;
  rockOffset: { min: number; max: number };
  mudOffset: { min: number; max: number };
}

function findRoadsideSpot(
  rng: Rng,
  bias: RoadsideBias,
  offset: { min: number; max: number },
  width: number,
  height: number,
  taken: Vec2[],
  minSpacing: number,
): Vec2 | null {
  if (bias.points.length === 0) return null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const anchor = bias.points[Math.floor(rng() * bias.points.length)]!;
    const angle = rng() * Math.PI * 2;
    const dist = randRange(rng, offset.min, offset.max);
    const x = anchor.x + Math.cos(angle) * dist;
    const y = anchor.y + Math.sin(angle) * dist;
    if (x < 40 || x > width - 40 || y < 40 || y > height - 40) continue;
    const pos = v(x, y);
    if (taken.some((p) => distance(p, pos) < minSpacing)) continue;
    return pos;
  }
  return null;
}

function findSpot(
  rng: Rng,
  noise: (x: number, y: number) => number,
  width: number,
  height: number,
  noiseScale: number,
  threshold: number,
  taken: Vec2[],
  minSpacing: number,
): Vec2 | null {
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = randRange(rng, 40, width - 40);
    const y = randRange(rng, 40, height - 40);
    if (noise(x * noiseScale, y * noiseScale) < threshold) continue;
    if (taken.some((p) => distance(p, v(x, y)) < minSpacing)) continue;
    return v(x, y);
  }
  return null;
}

export function generateObstacles(
  rng: Rng,
  noise: (x: number, y: number) => number,
  width: number,
  height: number,
  warehouses: Warehouse[],
  counts?: { rocks: number; muds: number },
  extraOccupied: Vec2[] = [],
  roadside?: RoadsideBias,
): { rocks: RockObstacle[]; muds: MudObstacle[] } {
  const occupied: Vec2[] = [...warehouses.map((w) => w.pos), ...extraOccupied];
  const spacingFor = (r: number) => Math.max(MIN_CLEARANCE_FROM_WAREHOUSE, r + 50);
  // A roadside attempt that finds nowhere legal falls back to the scatter, so a
  // crowded corridor costs an obstacle's placement, never the obstacle itself.
  const placeNearRoad = (i: number, count: number) =>
    roadside !== undefined && i < Math.round(count * roadside.fraction);

  const rocks: RockObstacle[] = [];
  const rockCount = counts?.rocks ?? randInt(rng, 6, 14);
  for (let i = 0; i < rockCount; i++) {
    const radius = randRange(rng, 20, 40);
    const spacing = spacingFor(radius);
    const pos =
      (placeNearRoad(i, rockCount)
        ? findRoadsideSpot(rng, roadside!, roadside!.rockOffset, width, height, occupied, spacing)
        : null) ?? findSpot(rng, noise, width, height, 0.006, -0.15, occupied, spacing);
    if (!pos) continue;
    occupied.push(pos);
    rocks.push({ pos, radius });
  }

  const muds: MudObstacle[] = [];
  const mudCount = counts?.muds ?? randInt(rng, 4, 10);
  for (let i = 0; i < mudCount; i++) {
    const radius = randRange(rng, 70, 140);
    const spacing = spacingFor(radius);
    const pos =
      (placeNearRoad(i, mudCount)
        ? findRoadsideSpot(rng, roadside!, roadside!.mudOffset, width, height, occupied, spacing)
        : null) ?? findSpot(rng, noise, width, height, 0.004, 0.05, occupied, spacing);
    if (!pos) continue;
    occupied.push(pos);

    const points: Vec2[] = [];
    const vertexCount = 12;
    for (let k = 0; k < vertexCount; k++) {
      const angle = (k / vertexCount) * Math.PI * 2;
      const wobble = 0.65 + 0.35 * (noise(pos.x * 0.05 + k * 3.1, pos.y * 0.05 + k * 1.7) * 0.5 + 0.5);
      points.push(v(pos.x + Math.cos(angle) * radius * wobble, pos.y + Math.sin(angle) * radius * wobble));
    }
    muds.push({ pos, radius, points });
  }

  return { rocks, muds };
}

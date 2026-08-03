import { type Rng, randInt, randRange } from "../util/rng.js";
import { distance, v, type Vec2 } from "../util/vec2.js";
import type { MudObstacle, RockObstacle, Warehouse } from "./types.js";

const MIN_CLEARANCE_FROM_WAREHOUSE = 90;

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
): { rocks: RockObstacle[]; muds: MudObstacle[] } {
  const occupied: Vec2[] = warehouses.map((w) => w.pos);
  const spacingFor = (r: number) => Math.max(MIN_CLEARANCE_FROM_WAREHOUSE, r + 50);

  const rocks: RockObstacle[] = [];
  const rockCount = randInt(rng, 6, 14);
  for (let i = 0; i < rockCount; i++) {
    const radius = randRange(rng, 20, 40);
    const pos = findSpot(rng, noise, width, height, 0.006, -0.15, occupied, spacingFor(radius));
    if (!pos) continue;
    occupied.push(pos);
    rocks.push({ pos, radius });
  }

  const muds: MudObstacle[] = [];
  const mudCount = randInt(rng, 4, 10);
  for (let i = 0; i < mudCount; i++) {
    const radius = randRange(rng, 70, 140);
    const pos = findSpot(rng, noise, width, height, 0.004, 0.05, occupied, spacingFor(radius));
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

import { type Rng, randInt, randRange, shuffle } from "../util/rng.js";
import type { Vec2 } from "../util/vec2.js";
import type { Hub, RoadSegment, Warehouse } from "./types.js";

export function generateWarehouses(
  rng: Rng,
  hubs: Hub[],
  branches: RoadSegment[],
): Warehouse[] {
  const candidates: Vec2[] = [
    ...hubs.map((h) => h.pos),
    ...branches.map((b) => b.p3),
  ];

  const count = Math.max(3, Math.min(randInt(rng, 4, 10), candidates.length));
  const spots = shuffle(rng, candidates).slice(0, count);

  return spots.map((pos, i): Warehouse => {
    const kind = i === 0 ? "base" : i === 1 ? "pickup" : i === 2 ? "destination" : "decorative";
    const size = randRange(rng, 30, 45);
    return {
      kind,
      pos,
      width: size,
      height: size * randRange(rng, 0.75, 1.1),
      angle: randRange(rng, 0, Math.PI * 2),
    };
  });
}

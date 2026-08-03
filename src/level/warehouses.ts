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

  const count = Math.min(randInt(rng, 4, 10), candidates.length);
  const spots = shuffle(rng, candidates).slice(0, count);
  const lastIndex = spots.length - 1;

  // First is always base, last is always the destination; every warehouse
  // in between is a pickup the player must visit before delivering.
  return spots.map((pos, i): Warehouse => {
    const kind = i === 0 ? "base" : i === lastIndex ? "destination" : "pickup";
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

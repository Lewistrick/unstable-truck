import { type Rng, randInt, randRange, shuffle } from "../util/rng.js";
import { distance, type Vec2 } from "../util/vec2.js";
import type { House, Hub, RoadSegment, Warehouse } from "./types.js";

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

function makeWarehouse(rng: Rng, pos: Vec2, kind: Warehouse["kind"]): Warehouse {
  const size = randRange(rng, 30, 45);
  return { kind, pos, width: size, height: size * randRange(rng, 0.75, 1.1), angle: randRange(rng, 0, Math.PI * 2) };
}

/** Weekly maps place a building on every road hub: `warehouseCount` of them
 * become gameplay warehouses (base, pickups, destination) and the rest become
 * decorative houses. The base is the first chosen hub and the destination is
 * the warehouse farthest from it, so the required route spans the big map. */
export function generateWeeklyBuildings(
  rng: Rng,
  hubs: Hub[],
  warehouseCount: number,
): { warehouses: Warehouse[]; houses: House[] } {
  const shuffled = shuffle(rng, [...hubs]);
  const warehouseHubs = shuffled.slice(0, warehouseCount);
  const houseHubs = shuffled.slice(warehouseCount);

  const base = warehouseHubs[0]!;
  let destIndex = 1;
  let farthest = -1;
  for (let i = 1; i < warehouseHubs.length; i++) {
    const d = distance(base.pos, warehouseHubs[i]!.pos);
    if (d > farthest) {
      farthest = d;
      destIndex = i;
    }
  }

  const warehouses = warehouseHubs.map((h, i): Warehouse => {
    const kind = i === 0 ? "base" : i === destIndex ? "destination" : "pickup";
    return makeWarehouse(rng, h.pos, kind);
  });

  const houses = houseHubs.map((h): House => {
    const size = randRange(rng, 18, 30);
    return { pos: h.pos, width: size, height: size * randRange(rng, 0.7, 1.1), angle: randRange(rng, 0, Math.PI * 2) };
  });

  return { warehouses, houses };
}

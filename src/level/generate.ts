import { makeValueNoise2D, mulberry32, seedFromString } from "../util/rng.js";
import { generateObstacles } from "./obstacles.js";
import { generatePalette } from "./palette.js";
import { generateBranches, generateHubs, generateRoads } from "./roads.js";
import type { Level } from "./types.js";
import { generateWarehouses } from "./warehouses.js";

export const WORLD_WIDTH = 2000;
export const WORLD_HEIGHT = 1300;

/** Builds a fully deterministic level from a date string (e.g. "2026-08-03").
 * Same seed always produces an identical road network, warehouse placement,
 * obstacles, and color palette. */
export function generateLevel(seed: string): Level {
  const rng = mulberry32(seedFromString(seed));
  const noise = makeValueNoise2D(rng);

  const hubs = generateHubs(rng, noise, WORLD_WIDTH, WORLD_HEIGHT);
  const mainRoads = generateRoads(rng, hubs);
  const branches = generateBranches(rng, mainRoads, WORLD_WIDTH, WORLD_HEIGHT);
  const roads = [...mainRoads, ...branches];
  const warehouses = generateWarehouses(rng, hubs, branches);
  const { rocks, muds, roughZones } = generateObstacles(
    rng,
    noise,
    WORLD_WIDTH,
    WORLD_HEIGHT,
    warehouses,
  );
  const palette = generatePalette(rng);

  return {
    seed,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    hubs,
    roads,
    warehouses,
    rocks,
    muds,
    roughZones,
    palette,
  };
}

/** Local YYYY-MM-DD, used as today's daily seed. */
export function todaySeed(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

import { makeValueNoise2D, mulberry32, randInt, seedFromString } from "../util/rng.js";
import { generateObstacles } from "./obstacles.js";
import { generatePalette } from "./palette.js";
import { generateBranches, generateHubs, generateRoads } from "./roads.js";
import { generateScenery } from "./scenery.js";
import { pickTheme } from "./themes.js";
import type { Level } from "./types.js";
import { generateWarehouses, generateWeeklyBuildings } from "./warehouses.js";

export const WORLD_WIDTH = 2000;
export const WORLD_HEIGHT = 1300;

// The weekly map is 3x the daily map in every dimension, with many more
// warehouses plus decorative houses so the sprawling road network reads like a
// real region.
const WEEKLY_SCALE = 3;
export const WEEKLY_WIDTH = WORLD_WIDTH * WEEKLY_SCALE;
export const WEEKLY_HEIGHT = WORLD_HEIGHT * WEEKLY_SCALE;

/** Builds a fully deterministic daily level from a date string (e.g.
 * "2026-08-03"). Same seed always produces an identical road network,
 * warehouse placement, obstacles, and color palette. */
export function generateLevel(seed: string): Level {
  const rng = mulberry32(seedFromString(seed));
  const noise = makeValueNoise2D(rng);

  const hubs = generateHubs(rng, noise, WORLD_WIDTH, WORLD_HEIGHT);
  const mainRoads = generateRoads(rng, hubs);
  const branches = generateBranches(rng, mainRoads, WORLD_WIDTH, WORLD_HEIGHT);
  const roads = [...mainRoads, ...branches];
  const warehouses = generateWarehouses(rng, hubs, branches);
  const { rocks, muds } = generateObstacles(rng, noise, WORLD_WIDTH, WORLD_HEIGHT, warehouses);
  const theme = pickTheme(seed);
  const palette = generatePalette(rng, theme);
  const scenery = generateScenery(seed, theme, WORLD_WIDTH, WORLD_HEIGHT, roads, warehouses, [], rocks, muds);

  return {
    seed,
    kind: "daily",
    theme: theme.id,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    hubs,
    roads,
    warehouses,
    houses: [],
    scenery,
    rocks,
    muds,
    palette,
  };
}

/** Builds a deterministic weekly level from a year+week string (e.g.
 * "2026-W31"): a much larger map with 9-15 warehouses, 18-24 decorative
 * houses on the road network, and proportionally more obstacles. */
export function generateWeeklyLevel(seed: string): Level {
  const rng = mulberry32(seedFromString(seed));
  const noise = makeValueNoise2D(rng);

  const warehouseCount = randInt(rng, 8, 16);
  const houseCount = randInt(rng, 16, 32);
  const nodeCount = warehouseCount + houseCount;

  // Larger jitter than daily so the many hubs don't read as a grid, and
  // straight (not curved) roads between them.
  const hubs = generateHubs(rng, noise, WEEKLY_WIDTH, WEEKLY_HEIGHT, nodeCount, 0.75);
  const mainRoads = generateRoads(rng, hubs, randInt(rng, 8, 12), true);
  const branches = generateBranches(rng, mainRoads, WEEKLY_WIDTH, WEEKLY_HEIGHT, randInt(rng, 4, 12), true);
  const roads = [...mainRoads, ...branches];
  const { warehouses, houses } = generateWeeklyBuildings(rng, hubs, warehouseCount);
  const { rocks, muds } = generateObstacles(
    rng,
    noise,
    WEEKLY_WIDTH,
    WEEKLY_HEIGHT,
    warehouses,
    { rocks: randInt(rng, 64, 128), muds: randInt(rng, 48, 96) },
    houses.map((h) => h.pos),
  );
  const theme = pickTheme(seed);
  const palette = generatePalette(rng, theme);
  const scenery = generateScenery(seed, theme, WEEKLY_WIDTH, WEEKLY_HEIGHT, roads, warehouses, houses, rocks, muds);

  return {
    seed,
    kind: "weekly",
    theme: theme.id,
    width: WEEKLY_WIDTH,
    height: WEEKLY_HEIGHT,
    hubs,
    roads,
    warehouses,
    houses,
    scenery,
    rocks,
    muds,
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

/** Shifts a YYYY-MM-DD seed by a number of days (negative for earlier). */
export function shiftSeed(seed: string, deltaDays: number): string {
  const [y, m, d] = seed.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  date.setDate(date.getDate() + deltaDays);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** ISO-8601 week-numbering year and week for a date (weeks start Monday; week
 * 1 is the week containing the year's first Thursday). */
function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Shift to the Thursday of this week; the ISO week-year is that Thursday's year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return { year: isoYear, week };
}

/** The weekly seed (e.g. "2026-W31") for the week `offsetWeeks` back from the
 * current one (0 = this week). Shifting today's date by whole weeks keeps the
 * same weekday, so the ISO week of that date is the target week. */
export function weekSeed(offsetWeeks = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetWeeks * 7);
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

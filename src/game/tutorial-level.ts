import { generatePalette } from "../level/palette.js";
import { generateScenery } from "../level/scenery.js";
import { getTheme } from "../level/themes.js";
import type { Level, MudObstacle, RockObstacle, RoadSegment, Warehouse } from "../level/types.js";
import { mulberry32, seedFromString } from "../util/rng.js";
import { bezierPoint, v, type Vec2 } from "../util/vec2.js";

/** Fixed seed for the tutorial level, so its palette and scenery are stable. */
export const TUTORIAL_SEED = "tutorial";

// A wide, forgiving road so a learner staying roughly on it keeps their cargo
// steady (road terrain recovers stability fastest).
const ROAD_WIDTH = 96;
const SAMPLES_PER_SEGMENT = 24;

/** A dead-straight road piece between two points, pre-sampled the same way the
 * generator's segments are so terrain/road queries behave identically. */
function straightRoad(a: Vec2, b: Vec2): RoadSegment {
  const p1 = v(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3);
  const p2 = v(a.x + ((b.x - a.x) * 2) / 3, a.y + ((b.y - a.y) * 2) / 3);
  const samples: Vec2[] = [];
  for (let i = 0; i <= SAMPLES_PER_SEGMENT; i++) samples.push(bezierPoint(a, p1, p2, b, i / SAMPLES_PER_SEGMENT));
  return { p0: a, p1, p2, p3: b, width: ROAD_WIDTH, isBranch: false, samples };
}

/** A generously sized warehouse (bigger than the generated 30-45 range) so it's
 * easy for a first-timer to actually touch and collect. */
function warehouse(kind: Warehouse["kind"], pos: Vec2): Warehouse {
  return { kind, pos, width: 46, height: 42, angle: 0 };
}

/** Builds the fixed practice level used by the new-player tutorial: a single
 * base -> pickup -> destination run along a wide road, in a calm grassland
 * biome, with no rocks or mud so it can't be failed while the player learns the
 * one-button steering. The map is small enough that the pickup and drop-off
 * stay near the truck as the camera follows it. */
export function buildTutorialLevel(): Level {
  // Laid out left-to-right with a gentle bend, so the truck (which starts aimed
  // at the nearest pickup) heads up-and-right into the W, then down-and-right
  // to the D.
  const base = v(300, 560);
  const pickup = v(620, 350);
  const destination = v(960, 500);

  const roads = [straightRoad(base, pickup), straightRoad(pickup, destination)];
  const warehouses = [warehouse("base", base), warehouse("pickup", pickup), warehouse("destination", destination)];

  const width = 1260;
  const height = 860;
  const rng = mulberry32(seedFromString(TUTORIAL_SEED));
  const theme = getTheme("grassland");
  const palette = generatePalette(rng, theme);
  // Purely-decorative biome props, placed clear of the road and warehouses.
  const scenery = generateScenery(TUTORIAL_SEED, theme, width, height, roads, warehouses, [], [], []);

  return {
    seed: TUTORIAL_SEED,
    kind: "daily",
    theme: theme.id,
    width,
    height,
    hubs: [],
    roads,
    warehouses,
    houses: [],
    scenery,
    rocks: [],
    muds: [],
    palette,
  };
}

// --- Terrain course (the hands-on sections shown after delivery) ------------
//
// Each section is its own small level: a wide road running left-to-right across
// grass, with a goal flag at the right. The player drives from the start to the
// flag, learning one terrain type per section. The mud section adds a puddle
// (no rock); the rock section adds a boulder (no mud), which is solid and
// restarts the section on contact (handled in tutorial.ts).

/** A fixed terrain section: the level to drive, where the truck starts, the
 * flag to reach, and the coaching line to show. */
export interface TerrainSectionSpec {
  readonly level: Level;
  readonly start: { pos: Vec2; heading: number };
  readonly goal: Vec2;
  readonly prompt: string;
}

const SECTION_W = 1120;
const SECTION_H = 700;
const SECTION_MID_Y = 360;
const SECTION_START = v(190, SECTION_MID_Y);
const SECTION_GOAL = v(950, SECTION_MID_Y);
// Centered on the road between the start and the flag, where obstacles sit.
const SECTION_OBSTACLE = v(565, SECTION_MID_Y);

/** A rounded, slightly irregular mud blob (deterministic, no rng) built the way
 * terrain queries expect: a `points` polygon plus a bounding `radius`. */
function mudBlob(center: Vec2, radius: number): MudObstacle {
  const sides = 12;
  const points: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    // A gentle, repeatable wobble so it reads as an organic puddle, not a disc.
    const r = radius * (0.85 + 0.15 * Math.abs(Math.sin(a * 2)));
    points.push(v(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r));
  }
  return { pos: center, radius, points };
}

/** Shared shell for a terrain section: grass background, one wide straight road
 * from just behind the start to just past the flag, plus a grassland palette
 * and scenery placed clear of the road and any obstacles. */
function sectionLevel(seed: string, rocks: RockObstacle[], muds: MudObstacle[]): Level {
  const roads = [straightRoad(v(110, SECTION_MID_Y), v(1010, SECTION_MID_Y))];
  const rng = mulberry32(seedFromString(seed));
  const theme = getTheme("grassland");
  const palette = generatePalette(rng, theme);
  const scenery = generateScenery(seed, theme, SECTION_W, SECTION_H, roads, [], [], rocks, muds);
  return {
    seed,
    kind: "daily",
    theme: theme.id,
    width: SECTION_W,
    height: SECTION_H,
    hubs: [],
    roads,
    warehouses: [],
    houses: [],
    scenery,
    rocks,
    muds,
    palette,
  };
}

/** Section 1: road vs grass. No obstacles - the lesson is that the road is the
 * fast lane and the surrounding grass is slower. */
export function buildRoadGrassSection(): TerrainSectionSpec {
  return {
    level: sectionLevel("tutorial-road", [], []),
    start: { pos: SECTION_START, heading: 0 },
    goal: SECTION_GOAL,
    prompt: "Roads are the fast lane; the grass around them drags you down. Ride the road to the flag.",
  };
}

/** Section 2: mud. A puddle sits across the road (no rock here) - going around
 * it on the grass is faster than ploughing straight through. */
export function buildMudSection(): TerrainSectionSpec {
  return {
    level: sectionLevel("tutorial-mud", [], [mudBlob(SECTION_OBSTACLE, 62)]),
    start: { pos: SECTION_START, heading: 0 },
    goal: SECTION_GOAL,
    prompt: "Mud is slow and slippery. Steer around the puddle instead of through it, then reach the flag.",
  };
}

/** Section 3: rock. A boulder blocks the road (no mud here); it's solid, so
 * driving into it restarts the section - the player has to go around. */
export function buildRockSection(): TerrainSectionSpec {
  return {
    level: sectionLevel("tutorial-rock", [{ pos: SECTION_OBSTACLE, radius: 54 }], []),
    start: { pos: SECTION_START, heading: 0 },
    goal: SECTION_GOAL,
    prompt: "Rocks are solid walls - you can't drive through them. Go around the rock to the flag (hit it and you start over).",
  };
}

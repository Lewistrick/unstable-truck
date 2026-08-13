import { generatePalette } from "../level/palette.js";
import { generateScenery } from "../level/scenery.js";
import { getTheme } from "../level/themes.js";
import type { Level, MudObstacle, RockObstacle, RoadSegment, Warehouse } from "../level/types.js";
import { mulberry32, seedFromString } from "../util/rng.js";
import { bezierPoint, distance, v, type Vec2 } from "../util/vec2.js";

// The fixed levels behind the new-player tutorial's sections. Every one of them
// is shaped like a real level - the truck starts at a `base`, any cargo sits in
// `pickup` warehouses, and the run ends at the `destination` drop-off - so a
// section can be played by an ordinary (practice) GameSession and nothing in
// the tutorial needs its own goal markers or bespoke rules.

// A wide, forgiving road so a learner staying roughly on it keeps their cargo
// steady (road terrain recovers stability fastest).
const ROAD_WIDTH = 96;
// Roughly how far apart a road's pre-sampled centre points sit, in world units.
// The on-road test measures distance to the nearest sample, so samples spaced
// much further apart than the road is wide would scallop its edges - a long
// straight needs proportionally more of them, not a fixed count.
const SAMPLE_SPACING = 10;
const MIN_SAMPLES_PER_SEGMENT = 24;

/** A dead-straight road piece between two points, pre-sampled the same way the
 * generator's segments are so terrain/road queries behave identically. */
function straightRoad(a: Vec2, b: Vec2, width = ROAD_WIDTH): RoadSegment {
  const p1 = v(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3);
  const p2 = v(a.x + ((b.x - a.x) * 2) / 3, a.y + ((b.y - a.y) * 2) / 3);
  const steps = Math.max(MIN_SAMPLES_PER_SEGMENT, Math.ceil(distance(a, b) / SAMPLE_SPACING));
  const samples: Vec2[] = [];
  for (let i = 0; i <= steps; i++) samples.push(bezierPoint(a, p1, p2, b, i / steps));
  return { p0: a, p1, p2, p3: b, width, isBranch: false, samples };
}

/** A chain of straight road pieces through `path`. Joints are drawn with round
 * caps, so a corner reads as a bend rather than a notch. */
function roadPath(path: readonly Vec2[], width = ROAD_WIDTH): RoadSegment[] {
  const roads: RoadSegment[] = [];
  for (let i = 1; i < path.length; i++) roads.push(straightRoad(path[i - 1]!, path[i]!, width));
  return roads;
}

/** A generously sized warehouse (bigger than the generated 30-45 range) so it's
 * easy for a first-timer to actually touch and collect. */
function warehouse(kind: Warehouse["kind"], pos: Vec2): Warehouse {
  return { kind, pos, width: 46, height: 42, angle: 0 };
}

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

interface TutorialLevelSpec {
  seed: string;
  width: number;
  height: number;
  warehouses: Warehouse[];
  roads: RoadSegment[];
  rocks?: RockObstacle[];
  muds?: MudObstacle[];
}

/** Assembles one fixed tutorial level: the given layout in a calm grassland
 * biome, with a seeded palette and decorative scenery placed clear of the
 * roads, warehouses and obstacles. */
function tutorialLevel({ seed, width, height, warehouses, roads, rocks = [], muds = [] }: TutorialLevelSpec): Level {
  const rng = mulberry32(seedFromString(seed));
  const theme = getTheme("grassland");
  const palette = generatePalette(rng, theme);
  const scenery = generateScenery(seed, theme, width, height, roads, warehouses, [], rocks, muds);

  return {
    seed,
    kind: "daily",
    theme: theme.id,
    width,
    height,
    hubs: [],
    roads,
    warehouses,
    houses: [],
    scenery,
    rocks,
    muds,
    palette,
  };
}

// --- The single-lesson lanes ------------------------------------------------
//
// One lesson per level: a road from a base to a drop-off, shaped to force the
// thing being taught, with only that lesson's obstacle type on it. Each one
// also puts something worth looking at just *south* of the truck, because the
// coach card sits over the top of the screen while a section is being explained
// - so the bottom half is what a phone player actually sees.

/** The truck starts at `base` aimed straight at `dropoff`; both sit on `path`,
 * the road's centreline. */
interface LaneSpec {
  seed: string;
  width: number;
  height: number;
  path: Vec2[];
  roadWidth?: number;
  base: Vec2;
  dropoff: Vec2;
  rocks?: RockObstacle[];
  muds?: MudObstacle[];
}

function laneLevel({ seed, width, height, path, roadWidth, base, dropoff, rocks, muds }: LaneSpec): Level {
  return tutorialLevel({
    seed,
    width,
    height,
    roads: roadPath(path, roadWidth),
    warehouses: [warehouse("base", base), warehouse("destination", dropoff)],
    rocks,
    muds,
  });
}

/** Section 1: the one control. A short lane with a road broad enough that
 * wobbling badly while you work out hold-vs-release still leaves you on tarmac,
 * and nothing at all to dodge or collect. */
export function buildSteeringLevel(): Level {
  const y = 360;
  return laneLevel({
    seed: "tutorial-steering",
    width: 1120,
    height: 700,
    // The road runs past both ends, so the truck starts on tarmac and stays on
    // it right up to the drop-off.
    path: [v(110, y), v(1010, y)],
    roadWidth: 280,
    base: v(190, y),
    dropoff: v(950, y),
  });
}

/** Section 3: going straight, and what the road is worth. A long dead-straight
 * run - long enough that you have to keep alternating hold and release to hold
 * a line, and that drifting onto the grass visibly costs you. */
export function buildRoadLevel(): Level {
  const y = 360;
  return laneLevel({
    seed: "tutorial-road",
    width: 2100,
    height: 700,
    path: [v(110, y), v(1990, y)],
    base: v(190, y),
    dropoff: v(1900, y),
  });
}

/** Section 4: mud. The road zig-zags, and two puddles sit across it at the
 * turns - the corners are exactly where cutting the corner onto the grass beats
 * ploughing through. A third puddle sits south of the start line, in view while
 * the section is being explained. (No rock in this one.) */
export function buildMudLevel(): Level {
  const base = v(180, 400);
  const dropoff = v(1150, 400);
  return laneLevel({
    seed: "tutorial-mud",
    width: 1300,
    height: 800,
    // A zig-zag straddling the base -> drop-off line, so the truck starts aimed
    // down the middle of it: the first leg climbs away to the right (which is
    // where coasting takes you) and the second dives back down (which is what
    // holding does).
    path: [v(116, 444), v(500, 180), v(820, 620), v(1210, 360)],
    base,
    dropoff,
    muds: [
      mudBlob(v(180, 545), 62), // the one on show during the explanation
      mudBlob(v(660, 400), 72), // across the first turn
      mudBlob(v(995, 503), 68), // across the second
    ],
  });
}

/** Section 5: rock. The road is a big L - right, then down - with a boulder
 * planted on each leg, so both a straight and a turn have to be driven around
 * one. A third sits south of the start line, in view while the section is being
 * explained. (No mud in this one.) */
export function buildRockLevel(): Level {
  const base = v(200, 220);
  const corner = v(1000, 220);
  const dropoff = v(1000, 620);
  return laneLevel({
    seed: "tutorial-rock",
    width: 1250,
    height: 800,
    // Long leg first, so the truck - which starts aimed at the drop-off, i.e.
    // down the diagonal of the L - only has to coast a moment to line up with
    // it, and the one deliberate turn is the corner.
    path: [v(120, 220), corner, v(1000, 720)],
    base,
    dropoff,
    rocks: [
      { pos: v(200, 350), radius: 46 }, // the one on show during the explanation
      { pos: v(620, 220), radius: 52 }, // on the L's long leg
      { pos: v(1000, 440), radius: 52 }, // on the leg down to the drop-off
    ],
  });
}

// --- The delivery levels ----------------------------------------------------

/** Section 2: one delivery. A single base -> pickup -> drop-off run along a
 * wide road with a gentle bend, and no obstacles, so the only new thing to
 * learn is the cargo swaying behind the truck. */
export function buildCargoLevel(): Level {
  // Laid out left-to-right with a bend, so the truck (which starts aimed at the
  // nearest pickup) heads up-and-right into the W, then down-and-right to the D.
  const base = v(300, 560);
  const pickup = v(620, 350);
  const dropoff = v(960, 500);

  return tutorialLevel({
    seed: "tutorial-cargo",
    width: 1260,
    height: 860,
    roads: [straightRoad(base, pickup), straightRoad(pickup, dropoff)],
    warehouses: [warehouse("base", base), warehouse("pickup", pickup), warehouse("destination", dropoff)],
  });
}

/** Section 6: a real map in miniature - a base, three pickups and a drop-off
 * spread over a map too big to see at once (so off-screen objectives get their
 * edge arrows), a road network that deliberately doesn't reach everywhere, and
 * mud and rock strewn across it. Nothing here is new; it's the graduation lap. */
export function buildFullLevel(): Level {
  const base = v(250, 900);
  // Named for where they sit, since the route between them is the whole point.
  const westPickup = v(620, 620);
  const northPickup = v(900, 260);
  const eastPickup = v(1180, 880);
  const dropoff = v(1480, 420);

  return tutorialLevel({
    seed: "tutorial-full",
    width: 1700,
    height: 1150,
    // Deliberately not a connected network: the west and north pickups share a
    // road with the base, and the east pickup shares one with the drop-off, but
    // crossing between those two halves means driving over open grass.
    roads: [straightRoad(base, westPickup), straightRoad(westPickup, northPickup), straightRoad(eastPickup, dropoff)],
    warehouses: [
      warehouse("base", base),
      warehouse("pickup", westPickup),
      warehouse("pickup", northPickup),
      warehouse("pickup", eastPickup),
      warehouse("destination", dropoff),
    ],
    rocks: [
      { pos: v(760, 780), radius: 48 },
      { pos: v(1120, 520), radius: 42 },
      { pos: v(430, 470), radius: 40 },
    ],
    muds: [mudBlob(v(980, 700), 70), mudBlob(v(1300, 250), 60)],
  });
}

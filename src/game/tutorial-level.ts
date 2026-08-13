import { generatePalette } from "../level/palette.js";
import { generateScenery } from "../level/scenery.js";
import { getTheme } from "../level/themes.js";
import type { Level, MudObstacle, RockObstacle, RoadSegment, Warehouse } from "../level/types.js";
import { mulberry32, seedFromString } from "../util/rng.js";
import { bezierPoint, v, type Vec2 } from "../util/vec2.js";

// The fixed levels behind the new-player tutorial's sections. Every one of them
// is shaped like a real level - the truck starts at a `base`, any cargo sits in
// `pickup` warehouses, and the run ends at the `destination` drop-off - so a
// section can be played by an ordinary (practice) GameSession and nothing in
// the tutorial needs its own goal markers or bespoke rules.

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
// The steering and terrain sections all share one shape: a small map with a
// wide straight road running left-to-right, the base at the left end and the
// drop-off at the right. The lesson is whatever sits on the lane between them.

const LANE_W = 1120;
const LANE_H = 700;
const LANE_Y = 360;
const LANE_BASE = v(190, LANE_Y);
const LANE_DROPOFF = v(950, LANE_Y);
// Centered on the road between the base and the drop-off, where obstacles sit.
const LANE_OBSTACLE = v(565, LANE_Y);

function laneLevel(seed: string, rocks: RockObstacle[] = [], muds: MudObstacle[] = []): Level {
  return tutorialLevel({
    seed,
    width: LANE_W,
    height: LANE_H,
    // The road runs a little past both ends so the truck starts on tarmac and
    // stays on it right up to the drop-off.
    roads: [straightRoad(v(110, LANE_Y), v(1010, LANE_Y))],
    warehouses: [warehouse("base", LANE_BASE), warehouse("destination", LANE_DROPOFF)],
    rocks,
    muds,
  });
}

/** Section 1: the one control. An empty lane - nothing to dodge, nothing to
 * collect, just hold/release your way to the drop-off. */
export function buildSteeringLevel(): Level {
  return laneLevel("tutorial-steering");
}

/** Section 3: road vs grass. Also an empty lane - the lesson is that the road
 * is the fast lane and the surrounding grass drags you down. */
export function buildRoadLevel(): Level {
  return laneLevel("tutorial-road");
}

/** Section 4: mud. A puddle sits across the road (no rock here) - going around
 * it on the grass is faster than ploughing straight through. */
export function buildMudLevel(): Level {
  return laneLevel("tutorial-mud", [], [mudBlob(LANE_OBSTACLE, 62)]);
}

/** Section 5: rock. A boulder blocks the road (no mud here); it's solid, so the
 * player has to steer around it. */
export function buildRockLevel(): Level {
  return laneLevel("tutorial-rock", [{ pos: LANE_OBSTACLE, radius: 54 }], []);
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

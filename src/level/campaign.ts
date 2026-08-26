import {
  type Rng,
  makeValueNoise2D,
  mulberry32,
  randRange,
  seedFromString,
} from "../util/rng.js";
import { add, scale, sub, v, type Vec2 } from "../util/vec2.js";
import { generateObstacles } from "./obstacles.js";
import { generatePalette } from "./palette.js";
import { generateScenery } from "./scenery.js";
import { pickTheme } from "./themes.js";
import type { Hub, Level, RoadSegment, Warehouse } from "./types.js";

/** `2026-aug-C07`, optionally with an author-chosen alternate suffix
 * (`2026-aug-C07-b`) that rerolls the map without changing its slot. */
export const CAMPAIGN_SEED_RE = /^\d{4}-[a-z]{3}-C(\d{2})(?:-(.+))?$/;

export const CAMPAIGN_TOTAL = 25;

const MARGIN = 140;
const SAMPLES_PER_SEGMENT = 24;
/** How much more likely the walk is to carry straight on than to turn. Turns
 * are what make a route interesting, but without some straight bias the walk
 * becomes a dense scribble with no long legs to build speed on. */
const STRAIGHT_WEIGHT = 2.5;
/** Diagonals are drawn slightly less often than orthogonals, so a route reads
 * as a road network with diagonal runs through it rather than as pure zigzag. */
const DIAGONAL_WEIGHT = 0.85;
/** Cap on consecutive straight steps, so a biased walk can't lay down a
 * five-stop drag strip across the whole map. */
const MAX_STRAIGHT_RUN = 3;
/** How far a bend may slide off its grid intersection, as a fraction of a cell.
 * Kept under half a cell so a jittered corner can never cross into a
 * neighbouring cell's territory and tangle two legs together. */
const BEND_JITTER = 0.28;
/** Catmull-Rom rounding: 0 = sharp corners, 1/3 = standard smooth. */
const CORNER_ROUND = 0.45;
const WALK_ATTEMPTS = 400;

/** Eight-way movement. Orthogonals give 90-degree bends, diagonals give
 * 45-degree ones; together with the bend jitter below that is what keeps
 * routes from reading as pure Manhattan grid. */
const STEPS: ReadonlyArray<{ c: number; r: number }> = [
  { c: 1, r: 0 },
  { c: -1, r: 0 },
  { c: 0, r: 1 },
  { c: 0, r: -1 },
  { c: 1, r: 1 },
  { c: 1, r: -1 },
  { c: -1, r: 1 },
  { c: -1, r: -1 },
];

export function parseCampaignSeed(seed: string): { index: number } | null {
  const m = CAMPAIGN_SEED_RE.exec(seed);
  if (!m) return null;
  const index = parseInt(m[1]!, 10);
  if (index < 1 || index > CAMPAIGN_TOTAL) return null;
  return { index };
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface CampaignParams {
  cols: number;
  rows: number;
  /** Cells the route visits. Not the stop count - see stopIndices. */
  walkLength: number;
  cellSize: number;
  /** Fraction of the grid's bounding box the route must span. */
  minCoverage: number;
  roadWidth: number;
  rocks: number;
  muds: number;
}

/** Difficulty ramp across the 25 campaign slots. The grid drives map size,
 * route length and shape variety together, so one knob moves all three. */
function campaignParams(index: number): CampaignParams {
  const t = (index - 1) / (CAMPAIGN_TOTAL - 1);
  return {
    cols: Math.round(mix(6, 10, t)),
    rows: Math.round(mix(4, 7, t)),
    walkLength: Math.round(mix(8, 18, t)),
    cellSize: mix(240, 300, t),
    // Early maps are small enough that demanding a wide span leaves only
    // corner-to-corner staircases; later maps have the room for a doubled-back
    // C or hook to still cover most of the grid.
    minCoverage: mix(0.6, 0.8, t),
    roadWidth: mix(68, 38, t),
    rocks: Math.round(mix(4, 28, t)),
    muds: Math.round(mix(2, 12, t)),
  };
}

interface Cell {
  c: number;
  r: number;
}

function coverage(path: Cell[], cols: number, rows: number): number {
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (const p of path) {
    minC = Math.min(minC, p.c);
    maxC = Math.max(maxC, p.c);
    minR = Math.min(minR, p.r);
    maxR = Math.max(maxR, p.r);
  }
  return ((maxC - minC + 1) / cols) * ((maxR - minR + 1) / rows);
}

/**
 * A self-avoiding walk over the grid, which is what gives campaign routes their
 * shape: because every step is one lattice move, consecutive stops are always
 * axis-aligned and a change of direction is a 90-degree bend, for free.
 *
 * Two rules keep it from producing the two failure modes a plain self-avoiding
 * walk falls into. The no-touch rule forbids stepping beside anything already
 * visited, so the route never runs parallel to itself one cell over - which
 * would let players ignore the road and cut straight across the gap. The
 * coverage floor rejects walks that huddle in one corner; unconstrained walks
 * are compact and leave roughly half the map empty.
 */
function generateWalk(
  rng: Rng,
  cols: number,
  rows: number,
  target: number,
  minCoverage: number,
): Cell[] {
  let best: Cell[] = [];
  let bestCoverage = -1;

  for (let attempt = 0; attempt < WALK_ATTEMPTS; attempt++) {
    const start: Cell = {
      c: Math.floor(rng() * cols),
      r: Math.floor(rng() * rows),
    };
    const path: Cell[] = [start];
    const seen = new Set<number>([start.r * cols + start.c]);
    let straightRun = 0;

    while (path.length < target) {
      const cur = path[path.length - 1]!;
      const prev = path.length > 1 ? path[path.length - 2]! : null;
      const dir = prev ? { c: cur.c - prev.c, r: cur.r - prev.r } : null;

      const options: Cell[] = [];
      const weights: number[] = [];

      for (const step of STEPS) {
        const nc = cur.c + step.c;
        const nr = cur.r + step.r;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        if (seen.has(nr * cols + nc)) continue;

        const diagonal = step.c !== 0 && step.r !== 0;
        // A diagonal that squeezes between two visited cells would draw a road
        // crossing straight over an existing one, so refuse to thread that gap.
        if (
          diagonal &&
          seen.has(cur.r * cols + (cur.c + step.c)) &&
          seen.has((cur.r + step.r) * cols + cur.c)
        ) {
          continue;
        }

        // No-touch: allow at most one visited neighbour (the cell we came from).
        // Checked over all eight neighbours, so a leg can't run alongside an
        // earlier one with a gap the player could just cut across.
        let touching = 0;
        for (const t of STEPS) {
          const tc = nc + t.c;
          const tr = nr + t.r;
          if (tc < 0 || tc >= cols || tr < 0 || tr >= rows) continue;
          if (seen.has(tr * cols + tc)) touching++;
        }
        if (touching > 1) continue;

        const straight = dir !== null && step.c === dir.c && step.r === dir.r;
        if (straight && straightRun >= MAX_STRAIGHT_RUN) continue;

        options.push({ c: nc, r: nr });
        weights.push(
          (straight ? STRAIGHT_WEIGHT : 1) * (diagonal ? DIAGONAL_WEIGHT : 1),
        );
      }

      if (options.length === 0) break; // dead end; this attempt is a bust

      let total = 0;
      for (const w of weights) total += w;
      let roll = rng() * total;
      let chosen = options.length - 1;
      for (let i = 0; i < options.length; i++) {
        roll -= weights[i]!;
        if (roll <= 0) {
          chosen = i;
          break;
        }
      }
      const next = options[chosen]!;

      const wentStraight =
        dir !== null && next.c - cur.c === dir.c && next.r - cur.r === dir.r;
      straightRun = wentStraight ? straightRun + 1 : 0;

      path.push(next);
      seen.add(next.r * cols + next.c);
    }

    const cover = coverage(path, cols, rows);
    // Prefer a longer route; break ties on how much of the grid it spans. This
    // also means `best` is never empty, so a run of bad luck degrades to the
    // best walk found rather than to nothing.
    if (path.length > best.length || (path.length === best.length && cover > bestCoverage)) {
      best = path;
      bestCoverage = cover;
    }
    if (path.length === target && cover >= minCoverage) return path;
  }

  return best;
}

/** Which walk cells get a warehouse: the two endpoints plus every second cell
 * in between. The skipped cells stay as plain road bends, so the route is far
 * longer than the stop count would suggest without piling on stops. */
function stopIndices(walkLength: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < walkLength; i += 2) idx.push(i);
  const last = walkLength - 1;
  if (idx[idx.length - 1] !== last) idx.push(last);
  return idx;
}

function sampleCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= SAMPLES_PER_SEGMENT; i++) {
    const t = i / SAMPLES_PER_SEGMENT;
    pts.push(cubicAt(p0, p1, p2, p3, t));
  }
  return pts;
}

function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  return v(
    mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  );
}

export function generateCampaignLevel(seed: string, index: number): Level {
  const params = campaignParams(index);
  const rng = mulberry32(seedFromString(seed));
  const noise = makeValueNoise2D(rng);

  const { cols, rows, cellSize } = params;
  const width = Math.round((cols - 1) * cellSize + MARGIN * 2);
  const height = Math.round((rows - 1) * cellSize + MARGIN * 2);

  const path = generateWalk(rng, cols, rows, params.walkLength, params.minCoverage);

  // Only the bends matter to the road's shape: a run of steps in one direction
  // is a single straight leg, so collapse it to its endpoints.
  const dirOf = (i: number, j: number) => ({
    c: path[j]!.c - path[i]!.c,
    r: path[j]!.r - path[i]!.r,
  });
  const bends: number[] = [0];
  for (let i = 1; i < path.length - 1; i++) {
    const before = dirOf(i - 1, i);
    const after = dirOf(i, i + 1);
    if (before.c !== after.c || before.r !== after.r) bends.push(i);
  }
  bends.push(path.length - 1);

  // Slide each bend off its grid intersection. This is what stops the network
  // reading as graph paper: legs keep their crisp straight runs and hard
  // corners, but no two of them share an exact angle any more.
  const jitter = BEND_JITTER * cellSize;
  const bendPos: Vec2[] = bends.map((walkIndex) => {
    const cell = path[walkIndex]!;
    return v(
      MARGIN + cell.c * cellSize + randRange(rng, -jitter, jitter),
      MARGIN + cell.r * cellSize + randRange(rng, -jitter, jitter),
    );
  });

  // Catmull-Rom tangent at each bend: interior points blend the directions of
  // the two adjacent legs; endpoints just face the single attached leg.
  const tangent = (i: number): Vec2 => {
    if (i === 0) return sub(bendPos[1]!, bendPos[0]!);
    if (i === bendPos.length - 1) return sub(bendPos[i]!, bendPos[i - 1]!);
    return scale(sub(bendPos[i + 1]!, bendPos[i - 1]!), 0.5);
  };

  const roads: RoadSegment[] = [];
  for (let i = 0; i < bendPos.length - 1; i++) {
    const p0 = bendPos[i]!;
    const p3 = bendPos[i + 1]!;
    const p1 = add(p0, scale(tangent(i), CORNER_ROUND));
    const p2 = sub(p3, scale(tangent(i + 1), CORNER_ROUND));
    roads.push({
      p0, p1, p2, p3,
      width: randRange(rng, params.roadWidth - 4, params.roadWidth + 4),
      isBranch: false,
      samples: sampleCubic(p0, p1, p2, p3),
    });
  }

  // Where a given walk cell ended up after jitter + rounding. Cells in the
  // middle of a leg ride along the bezier curve so warehouses stay on-road.
  const posAt = (walkIndex: number): Vec2 => {
    for (let i = 0; i < bends.length - 1; i++) {
      const from = bends[i]!;
      const to = bends[i + 1]!;
      if (walkIndex >= from && walkIndex <= to) {
        const seg = roads[i]!;
        return cubicAt(seg.p0, seg.p1, seg.p2, seg.p3, (walkIndex - from) / (to - from));
      }
    }
    return bendPos[bendPos.length - 1]!;
  };

  const hubs: Hub[] = path.map((_, id) => ({ id, pos: posAt(id) }));

  const stops = stopIndices(path.length);
  const warehouses: Warehouse[] = stops.map((walkIndex, i): Warehouse => {
    const kind: Warehouse["kind"] =
      i === 0 ? "base" : i === stops.length - 1 ? "destination" : "pickup";
    const size = randRange(rng, 30, 45);
    return {
      kind,
      pos: posAt(walkIndex),
      width: size,
      height: size * randRange(rng, 0.75, 1.1),
      angle: randRange(rng, 0, Math.PI * 2),
    };
  });

  const { rocks, muds } = generateObstacles(rng, noise, width, height, warehouses, {
    rocks: params.rocks,
    muds: params.muds,
  });

  const theme = pickTheme(seed);
  const palette = generatePalette(rng, theme);
  const scenery = generateScenery(
    seed,
    theme,
    width,
    height,
    roads,
    warehouses,
    [],
    rocks,
    muds,
  );

  return {
    seed,
    kind: "campaign",
    theme: theme.id,
    width,
    height,
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

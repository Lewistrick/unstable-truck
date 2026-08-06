import { mulberry32, randInt, randRange, seedFromString, type Rng } from "../util/rng.js";
import { distance, v, type Vec2 } from "../util/vec2.js";
import type { PropKind, Theme } from "./themes.js";
import type { House, MudObstacle, RockObstacle, RoadSegment, SceneryProp, Warehouse } from "./types.js";

// One prop per this much map area, capped so huge weekly maps stay cheap to
// generate. Scenery is culled to the viewport at render time, so the cap keeps
// generation bounded without thinning what's actually on screen too much.
const AREA_PER_PROP = 48_000;
const MAX_PROPS = 600;
const PROP_SPACING = 34; // keep props from stacking on top of each other
const PROP_RADIUS = 14; // rough footprint, added to every clearance check
const PLACEMENT_ATTEMPTS = 14;

interface Keepout {
  pos: Vec2;
  clear: number;
}

function weightedPick(rng: Rng, props: PropKind[], totalWeight: number): PropKind {
  let r = rng() * totalWeight;
  for (const p of props) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return props[props.length - 1]!;
}

/** Scatters a theme's decorative props across the map, avoiding roads,
 * warehouses, houses, and obstacles so nothing sits on the drivable path or on
 * a hazard. Fully deterministic from the seed via a dedicated rng stream, so it
 * never shifts the level's gameplay generation. Returns [] for themes with no
 * props. */
export function generateScenery(
  seed: string,
  theme: Theme,
  width: number,
  height: number,
  roads: RoadSegment[],
  warehouses: Warehouse[],
  houses: House[],
  rocks: RockObstacle[],
  muds: MudObstacle[],
): SceneryProp[] {
  const props = theme.props;
  if (!props || props.length === 0) return [];

  const rng = mulberry32(seedFromString(`${seed}#scenery`));
  const totalWeight = props.reduce((sum, p) => sum + p.weight, 0);

  const keepout: Keepout[] = [];
  for (const road of roads) {
    for (const s of road.samples) keepout.push({ pos: s, clear: road.width / 2 + 12 });
  }
  for (const w of warehouses) keepout.push({ pos: w.pos, clear: Math.max(w.width, w.height) / 2 + 28 });
  for (const h of houses) keepout.push({ pos: h.pos, clear: Math.max(h.width, h.height) / 2 + 14 });
  for (const rock of rocks) keepout.push({ pos: rock.pos, clear: rock.radius + 12 });
  for (const mud of muds) keepout.push({ pos: mud.pos, clear: mud.radius + 8 });

  const target = Math.min(MAX_PROPS, Math.round((width * height) / AREA_PER_PROP));
  const placed: SceneryProp[] = [];
  const positions: Vec2[] = [];

  for (let i = 0; i < target; i++) {
    let spot: Vec2 | null = null;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      const candidate = v(randRange(rng, 20, width - 20), randRange(rng, 20, height - 20));
      if (keepout.some((k) => distance(k.pos, candidate) < k.clear + PROP_RADIUS)) continue;
      if (positions.some((q) => distance(q, candidate) < PROP_SPACING)) continue;
      spot = candidate;
      break;
    }
    if (!spot) continue;

    positions.push(spot);
    const kind = weightedPick(rng, props, totalWeight);
    placed.push({
      kind: kind.kind,
      pos: spot,
      scale: randRange(rng, kind.minScale, kind.maxScale),
      angle: 0,
      variant: randInt(rng, 0, 3),
    });
  }

  return placed;
}

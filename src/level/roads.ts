import { type Rng, randInt, randRange, shuffle } from "../util/rng.js";
import { add, bezierPoint, distance, length, scale, sub, v, type Vec2 } from "../util/vec2.js";
import type { Hub, RoadSegment } from "./types.js";

const SAMPLES_PER_SEGMENT = 24;

function sampleSegment(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= SAMPLES_PER_SEGMENT; i++) {
    pts.push(bezierPoint(p0, p1, p2, p3, i / SAMPLES_PER_SEGMENT));
  }
  return pts;
}

/** Perpendicular unit vector to a-b. */
function perp(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const len = length(d) || 1;
  return v(-d.y / len, d.x / len);
}

function makeSegment(rng: Rng, a: Vec2, b: Vec2, isBranch: boolean): RoadSegment {
  const side = perp(a, b);
  const bow1 = randRange(rng, -0.22, 0.22) * distance(a, b);
  const bow2 = randRange(rng, -0.22, 0.22) * distance(a, b);
  const p1 = add(add(a, scale(sub(b, a), 0.33)), scale(side, bow1));
  const p2 = add(add(a, scale(sub(b, a), 0.66)), scale(side, bow2));
  const width = randRange(rng, isBranch ? 32 : 40, isBranch ? 45 : 55);
  return { p0: a, p1, p2, p3: b, width, isBranch, samples: sampleSegment(a, p1, p2, b) };
}

export function generateHubs(
  rng: Rng,
  noise: (x: number, y: number) => number,
  width: number,
  height: number,
): Hub[] {
  const count = randInt(rng, 4, 10);
  const margin = 170;
  const usableW = width - margin * 2;
  const usableH = height - margin * 2;
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * usableW) / usableH)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = usableW / cols;
  const cellH = usableH / rows;

  const cells: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push({ col: c, row: r });
  }

  const chosen = shuffle(rng, cells).slice(0, count);
  return chosen.map(({ col, row }, id) => {
    const cx = margin + col * cellW + cellW / 2;
    const cy = margin + row * cellH + cellH / 2;
    const jx = noise(col * 0.9 + 11.3, row * 0.9 + 4.7) * cellW * 0.38;
    const jy = noise(col * 0.9 + 71.1, row * 0.9 + 20.9) * cellH * 0.38;
    return { id, pos: v(cx + jx, cy + jy) };
  });
}

/**
 * Connects all hubs with a randomized minimum-ish spanning tree (organic, not
 * shortest-path optimal) so the network is guaranteed connected, then layers
 * in a few extra edges so players have real route choices instead of one
 * forced path.
 */
export function generateRoads(rng: Rng, hubs: Hub[]): RoadSegment[] {
  if (hubs.length < 2) return [];

  const connected = new Set<number>([0]);
  const remaining = new Set(hubs.slice(1).map((h) => h.id));
  const edges: Array<[number, number]> = [];

  while (remaining.size > 0) {
    // Pick a random already-connected hub, then link it to one of its nearest
    // unconnected neighbors (nearest-few, not strictly nearest, for variety).
    const fromId = shuffle(rng, [...connected])[0]!;
    const from = hubs[fromId]!;
    const candidates = [...remaining]
      .map((id) => ({ id, d: distance(from.pos, hubs[id]!.pos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    const target = candidates[Math.floor(rng() * candidates.length)]!;
    edges.push([fromId, target.id]);
    connected.add(target.id);
    remaining.delete(target.id);
  }

  const extraEdges = randInt(rng, 1, 3);
  for (let i = 0; i < extraEdges; i++) {
    const a = hubs[randInt(rng, 0, hubs.length - 1)]!;
    const candidates = hubs
      .filter((h) => h.id !== a.id)
      .map((h) => ({ h, d: distance(a.pos, h.pos) }))
      .sort((x, y) => x.d - y.d)
      .slice(1, 4);
    if (candidates.length === 0) continue;
    const b = candidates[Math.floor(rng() * candidates.length)]!.h;
    const already = edges.some(
      ([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id),
    );
    if (!already) edges.push([a.id, b.id]);
  }

  return edges.map(([aId, bId]) => makeSegment(rng, hubs[aId]!.pos, hubs[bId]!.pos, false));
}

/** Short dead-end forks off the main network for extra route texture. */
export function generateBranches(
  rng: Rng,
  roads: RoadSegment[],
  width: number,
  height: number,
): RoadSegment[] {
  if (roads.length === 0) return [];
  const branchCount = randInt(rng, 2, 4);
  const branches: RoadSegment[] = [];

  for (let i = 0; i < branchCount; i++) {
    const source = roads[randInt(rng, 0, roads.length - 1)]!;
    const t = randRange(rng, 0.25, 0.75);
    const idx = Math.round(t * (source.samples.length - 1));
    const start = source.samples[idx]!;

    const angle = rng() * Math.PI * 2;
    const dist = randRange(rng, 150, 320);
    const end = v(
      Math.max(60, Math.min(width - 60, start.x + Math.cos(angle) * dist)),
      Math.max(60, Math.min(height - 60, start.y + Math.sin(angle) * dist)),
    );
    branches.push(makeSegment(rng, start, end, true));
  }
  return branches;
}

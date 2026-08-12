import { FIXED_DT } from "../physics/constants.js";
import { BASE_MAX_SPEED, MAX_TURN_RATE } from "../physics/truck.js";
import type { Level, Warehouse } from "../level/types.js";
import { angleDiff, distance, type Vec2 } from "../util/vec2.js";
import {
  cloneSimState,
  createSimContext,
  createSimState,
  stepSim,
  type SimContext,
  type SimState,
} from "./sim.js";

/** The route a solve found: a toggle-tick input log (the same format
 * `GameSession.inputLog` / a `GhostRecording` use), the finish time in seconds,
 * the cargo stability it delivers with, and whether it actually completes. */
export interface SolveResult {
  seed: string;
  inputLog: number[];
  time: number;
  ticks: number;
  stability: number;
  success: boolean;
  /** How the winning route was found, for diagnostics/logging. */
  method: "astar" | "greedy" | "none";
  /** Search bookkeeping, handy when tuning or reporting under the time budget. */
  expanded: number;
  elapsedMs: number;
}

export interface SolveOptions {
  /** Wall-clock budget for the A* phase in ms (default 15000, capped to keep
   * well under the 60s hard limit even with the surrounding work). */
  timeBudgetMs?: number;
  /** Absolute cap on run length in ticks; longer partial routes are abandoned
   * (a daily run is a handful of seconds, so 60s of ticks is generous slack). */
  maxTicks?: number;
  /** Overrides the auto-selected discretization (mainly for tests/tuning). */
  params?: Partial<SearchParams>;
}

/** The state-space discretization. Two search states in the same position cell,
 * heading, speed and angular-velocity bucket - with the same number of pickups
 * collected - are treated as interchangeable, and only the one reached in the
 * fewest ticks is kept. Because the visiting order is fixed up front, "pickups
 * collected" is a small count (not a 2^pickups bitmask), so the state space
 * stays linear in pickup count and these buckets can afford to be fine. */
interface SearchParams {
  grid: number;
  headBuckets: number;
  speedBuckets: number;
  angvBuckets: number;
  /** Hard cap on an edge's tick length. Each edge holds one steering input until
   * the discretized state changes (so a slow start doesn't collapse a child onto
   * its parent's cell), but never longer than this - which also bounds how coarse
   * the steering-toggle grid can get at high speed. */
  maxEdge: number;
}

const DEFAULT_PARAMS: SearchParams = {
  grid: 16,
  headBuckets: 64,
  speedBuckets: 6,
  angvBuckets: 5,
  maxEdge: 20,
};

const VMAX_PER_TICK = BASE_MAX_SPEED * FIXED_DT;

// Hard cap on nodes created in a single A* pass, as a memory guardrail that holds
// regardless of the time budget. At ~630 MB RSS for ~1.9M expanded nodes, 5M
// created nodes leaves comfortable headroom under the 1.5 GB limit; a pass that
// hits it just stops early and the ladder keeps whatever route it already has.
const MAX_NODES = 5_000_000;

// Anytime weight ladder for f = g + W*h. A large W is greedy-best-first: it
// dives to *a* valid route fast (crucial on many-pickup maps) but that route can
// be up to a factor W from optimal. Each successive, smaller W re-searches
// pruned by the best time found so far, tightening the route; W = 1 is admissible
// (provably shortest for the fixed order). The search keeps the best route it
// reaches before the time budget runs out, so it always returns something good
// and improves it given more time.
const WEIGHT_LADDER = [3, 2, 1.5, 1.2, 1];

/** Solves for a near-optimal delivery route on a level.
 *
 * Search space: one binary steering input per tick, so the raw tree is 2^ticks
 * (~2^1000 for a daily run) - far too large to brute-force. Two structural facts
 * tame it. First, on the small daily maps the fastest route visits the pickups in
 * one sensible order, so we pin that order (a 2-opt tour) up front; the objective
 * "which pickups are done" then collapses from a 2^pickups bitmask to a single
 * count. Second, the truck's continuous state (position, heading, speed, turn
 * rate) can be bucketed into a lattice on which only the fastest arrival per cell
 * matters. What remains is a shortest-path problem solved with hybrid A*: an
 * admissible "remaining distance through the ordered waypoints / top speed"
 * heuristic, variable-length edges (hold a steering input until the lattice cell
 * changes), and the real physics engine expanding each edge so any route found is
 * genuinely drivable. An anytime weight ladder dives to a valid route first, then
 * tightens it toward optimal within the budget; a greedy pursuit pass is a last
 * fallback if even that comes up empty. */
export function solve(level: Level, options: SolveOptions = {}): SolveResult {
  const startedAt = Date.now();
  const ctx = createSimContext(level);
  const maxTicks = options.maxTicks ?? 3600;
  const timeBudgetMs = Math.min(options.timeBudgetMs ?? 15000, 55000);
  const params = { ...DEFAULT_PARAMS, ...options.params };
  const order = orderPickups(ctx);
  const deadline = startedAt + timeBudgetMs;

  // Anytime weight ladder: dive to a valid route, then tighten it until the
  // budget runs out, keeping the best route reached (see WEIGHT_LADDER).
  let expanded = 0;
  let held: boolean[] | null = null;
  let bound = Infinity;
  // `process` is undeclared in the browser worker, so it must be typeof-guarded
  // (optional chaining alone still throws a ReferenceError on an undeclared name).
  const debug = typeof process !== "undefined" && Boolean(process.env?.SOLVE_DEBUG);

  for (const weight of WEIGHT_LADDER) {
    if (Date.now() >= deadline) break;
    const t0 = Date.now();
    const pass = astarRoute(ctx, params, order, maxTicks, weight, bound, deadline);
    expanded += pass.expanded;
    if (pass.held) {
      held = pass.held;
      bound = pass.ticks;
    }
    if (debug) {
      process.stderr.write(
        `  [W=${weight} ${Date.now() - t0}ms exp=${pass.expanded} ` +
          `${pass.held ? `ticks=${pass.ticks}` : "no-improvement"}]\n`,
      );
    }
    // W = 1 is the admissible bottom of the ladder; nothing smaller would
    // tighten the route further, so stop once it's been run.
    if (weight === 1) break;
  }

  let method: SolveResult["method"] = held ? "astar" : "none";
  if (!held) {
    // Both A* and the ladder came up empty (very tight budget on a hard map);
    // fall back to the pursuit-greedy route if it happens to complete.
    const greedy = greedyRoute(ctx, order, maxTicks);
    if (greedy.success) {
      held = greedy.held;
      method = "greedy";
    }
  }

  if (!held) {
    return {
      seed: level.seed,
      inputLog: [],
      time: 0,
      ticks: 0,
      stability: 0,
      success: false,
      method: "none",
      expanded,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // Re-run the chosen input stream from a clean state to report exact numbers
  // (and to be certain the route it encodes really completes).
  const verified = simulateHeld(ctx, held, maxTicks);
  return {
    seed: level.seed,
    inputLog: toggleTicks(held.slice(0, verified.ticks)),
    time: verified.ticks * FIXED_DT,
    ticks: verified.ticks,
    stability: verified.stability,
    success: verified.success,
    method,
    expanded,
    elapsedMs: Date.now() - startedAt,
  };
}

// --- Visiting order --------------------------------------------------------

/** Pickup indices (into `ctx.pickups`) in the order to visit them: a
 * nearest-neighbour tour from the base, refined by 2-opt, using straight-line
 * distances (base and destination pinned as the path endpoints). This is the
 * same cheap-but-good tour `medals.ts` uses to estimate par, and on the small
 * daily maps it's almost always the order a record route actually follows. */
function orderPickups(ctx: SimContext): number[] {
  const base = mustBase(ctx.level);
  const dest = ctx.destination.pos;
  const pts = ctx.pickups.map((w) => w.pos);
  const n = pts.length;
  if (n <= 1) return pts.map((_, i) => i);

  // Nearest-neighbour seed.
  const remaining = new Set(pts.map((_, i) => i));
  const order: number[] = [];
  let cur = base.pos;
  while (remaining.size > 0) {
    let bestI = -1;
    let bestD = Infinity;
    for (const i of remaining) {
      const d = distance(cur, pts[i]!);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    order.push(bestI);
    cur = pts[bestI]!;
    remaining.delete(bestI);
  }

  // 2-opt: reversing order[i..k] only re-links the two edges at its ends, so the
  // gain is an O(1) check. Sweep to a fixed point (pickup counts are tiny).
  const posOf = (i: number): Vec2 => pts[order[i]!]!;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      const prev = i === 0 ? base.pos : posOf(i - 1);
      for (let k = i + 1; k < order.length; k++) {
        const next = k === order.length - 1 ? dest : posOf(k + 1);
        const gain =
          distance(prev, posOf(i)) + distance(posOf(k), next) - distance(prev, posOf(k)) - distance(posOf(i), next);
        if (gain > 1e-9) {
          for (let lo = i, hi = k; lo < hi; lo++, hi--) {
            const tmp = order[lo]!;
            order[lo] = order[hi]!;
            order[hi] = tmp;
          }
          improved = true;
        }
      }
    }
  }
  return order;
}

function mustBase(level: Level): Warehouse {
  const wh = level.warehouses.find((w) => w.kind === "base");
  if (!wh) throw new Error('Level is missing a "base" warehouse');
  return wh;
}

// --- Greedy baseline -------------------------------------------------------

/** Drives straight at the next objective in the fixed order every tick: hold when
 * the target is to the right of the heading, release when it's to the left. It's
 * not fast, but it almost always completes on the small daily maps, giving A* a
 * valid upper bound to beat (and a fallback if A* runs out of time). */
function greedyRoute(
  ctx: SimContext,
  order: number[],
  maxTicks: number,
): { held: boolean[]; ticks: number; success: boolean } {
  const s = createSimState(ctx);
  const held: boolean[] = [];
  while (s.status === "playing" && s.tick < maxTicks) {
    const target = nextObjective(ctx, order, s);
    const desired = Math.atan2(target.y - s.truck.pos.y, target.x - s.truck.pos.x);
    // angleDiff(heading, desired) > 0 means desired is a positive (right/held)
    // rotation away, so hold; otherwise release to curve the other way.
    const h = angleDiff(s.truck.heading, desired) > 0;
    held.push(h);
    stepSim(ctx, s, h, FIXED_DT);
  }
  return { held, ticks: s.tick, success: s.status === "success" };
}

/** The point the truck should head for next: the first not-yet-collected pickup
 * in the fixed order, or the destination once they're all collected. */
function nextObjective(ctx: SimContext, order: number[], s: SimState): Vec2 {
  for (const i of order) {
    if ((s.visitedMask & (1 << i)) === 0) return ctx.pickups[i]!.pos;
  }
  return ctx.destination.pos;
}

// --- Hybrid A* -------------------------------------------------------------

interface AstarResult {
  /** The winning per-tick input sequence, or null if this pass found no route
   * strictly better than the incumbent bound before it stopped. */
  held: boolean[] | null;
  ticks: number;
  expanded: number;
}

function astarRoute(
  ctx: SimContext,
  params: SearchParams,
  order: number[],
  maxTicks: number,
  weight: number,
  incumbentTicks: number,
  deadline: number,
): AstarResult {
  const { grid, headBuckets, speedBuckets, angvBuckets, maxEdge } = params;
  const cols = Math.max(1, Math.ceil(ctx.level.width / grid));
  const rows = Math.max(1, Math.ceil(ctx.level.height / grid));
  const cellCount = cols * rows;
  const TWO_PI = Math.PI * 2;

  const pickupPos = ctx.pickups.map((w) => w.pos);
  const destPos = ctx.destination.pos;

  /** Discretized identity of a state: (progress, cell, heading, speed, angv),
   * where progress is the number of pickups collected. Because the visiting order
   * is fixed, that count - not a 2^pickups bitmask - is enough to separate stages
   * of the route, keeping the key space linear in pickup count. */
  function keyOf(s: SimState): number {
    const xc = clampi(Math.floor(s.truck.pos.x / grid), 0, cols - 1);
    const yc = clampi(Math.floor(s.truck.pos.y / grid), 0, rows - 1);
    let hdg = s.truck.heading % TWO_PI;
    if (hdg < 0) hdg += TWO_PI;
    const hb = clampi(Math.floor((hdg / TWO_PI) * headBuckets), 0, headBuckets - 1);
    const sb = clampi(Math.floor((s.truck.speed / BASE_MAX_SPEED) * speedBuckets), 0, speedBuckets - 1);
    const ab = clampi(
      Math.floor(((s.truck.angularVel + MAX_TURN_RATE) / (2 * MAX_TURN_RATE)) * angvBuckets),
      0,
      angvBuckets - 1,
    );
    let k = s.visitedCount;
    k = k * cellCount + (yc * cols + xc);
    k = k * headBuckets + hb;
    k = k * speedBuckets + sb;
    k = k * angvBuckets + ab;
    return k;
  }

  /** Admissible remaining-ticks estimate: from here the truck must reach the next
   * uncollected pickup in the order, then each following pickup, then the
   * destination. That ordered chain of straight-line hops is a lower bound on the
   * remaining path length (curves and detours only add), and it can't be driven
   * faster than top speed. Uses the real collected-set from the mask, so it stays
   * accurate even if a pickup was grabbed out of order in passing. */
  function heuristic(s: SimState): number {
    let dist = 0;
    let from = s.truck.pos;
    for (const i of order) {
      if ((s.visitedMask & (1 << i)) !== 0) continue;
      dist += distance(from, pickupPos[i]!);
      from = pickupPos[i]!;
    }
    dist += distance(from, destPos);
    return dist / VMAX_PER_TICK;
  }

  // Parallel node arrays. Sim snapshots are freed once a node is expanded; the
  // parent/held/edge chain is retained just for path reconstruction.
  const nodeSim: Array<SimState | null> = [];
  const nodeG: number[] = [];
  const nodeF: number[] = [];
  const nodeParent: number[] = [];
  const nodeHeld: number[] = [];
  const nodeEdgeTicks: number[] = [];

  const bestG = new Map<number, number>();
  const heap = new MinHeap((a, b) => nodeF[a]! - nodeF[b]!);

  function addNode(sim: SimState | null, g: number, f: number, parent: number, held: number, edgeTicks: number): number {
    const id = nodeG.length;
    nodeSim.push(sim);
    nodeG.push(g);
    nodeF.push(f);
    nodeParent.push(parent);
    nodeHeld.push(held);
    nodeEdgeTicks.push(edgeTicks);
    return id;
  }

  function reconstruct(goalId: number): boolean[] {
    // Walk parents to the root collecting each edge's (held, tickCount), then
    // expand into a per-tick held sequence in chronological order.
    const edges: Array<{ held: number; ticks: number }> = [];
    let cur = goalId;
    while (cur !== -1 && nodeParent[cur] !== -1) {
      edges.push({ held: nodeHeld[cur]!, ticks: nodeEdgeTicks[cur]! });
      cur = nodeParent[cur]!;
    }
    edges.reverse();
    const held: boolean[] = [];
    for (const e of edges) {
      for (let i = 0; i < e.ticks; i++) held.push(e.held === 1);
    }
    return held;
  }

  const start = createSimState(ctx);
  const startId = addNode(start, 0, weight * heuristic(start), -1, 0, 0);
  bestG.set(keyOf(start), 0);
  heap.push(startId);

  let expanded = 0;
  let bound = incumbentTicks;
  let checkClock = 0;

  while (heap.size > 0) {
    const id = heap.pop();
    const g = nodeG[id]!;
    if (nodeF[id]! >= bound) break; // nothing left can beat the incumbent
    const sim = nodeSim[id];
    if (!sim) continue; // superseded before expansion

    if ((checkClock++ & 1023) === 0 && Date.now() > deadline) break;
    if (nodeG.length > MAX_NODES) break; // memory guardrail (see MAX_NODES)

    expanded++;
    const startKey = keyOf(sim);
    for (let hi = 0; hi < 2; hi++) {
      const held = hi === 1;
      const ns = cloneSimState(sim);
      // Variable-length edge: hold this input until the discretized state leaves
      // the parent's cell/heading/speed bucket (so a barely-moving start still
      // makes progress), the run ends, or the edge cap is hit.
      let steps = 0;
      while (steps < maxEdge && ns.status === "playing") {
        stepSim(ctx, ns, held, FIXED_DT);
        steps++;
        if (keyOf(ns) !== startKey) break;
      }
      if (ns.status === "fail") continue;
      const g2 = g + steps;
      if (g2 >= maxTicks) continue;

      if (ns.status === "success") {
        if (g2 < bound) {
          const goalId = addNode(null, g2, g2, id, hi, steps);
          // Return the first goal this weight reaches that beats the incumbent.
          // (First *reached*, not first *popped*, so it isn't a proven optimum -
          // but it strictly improves the bound, and the next, smaller weight
          // re-searches to tighten it further.)
          return { held: reconstruct(goalId), ticks: g2, expanded };
        }
        continue;
      }

      const key = keyOf(ns);
      const prev = bestG.get(key);
      if (prev !== undefined && prev <= g2) continue;
      bestG.set(key, g2);
      const h = heuristic(ns);
      // g2 + h is the admissible cost that the incumbent bound prunes against;
      // the weighted g2 + W*h only sets the search *priority*.
      if (g2 + h >= bound) continue;
      heap.push(addNode(ns, g2, g2 + weight * h, id, hi, steps));
    }

    nodeSim[id] = null; // free the snapshot; the chain fields are enough now
  }

  return { held: null, ticks: 0, expanded };
}

// --- Shared helpers --------------------------------------------------------

/** Re-simulates a per-tick held sequence from a clean state, stopping at the
 * first terminal tick. Returns the exact finish tick, delivered stability, and
 * whether it completed - the authoritative numbers reported for a solve. */
function simulateHeld(
  ctx: SimContext,
  held: boolean[],
  maxTicks: number,
): { ticks: number; stability: number; success: boolean } {
  const s = createSimState(ctx);
  let i = 0;
  while (s.status === "playing" && i < held.length && s.tick < maxTicks) {
    stepSim(ctx, s, held[i]!, FIXED_DT);
    i++;
  }
  const stability = s.cargoBoxes.length === 0 ? 100 : Math.min(...s.cargoBoxes.map((b) => b.stability));
  return { ticks: s.tick, stability, success: s.status === "success" };
}

/** Turns a per-tick held sequence into the toggle-tick log the game persists:
 * the tick indices where the held state flips, starting from released. Identical
 * in meaning to `GameSession.inputLog`. */
export function toggleTicks(held: boolean[]): number[] {
  const toggles: number[] = [];
  let prev = false;
  for (let t = 0; t < held.length; t++) {
    if (held[t] !== prev) {
      toggles.push(t);
      prev = held[t]!;
    }
  }
  return toggles;
}

function clampi(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** A tiny binary min-heap over integer node ids, ordered by a caller-supplied
 * comparator (here, by f-score). Plain arrays, no allocations per push/pop. */
class MinHeap {
  private readonly data: number[] = [];
  constructor(private readonly less: (a: number, b: number) => number) {}

  get size(): number {
    return this.data.length;
  }

  push(id: number): void {
    const d = this.data;
    d.push(id);
    let i = d.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(d[i]!, d[parent]!) < 0) {
        [d[i], d[parent]] = [d[parent]!, d[i]!];
        i = parent;
      } else break;
    }
  }

  pop(): number {
    const d = this.data;
    const top = d[0]!;
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.less(d[l]!, d[smallest]!) < 0) smallest = l;
        if (r < n && this.less(d[r]!, d[smallest]!) < 0) smallest = r;
        if (smallest === i) break;
        [d[i], d[smallest]] = [d[smallest]!, d[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

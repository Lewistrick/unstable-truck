import { sampleTerrainWith } from "../level/terrain.js";
import { LevelIndex } from "../level/level-index.js";
import type { Level, Warehouse } from "../level/types.js";
import {
  applyImpactStabilityHit,
  CARGO_GAP,
  CARGO_MAX_FILL,
  CARGO_UNIT_LENGTH,
  createCargo,
  updateCargo,
  type CargoLeader,
  type CargoState,
} from "../physics/cargo.js";
import { createTruck, resolveRockCollision, updateTruck, type TruckState } from "../physics/truck.js";
import { distance } from "../util/vec2.js";
import {
  OUT_OF_BOUNDS_TICKS,
  ROCK_IMPACT_STABILITY_HIT,
  TRUCK_HITCH_HALF_LENGTH,
  truckTouchesWarehouse,
} from "./session.js";

/** A headless, cheaply-clonable snapshot of a run in progress. It carries the
 * exact same mutable state a {@link GameSession} advances - truck, trailing
 * cargo, which pickups are done, the out-of-bounds counter and the terminal
 * status - but as a plain struct with no DOM, no input log, and no per-tick
 * bookkeeping the solver doesn't need. The solver forks thousands of these while
 * searching, so `cloneSimState` must stay cheap. */
export interface SimState {
  truck: TruckState;
  cargoBoxes: CargoState[];
  /** Bitmask over `SimContext.pickups`: bit i set once pickup i is collected. */
  visitedMask: number;
  visitedCount: number;
  boundaryTicks: number;
  /** Number of physics ticks advanced so far (0 before the first `stepSim`). */
  tick: number;
  status: "playing" | "success" | "fail";
}

/** The immutable, per-level context a {@link SimState} advances against: the
 * warehouses, the map bounds, and the road spatial index. Built once per solve
 * and shared by every forked state. */
export interface SimContext {
  level: Level;
  pickups: Warehouse[];
  destination: Warehouse;
  index: LevelIndex;
}

/** Reproduces {@link GameSession}'s constructor: base at the start, heading
 * toward the nearest pickup (or the destination if there are none). Kept in
 * lockstep with session.ts - the solver-check test drives both from identical
 * inputs and asserts they never diverge. */
export function createSimContext(level: Level): SimContext {
  const base = mustFind(level, "base");
  const destination = mustFind(level, "destination");
  const pickups = level.warehouses.filter((w) => w.kind === "pickup");
  return { level, pickups, destination, index: new LevelIndex(level) };
}

export function createSimState(ctx: SimContext): SimState {
  const base = mustFind(ctx.level, "base");
  let firstTarget: Warehouse = ctx.destination;
  for (const wh of ctx.pickups) {
    if (
      firstTarget === ctx.destination ||
      distance(base.pos, wh.pos) < distance(base.pos, firstTarget.pos)
    ) {
      firstTarget = wh;
    }
  }
  const heading = Math.atan2(firstTarget.pos.y - base.pos.y, firstTarget.pos.x - base.pos.x);
  return {
    truck: createTruck(base.pos, heading),
    cargoBoxes: [],
    visitedMask: 0,
    visitedCount: 0,
    boundaryTicks: 0,
    tick: 0,
    status: "playing",
  };
}

function mustFind(level: Level, kind: Warehouse["kind"]): Warehouse {
  const wh = level.warehouses.find((w) => w.kind === kind);
  if (!wh) throw new Error(`Level is missing a "${kind}" warehouse`);
  return wh;
}

/** A deep-but-shallow copy: every field the physics mutate is duplicated, so the
 * clone can be advanced independently, but nothing else is allocated. This is
 * the hot allocation in the search, hence the hand-written copy over a spread. */
export function cloneSimState(s: SimState): SimState {
  const t = s.truck;
  const boxes = s.cargoBoxes;
  const cloned: CargoState[] = new Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    cloned[i] = {
      pos: { x: b.pos.x, y: b.pos.y },
      heading: b.heading,
      angularVel: b.angularVel,
      stability: b.stability,
      lag: b.lag,
      fill: b.fill,
      length: b.length,
    };
  }
  return {
    truck: {
      pos: { x: t.pos.x, y: t.pos.y },
      vel: { x: t.vel.x, y: t.vel.y },
      heading: t.heading,
      angularVel: t.angularVel,
      speed: t.speed,
      radius: t.radius,
      atBoundary: t.atBoundary,
    },
    cargoBoxes: cloned,
    visitedMask: s.visitedMask,
    visitedCount: s.visitedCount,
    boundaryTicks: s.boundaryTicks,
    tick: s.tick,
    status: s.status,
  };
}

/** Advances one fixed physics tick, mirroring `GameSession.update` exactly (this
 * is a headless run, so it's never in practice mode - a run can fail). The order
 * of operations - steer/move, out-of-bounds check, rock collisions, pickups,
 * cargo follow, cargo-fell-off check, delivery check - matches session.ts step
 * for step; the solver-check test guards against the two drifting apart. */
export function stepSim(ctx: SimContext, s: SimState, held: boolean, dt: number): void {
  if (s.status !== "playing") return;
  s.tick++;

  const onRoad = ctx.index.isOnRoad(s.truck.pos);
  const terrain = sampleTerrainWith(s.truck, ctx.level, onRoad);
  updateTruck(s.truck, held, dt, terrain, { width: ctx.level.width, height: ctx.level.height });

  s.boundaryTicks = s.truck.atBoundary ? s.boundaryTicks + 1 : 0;
  if (s.boundaryTicks >= OUT_OF_BOUNDS_TICKS) {
    s.status = "fail";
    return;
  }

  for (const rock of ctx.level.rocks) {
    // Cheap squared-distance cull: a rock the truck's body can't reach would have
    // `resolveRockCollision` return false without touching the truck, so skipping
    // it is exact. The reach is the rock radius plus the truck body's half-diagonal
    // (hypot(16, 11) ~ 19.4), rounded up to 20.
    const dx = rock.pos.x - s.truck.pos.x;
    const dy = rock.pos.y - s.truck.pos.y;
    const reach = rock.radius + 20;
    if (dx * dx + dy * dy > reach * reach) continue;
    if (resolveRockCollision(s.truck, rock.pos, rock.radius)) {
      for (const box of s.cargoBoxes) applyImpactStabilityHit(box, ROCK_IMPACT_STABILITY_HIT);
    }
  }

  const pickups = ctx.pickups;
  for (let i = 0; i < pickups.length; i++) {
    if ((s.visitedMask & (1 << i)) === 0 && truckTouchesWarehouse(s.truck, pickups[i]!)) {
      s.visitedMask |= 1 << i;
      s.visitedCount++;
      loadPickup(s);
    }
  }

  let leader: CargoLeader = s.truck;
  let leaderHalfLength = TRUCK_HITCH_HALF_LENGTH;
  for (const box of s.cargoBoxes) {
    updateCargo(box, leader, dt, terrain, leaderHalfLength + CARGO_GAP + box.length / 2);
    leader = box;
    leaderHalfLength = box.length / 2;
  }

  for (const box of s.cargoBoxes) {
    if (box.stability <= 0) {
      s.status = "fail";
      return;
    }
  }

  if (s.visitedCount >= pickups.length && truckTouchesWarehouse(s.truck, ctx.destination)) {
    s.status = "success";
  }
}

/** Mirrors `GameSession.loadPickup`: top up the rearmost box until it's full,
 * then start a new one behind it. */
function loadPickup(s: SimState): void {
  const last = s.cargoBoxes[s.cargoBoxes.length - 1];
  if (last && last.fill < CARGO_MAX_FILL) {
    last.fill += 1;
    last.length = last.fill * CARGO_UNIT_LENGTH;
  } else {
    const leader: CargoLeader = last ?? s.truck;
    s.cargoBoxes.push(createCargo(leader));
  }
}

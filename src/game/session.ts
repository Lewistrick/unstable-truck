import { sampleTerrain } from "../level/terrain.js";
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

export type GameStatus = "playing" | "success" | "fail";

/** Why a run ended in failure, so the results screen can tailor its message. */
export type FailReason = "cargo" | "outOfBounds";

/** Per-run options. `practice` makes the run unfailable (used by the new-player
 * tutorial): cargo falling off and driving out of bounds are ignored, so a
 * learner can flail around without a game-over. A successful delivery still
 * registers, so the tutorial can detect completion. */
export interface SessionOptions {
  practice?: boolean;
}

// A little forgiveness added to the truck's radius so grazing a building's edge
// still counts as reaching it.
const COLLECT_PAD = 2;
// Stability drained from every cargo box on a rock impact. Exported so the
// headless solver sim (game/sim.ts) can mirror this run's rules exactly instead
// of hard-coding a copy that could silently drift from live play.
export const ROCK_IMPACT_STABILITY_HIT = 22;
// How many consecutive ticks the truck may be pinned against the map edge
// before the run ends as "out of bounds". At 60 ticks/s this is ~0.4s, long
// enough that clipping a corner on a wide turn slides off harmlessly but
// actually driving into the edge ends the run.
export const OUT_OF_BOUNDS_TICKS = 24;
// Half the truck body length, used as the hitch point the first cargo box
// trails behind.
export const TRUCK_HITCH_HALF_LENGTH = 16;

function findWarehouse(level: Level, kind: Warehouse["kind"]): Warehouse {
  const wh = level.warehouses.find((w) => w.kind === kind);
  if (!wh) throw new Error(`Level is missing a "${kind}" warehouse`);
  return wh;
}

/** True when the truck's collision circle overlaps a warehouse's drawn
 * (rotated) rectangle - the pickup/delivery trigger. Because it uses each
 * building's real size, rotation, and the truck's radius, collection lines up
 * with visibly touching the building rather than a fixed circle around its
 * center. */
export function truckTouchesWarehouse(truck: TruckState, wh: Warehouse): boolean {
  // Truck center expressed in the warehouse's local (unrotated) frame.
  const dx = truck.pos.x - wh.pos.x;
  const dy = truck.pos.y - wh.pos.y;
  const cos = Math.cos(wh.angle);
  const sin = Math.sin(wh.angle);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  // Nearest point on the rectangle to the truck center, then a circle test.
  const nx = Math.max(-wh.width / 2, Math.min(wh.width / 2, lx));
  const ny = Math.max(-wh.height / 2, Math.min(wh.height / 2, ly));
  return Math.hypot(lx - nx, ly - ny) <= truck.radius + COLLECT_PAD;
}

/** Owns one playthrough's mutable state (truck, cargo, objective progress,
 * timer) and advances it frame by frame. Rendering/UI are the caller's job. */
export class GameSession {
  readonly level: Level;
  readonly truck: TruckState;
  readonly base: Warehouse;
  readonly pickups: Warehouse[];
  readonly destination: Warehouse;

  /** One trailing box per pickup visited so far, in visit order: the first
   * box hitches directly behind the truck, and each later box hitches
   * behind the one before it. */
  readonly cargoBoxes: CargoState[] = [];

  visited = new Set<Warehouse>();
  /** The tick each pickup was collected, in collection order. Compared by
   * count (not which warehouse) against a ghost's for the live split time. */
  readonly collectTicks: number[] = [];
  status: GameStatus = "playing";
  /** Set alongside a "fail" status to say what went wrong. */
  failReason: FailReason | null = null;
  elapsed = 0;
  private tick = 0;
  /** Consecutive ticks the truck has been pinned against the map edge. */
  private boundaryTicks = 0;

  /** Tick indices (not seconds - update() is always called once per fixed
   * physics tick) at which the input button toggled held/released, starting
   * from released. A ghost replay reconstructs the exact input stream from
   * just this list, without needing to store per-frame position/state.
   * Whole-tick integers keep the persisted JSON clean plain ints. */
  readonly inputLog: number[] = [];
  private lastHeld = false;

  /** When true the run can't be lost (see SessionOptions.practice). */
  private readonly practice: boolean;

  constructor(level: Level, options: SessionOptions = {}) {
    this.practice = options.practice ?? false;
    this.level = level;
    this.base = findWarehouse(level, "base");
    this.destination = findWarehouse(level, "destination");
    this.pickups = level.warehouses.filter((w) => w.kind === "pickup");

    let firstTarget: Warehouse = this.destination;
    for (const wh of this.pickups) {
      if (firstTarget === this.destination || distance(this.base.pos, wh.pos) < distance(this.base.pos, firstTarget.pos)) {
        firstTarget = wh;
      }
    }
    const heading = Math.atan2(firstTarget.pos.y - this.base.pos.y, firstTarget.pos.x - this.base.pos.x);
    this.truck = createTruck(this.base.pos, heading);
  }

  /** True once at least one pickup has been visited and a cargo box is loaded/trailing. */
  get hasCargo(): boolean {
    return this.cargoBoxes.length > 0;
  }

  /** True once every pickup warehouse has been visited, unlocking delivery. */
  get allPickedUp(): boolean {
    return this.visited.size >= this.pickups.length;
  }

  /** Stability of the shakiest box in the chain - the one at risk of falling
   * off first. 100 while no cargo has been picked up yet. */
  get stability(): number {
    return this.cargoBoxes.length === 0 ? 100 : Math.min(...this.cargoBoxes.map((box) => box.stability));
  }

  /** The current tick index (0 at run start, +1 per update() call). */
  get currentTick(): number {
    return this.tick;
  }

  /** Loads one collected pickup: it tops up the rearmost box by one unit of
   * length until that box is full (CARGO_MAX_FILL), then starts a new box. */
  private loadPickup(): void {
    const last = this.cargoBoxes[this.cargoBoxes.length - 1];
    if (last && last.fill < CARGO_MAX_FILL) {
      last.fill += 1;
      last.length = last.fill * CARGO_UNIT_LENGTH;
    } else {
      const leader: CargoLeader = last ?? this.truck;
      this.cargoBoxes.push(createCargo(leader));
    }
  }

  update(dt: number, held: boolean): void {
    if (this.status !== "playing") return;
    if (held !== this.lastHeld) {
      this.inputLog.push(this.tick);
      this.lastHeld = held;
    }
    this.elapsed += dt;
    this.tick++;

    const terrain = sampleTerrain(this.truck, this.level);
    updateTruck(this.truck, held, dt, terrain, { width: this.level.width, height: this.level.height });

    // Driving into the map edge and holding there ends the run - you're leaving
    // the delivery area. A brief clip resets, so only a sustained push fails.
    this.boundaryTicks = this.truck.atBoundary ? this.boundaryTicks + 1 : 0;
    if (!this.practice && this.boundaryTicks >= OUT_OF_BOUNDS_TICKS) {
      this.status = "fail";
      this.failReason = "outOfBounds";
      return;
    }

    for (const rock of this.level.rocks) {
      const hit = resolveRockCollision(this.truck, rock.pos, rock.radius);
      if (hit) {
        for (const box of this.cargoBoxes) applyImpactStabilityHit(box, ROCK_IMPACT_STABILITY_HIT);
      }
    }

    for (const wh of this.pickups) {
      if (!this.visited.has(wh) && truckTouchesWarehouse(this.truck, wh)) {
        this.visited.add(wh);
        this.collectTicks.push(this.tick);
        this.loadPickup();
      }
    }

    // Each box trails behind the truck's rear (or the box ahead of it), spaced
    // by the leader's and its own half-length so longer boxes don't overlap.
    let leader: CargoLeader = this.truck;
    let leaderHalfLength = TRUCK_HITCH_HALF_LENGTH;
    for (const box of this.cargoBoxes) {
      updateCargo(box, leader, dt, terrain, leaderHalfLength + CARGO_GAP + box.length / 2);
      leader = box;
      leaderHalfLength = box.length / 2;
    }

    if (!this.practice && this.cargoBoxes.some((box) => box.stability <= 0)) {
      this.status = "fail";
      this.failReason = "cargo";
      return;
    }
    if (this.allPickedUp && truckTouchesWarehouse(this.truck, this.destination)) {
      this.status = "success";
    }
  }
}

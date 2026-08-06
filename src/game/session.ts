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

// A little forgiveness added to the truck's radius so grazing a building's edge
// still counts as reaching it.
const COLLECT_PAD = 2;
const ROCK_IMPACT_STABILITY_HIT = 22;
// Half the truck body length, used as the hitch point the first cargo box
// trails behind.
const TRUCK_HITCH_HALF_LENGTH = 16;

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
  status: GameStatus = "playing";
  elapsed = 0;
  private tick = 0;

  /** Tick indices (not seconds - update() is always called once per fixed
   * physics tick) at which the input button toggled held/released, starting
   * from released. A ghost replay reconstructs the exact input stream from
   * just this list, without needing to store per-frame position/state.
   * Whole-tick integers keep the persisted JSON clean plain ints. */
  readonly inputLog: number[] = [];
  private lastHeld = false;

  constructor(level: Level) {
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

    const terrain = sampleTerrain(this.truck.pos, this.level);
    updateTruck(this.truck, held, dt, terrain, { width: this.level.width, height: this.level.height });

    for (const rock of this.level.rocks) {
      const hit = resolveRockCollision(this.truck, rock.pos, rock.radius);
      if (hit) {
        for (const box of this.cargoBoxes) applyImpactStabilityHit(box, ROCK_IMPACT_STABILITY_HIT);
      }
    }

    for (const wh of this.pickups) {
      if (!this.visited.has(wh) && truckTouchesWarehouse(this.truck, wh)) {
        this.visited.add(wh);
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

    if (this.cargoBoxes.some((box) => box.stability <= 0)) {
      this.status = "fail";
      return;
    }
    if (this.allPickedUp && truckTouchesWarehouse(this.truck, this.destination)) {
      this.status = "success";
    }
  }
}

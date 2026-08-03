import { distance } from "../util/vec2.js";
import { applyImpactStabilityHit, createCargo, updateCargo, type CargoLeader, type CargoState } from "../physics/cargo.js";
import { createTruck, resolveRockCollision, updateTruck, type TruckState } from "../physics/truck.js";
import { sampleTerrain } from "../level/terrain.js";
import type { Level, Warehouse } from "../level/types.js";

export type GameStatus = "playing" | "success" | "fail";

const PICKUP_DELIVER_RADIUS = 34;
const ROCK_IMPACT_STABILITY_HIT = 22;

function findWarehouse(level: Level, kind: Warehouse["kind"]): Warehouse {
  const wh = level.warehouses.find((w) => w.kind === kind);
  if (!wh) throw new Error(`Level is missing a "${kind}" warehouse`);
  return wh;
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
      if (!this.visited.has(wh) && distance(this.truck.pos, wh.pos) < PICKUP_DELIVER_RADIUS) {
        this.visited.add(wh);
        const hitchPoint: CargoLeader = this.cargoBoxes[this.cargoBoxes.length - 1] ?? this.truck;
        this.cargoBoxes.push(createCargo(hitchPoint));
      }
    }

    let leader: CargoLeader = this.truck;
    for (const box of this.cargoBoxes) {
      updateCargo(box, leader, dt, terrain);
      leader = box;
    }

    if (this.cargoBoxes.some((box) => box.stability <= 0)) {
      this.status = "fail";
      return;
    }
    if (this.allPickedUp && distance(this.truck.pos, this.destination.pos) < PICKUP_DELIVER_RADIUS) {
      this.status = "success";
    }
  }
}

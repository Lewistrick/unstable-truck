import { distance } from "../util/vec2.js";
import { applyImpactStabilityHit, createCargo, updateCargo, type CargoState } from "../physics/cargo.js";
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
  readonly cargo: CargoState;
  readonly base: Warehouse;
  readonly pickups: Warehouse[];
  readonly destination: Warehouse;

  visited = new Set<Warehouse>();
  status: GameStatus = "playing";
  elapsed = 0;

  /** Times (seconds since run start) at which the input button toggled
   * held/released, starting from released. A ghost replay reconstructs the
   * exact input stream from just this list, without needing to store
   * per-frame position/state. */
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
    this.cargo = createCargo(this.truck);
  }

  /** True once at least one pickup has been visited and the cargo box is loaded/trailing. */
  get hasCargo(): boolean {
    return this.visited.size > 0;
  }

  /** True once every pickup warehouse has been visited, unlocking delivery. */
  get allPickedUp(): boolean {
    return this.visited.size >= this.pickups.length;
  }

  update(dt: number, held: boolean): void {
    if (this.status !== "playing") return;
    if (held !== this.lastHeld) {
      this.inputLog.push(this.elapsed);
      this.lastHeld = held;
    }
    this.elapsed += dt;

    const terrain = sampleTerrain(this.truck.pos, this.level);
    updateTruck(this.truck, held, dt, terrain, { width: this.level.width, height: this.level.height });

    for (const rock of this.level.rocks) {
      const hit = resolveRockCollision(this.truck, rock.pos, rock.radius);
      if (hit && this.hasCargo) applyImpactStabilityHit(this.cargo, ROCK_IMPACT_STABILITY_HIT);
    }

    for (const wh of this.pickups) {
      if (!this.visited.has(wh) && distance(this.truck.pos, wh.pos) < PICKUP_DELIVER_RADIUS) {
        this.visited.add(wh);
      }
    }

    if (!this.hasCargo) {
      // Cargo box isn't loaded yet, so it doesn't trail or destabilize; it
      // just rides along with the truck until the first pickup.
      this.cargo.pos.x = this.truck.pos.x;
      this.cargo.pos.y = this.truck.pos.y;
      this.cargo.angle = this.truck.heading;
      return;
    }

    updateCargo(this.cargo, this.truck, dt, terrain);
    if (this.cargo.stability <= 0) {
      this.status = "fail";
      return;
    }
    if (this.allPickedUp && distance(this.truck.pos, this.destination.pos) < PICKUP_DELIVER_RADIUS) {
      this.status = "success";
    }
  }
}

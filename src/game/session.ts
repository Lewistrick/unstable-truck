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
  readonly pickup: Warehouse;
  readonly destination: Warehouse;

  hasCargo = false;
  status: GameStatus = "playing";
  elapsed = 0;

  constructor(level: Level) {
    this.level = level;
    this.base = findWarehouse(level, "base");
    this.pickup = findWarehouse(level, "pickup");
    this.destination = findWarehouse(level, "destination");

    const heading = Math.atan2(this.pickup.pos.y - this.base.pos.y, this.pickup.pos.x - this.base.pos.x);
    this.truck = createTruck(this.base.pos, heading);
    this.cargo = createCargo(this.truck);
  }

  update(dt: number, held: boolean): void {
    if (this.status !== "playing") return;
    this.elapsed += dt;

    const terrain = sampleTerrain(this.truck.pos, this.level);
    updateTruck(this.truck, held, dt, terrain, { width: this.level.width, height: this.level.height });

    for (const rock of this.level.rocks) {
      const hit = resolveRockCollision(this.truck, rock.pos, rock.radius);
      if (hit && this.hasCargo) applyImpactStabilityHit(this.cargo, ROCK_IMPACT_STABILITY_HIT);
    }

    if (!this.hasCargo) {
      // Cargo box isn't loaded yet, so it doesn't trail or destabilize; it
      // just rides along with the truck until pickup.
      this.cargo.pos.x = this.truck.pos.x;
      this.cargo.pos.y = this.truck.pos.y;
      this.cargo.angle = this.truck.heading;
      if (distance(this.truck.pos, this.pickup.pos) < PICKUP_DELIVER_RADIUS) {
        this.hasCargo = true;
      }
      return;
    }

    updateCargo(this.cargo, this.truck, dt, terrain);
    if (this.cargo.stability <= 0) {
      this.status = "fail";
      return;
    }
    if (distance(this.truck.pos, this.destination.pos) < PICKUP_DELIVER_RADIUS) {
      this.status = "success";
    }
  }
}

import { angleDiff, clamp, length, sub, v, type Vec2 } from "../util/vec2.js";
import type { TerrainSample } from "../level/terrain.js";
import type { TruckState } from "./truck.js";

export interface CargoState {
  pos: Vec2;
  angle: number;
  stability: number;
  lag: number;
}

export function createCargo(truck: TruckState): CargoState {
  return { pos: { ...truck.pos }, angle: truck.heading, stability: 100, lag: 0 };
}

const TRAILER_DISTANCE = 34;
const FOLLOW_RATE = 6.0;
const ANGLE_FOLLOW_RATE = 3.0;
const STABILITY_RECOVER_RATE = 6;
const LAG_INSTABILITY_FACTOR = 0.35;
const TURN_INSTABILITY_FACTOR = 3.5;
const MUD_INSTABILITY = 20;
const ROUGH_INSTABILITY = 10;

/** The cargo box trails behind the truck rather than following it exactly:
 * it eases toward a target point/angle offset behind the truck, so sharp
 * turns make it visibly lag and swing wide. That lag, plus rough terrain and
 * mud, drains the stability meter; smooth driving lets it recover. */
export function updateCargo(cargo: CargoState, truck: TruckState, dt: number, terrain: TerrainSample): void {
  const headingDir = v(Math.cos(truck.heading), Math.sin(truck.heading));
  const target = v(truck.pos.x - headingDir.x * TRAILER_DISTANCE, truck.pos.y - headingDir.y * TRAILER_DISTANCE);
  const lagVec = sub(target, cargo.pos);
  const lagDist = length(lagVec);
  cargo.lag = lagDist;

  cargo.pos.x += lagVec.x * Math.min(1, FOLLOW_RATE * dt);
  cargo.pos.y += lagVec.y * Math.min(1, FOLLOW_RATE * dt);

  const angleDelta = angleDiff(cargo.angle, truck.heading);
  cargo.angle += angleDelta * Math.min(1, ANGLE_FOLLOW_RATE * dt);

  let destabilize = lagDist * LAG_INSTABILITY_FACTOR + Math.abs(truck.angularVel) * TURN_INSTABILITY_FACTOR;
  if (terrain.inMud) destabilize += MUD_INSTABILITY;
  if (terrain.inRough) destabilize += ROUGH_INSTABILITY;

  cargo.stability = clamp(cargo.stability + (STABILITY_RECOVER_RATE - destabilize) * dt, 0, 100);
}

export function applyImpactStabilityHit(cargo: CargoState, amount: number): void {
  cargo.stability = clamp(cargo.stability - amount, 0, 100);
}

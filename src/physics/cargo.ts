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

const TRAILER_DISTANCE = 16;
const FOLLOW_RATE = 11;
const ANGLE_FOLLOW_RATE = 3.0;
const STABILITY_RECOVER_RATE_ON_ROAD = 16;
const STABILITY_RECOVER_RATE_OFF_ROAD = 6;
const LATERAL_INSTABILITY_FACTOR = 0.9;
const GENTLE_TURN_RATE = 1.0;
const TURN_INSTABILITY_FACTOR = 6.0;
const MUD_INSTABILITY = 20;
const ROUGH_INSTABILITY = 10;

/** The cargo box trails behind the truck rather than following it exactly:
 * it eases toward a target point/angle offset behind the truck, so sharp
 * turns make it visibly lag and swing wide. Only the *lateral* (sideways)
 * component of that lag is treated as instability — the steady-state
 * straight-line trailing offset itself is normal and shouldn't drain
 * stability. Sharp turns (angular velocity past a gentle-steering
 * threshold), rough terrain, and mud drain the meter; smooth driving on a
 * road lets it recover quickly. */
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

  const perpDir = v(-headingDir.y, headingDir.x);
  const lateralLag = Math.abs(lagVec.x * perpDir.x + lagVec.y * perpDir.y);
  const sharpTurn = Math.max(0, Math.abs(truck.angularVel) - GENTLE_TURN_RATE);

  let destabilize = lateralLag * LATERAL_INSTABILITY_FACTOR + sharpTurn * TURN_INSTABILITY_FACTOR;
  if (terrain.inMud) destabilize += MUD_INSTABILITY;
  if (terrain.inRough) destabilize += ROUGH_INSTABILITY;

  const recoverRate = terrain.onRoad ? STABILITY_RECOVER_RATE_ON_ROAD : STABILITY_RECOVER_RATE_OFF_ROAD;
  cargo.stability = clamp(cargo.stability + (recoverRate - destabilize) * dt, 0, 100);
}

export function applyImpactStabilityHit(cargo: CargoState, amount: number): void {
  cargo.stability = clamp(cargo.stability - amount, 0, 100);
}

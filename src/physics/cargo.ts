import { angleDiff, clamp, length, sub, v, type Vec2 } from "../util/vec2.js";
import type { TerrainSample } from "../level/terrain.js";

export interface CargoState {
  pos: Vec2;
  heading: number;
  angularVel: number;
  stability: number;
  lag: number;
}

/** Anything a cargo box can trail behind: the truck itself, or the box ahead
 * of it in the chain. */
export interface CargoLeader {
  pos: Vec2;
  heading: number;
  angularVel: number;
}

export function createCargo(leader: CargoLeader): CargoState {
  return { pos: { ...leader.pos }, heading: leader.heading, angularVel: 0, stability: 100, lag: 0 };
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

/** A cargo box trails behind its leader rather than following it exactly: it
 * eases toward a target point/angle offset behind the leader, so sharp turns
 * make it visibly lag and swing wide. Only the *lateral* (sideways)
 * component of that lag is treated as instability — the steady-state
 * straight-line trailing offset itself is normal and shouldn't drain
 * stability. Sharp turns (angular velocity past a gentle-steering threshold)
 * and mud drain the meter; smooth driving on a road lets it recover
 * quickly. When boxes are chained, each one's own swinging becomes the next
 * one's sharp-turn instability, so instability can compound toward the back
 * of the chain. */
export function updateCargo(cargo: CargoState, leader: CargoLeader, dt: number, terrain: TerrainSample): void {
  const headingDir = v(Math.cos(leader.heading), Math.sin(leader.heading));
  const target = v(leader.pos.x - headingDir.x * TRAILER_DISTANCE, leader.pos.y - headingDir.y * TRAILER_DISTANCE);
  const lagVec = sub(target, cargo.pos);
  const lagDist = length(lagVec);
  cargo.lag = lagDist;

  cargo.pos.x += lagVec.x * Math.min(1, FOLLOW_RATE * dt);
  cargo.pos.y += lagVec.y * Math.min(1, FOLLOW_RATE * dt);

  const angleDelta = angleDiff(cargo.heading, leader.heading);
  const angleStep = angleDelta * Math.min(1, ANGLE_FOLLOW_RATE * dt);
  cargo.heading += angleStep;
  cargo.angularVel = dt > 0 ? angleStep / dt : 0;

  const perpDir = v(-headingDir.y, headingDir.x);
  const lateralLag = Math.abs(lagVec.x * perpDir.x + lagVec.y * perpDir.y);
  const sharpTurn = Math.max(0, Math.abs(leader.angularVel) - GENTLE_TURN_RATE);

  let destabilize = lateralLag * LATERAL_INSTABILITY_FACTOR + sharpTurn * TURN_INSTABILITY_FACTOR;
  if (terrain.inMud) destabilize += MUD_INSTABILITY;

  const recoverRate = terrain.onRoad ? STABILITY_RECOVER_RATE_ON_ROAD : STABILITY_RECOVER_RATE_OFF_ROAD;
  cargo.stability = clamp(cargo.stability + (recoverRate - destabilize) * dt, 0, 100);
}

export function applyImpactStabilityHit(cargo: CargoState, amount: number): void {
  cargo.stability = clamp(cargo.stability - amount, 0, 100);
}

import { clamp, v, type Vec2 } from "../util/vec2.js";
import type { TerrainSample } from "../level/terrain.js";

export interface TruckState {
  pos: Vec2;
  vel: Vec2;
  heading: number;
  angularVel: number;
  speed: number;
  radius: number;
}

export function createTruck(pos: Vec2, heading: number): TruckState {
  return { pos: { ...pos }, vel: v(0, 0), heading, angularVel: 0, speed: 0, radius: 14 };
}

const BASE_MAX_SPEED = 260;
const ACCEL = 220;
const MAX_TURN_RATE = 2.6;
const TURN_RESPONSIVENESS = 4.2;

/** Advances truck physics by dt seconds. Steering has a default left bias
 * while coasting and turns right while `held`; both the turn rate and the
 * velocity vector ease toward their targets rather than snapping, giving the
 * truck weight and momentum. */
export function updateTruck(truck: TruckState, held: boolean, dt: number, terrain: TerrainSample): void {
  const turnDir = held ? 1 : -1;
  const targetAngularVel = turnDir * MAX_TURN_RATE;
  truck.angularVel += (targetAngularVel - truck.angularVel) * Math.min(1, TURN_RESPONSIVENESS * dt);
  truck.heading += truck.angularVel * dt;

  let maxSpeed = BASE_MAX_SPEED;
  if (terrain.inMud) maxSpeed *= 0.45;
  else if (!terrain.onRoad) maxSpeed *= 0.85;
  if (terrain.inRough) maxSpeed *= 0.92;

  const accel = truck.speed > maxSpeed ? -ACCEL * 2.2 : ACCEL;
  truck.speed = clamp(truck.speed + accel * dt, 0, BASE_MAX_SPEED);

  const headingDir = v(Math.cos(truck.heading), Math.sin(truck.heading));
  const desiredVel = v(headingDir.x * truck.speed, headingDir.y * truck.speed);
  const grip = terrain.inMud ? 2.2 : 5.2;
  truck.vel.x += (desiredVel.x - truck.vel.x) * Math.min(1, grip * dt);
  truck.vel.y += (desiredVel.y - truck.vel.y) * Math.min(1, grip * dt);

  truck.pos.x += truck.vel.x * dt;
  truck.pos.y += truck.vel.y * dt;
}

/** Resolves a circular collision with a rock: pushes the truck out along the
 * contact normal and kills most of its speed. Returns true if a collision
 * occurred, so the caller can trigger a cargo stability spike. */
export function resolveRockCollision(
  truck: TruckState,
  rockPos: Vec2,
  rockRadius: number,
): boolean {
  const dx = truck.pos.x - rockPos.x;
  const dy = truck.pos.y - rockPos.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const minDist = rockRadius + truck.radius;
  if (dist >= minDist) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;
  truck.pos.x += nx * overlap;
  truck.pos.y += ny * overlap;
  truck.speed *= 0.15;
  truck.vel.x *= 0.15;
  truck.vel.y *= 0.15;
  return true;
}

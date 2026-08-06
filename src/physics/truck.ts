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
const MAX_TURN_RATE = 2.6;
const TURN_RESPONSIVENESS = 4.2;

// Terrain-dependent accel/drag: roads let the truck build speed quickly with
// no extra resistance, while offroad and mud both cap top speed lower AND
// actively bleed speed off (drag) so leaving the road feels like braking,
// not just a lower ceiling.
const ROAD_ACCEL = 260;
const OFFROAD_ACCEL = 140;
const MUD_ACCEL = 70;
const OFFROAD_DRAG = 0.9;
const MUD_DRAG = 2.4;

/** Advances truck physics by dt seconds. Steering has a default left bias
 * while coasting and turns right while `held`; both the turn rate and the
 * velocity vector ease toward their targets rather than snapping, giving the
 * truck weight and momentum. Truck position is clamped to the level bounds
 * so it can never drive off the map. */
export function updateTruck(
  truck: TruckState,
  held: boolean,
  dt: number,
  terrain: TerrainSample,
  bounds: { width: number; height: number },
): void {
  const turnDir = held ? 1 : -1;
  const targetAngularVel = turnDir * MAX_TURN_RATE;
  truck.angularVel += (targetAngularVel - truck.angularVel) * Math.min(1, TURN_RESPONSIVENESS * dt);
  truck.heading += truck.angularVel * dt;

  let maxSpeed = BASE_MAX_SPEED;
  let accel = ROAD_ACCEL;
  let drag = 0;
  if (terrain.inMud) {
    maxSpeed *= 0.45;
    accel = MUD_ACCEL;
    drag = MUD_DRAG;
  } else if (!terrain.onRoad) {
    maxSpeed *= 0.85;
    accel = OFFROAD_ACCEL;
    drag = OFFROAD_DRAG;
  }

  const accelSign = truck.speed > maxSpeed ? -accel * 2.2 : accel;
  truck.speed = clamp(truck.speed + accelSign * dt - drag * truck.speed * dt, 0, BASE_MAX_SPEED);

  const headingDir = v(Math.cos(truck.heading), Math.sin(truck.heading));
  const desiredVel = v(headingDir.x * truck.speed, headingDir.y * truck.speed);
  const grip = terrain.inMud ? 2.2 : 5.2;
  truck.vel.x += (desiredVel.x - truck.vel.x) * Math.min(1, grip * dt);
  truck.vel.y += (desiredVel.y - truck.vel.y) * Math.min(1, grip * dt);

  truck.pos.x += truck.vel.x * dt;
  truck.pos.y += truck.vel.y * dt;

  const minX = truck.radius;
  const minY = truck.radius;
  const maxX = bounds.width - truck.radius;
  const maxY = bounds.height - truck.radius;
  if (truck.pos.x < minX) {
    truck.pos.x = minX;
    truck.vel.x = Math.max(0, truck.vel.x);
  } else if (truck.pos.x > maxX) {
    truck.pos.x = maxX;
    truck.vel.x = Math.min(0, truck.vel.x);
  }
  if (truck.pos.y < minY) {
    truck.pos.y = minY;
    truck.vel.y = Math.max(0, truck.vel.y);
  } else if (truck.pos.y > maxY) {
    truck.pos.y = maxY;
    truck.vel.y = Math.min(0, truck.vel.y);
  }
}

// The truck's collision box, mirroring the drawn body (a 32x22 rectangle, so
// +/-16 along its heading and +/-11 across). Colliding as this rectangle rather
// than a bounding circle matches what the player sees: you can slip past a rock
// alongside the truck (only ~11 out, not the old ~14 circle) instead of being
// stopped by phantom contact.
const TRUCK_HALF_LENGTH = 16;
const TRUCK_HALF_WIDTH = 11;

// A little negative padding, mirroring the warehouse COLLECT_PAD but the other
// way: the collider is a hair smaller than the drawn rock so contact registers
// only once the truck has visibly bitten into the stone. Keeps rocks from
// feeling unforgiving - it looks like you almost drive through them.
const ROCK_FORGIVE = 2;

/** Resolves a collision between the truck's (oriented) rectangular body and a
 * circular rock: pushes the truck out along the contact normal and kills most
 * of its speed. Returns true if a collision occurred, so the caller can trigger
 * a cargo stability spike. */
export function resolveRockCollision(
  truck: TruckState,
  rockPos: Vec2,
  rockRadius: number,
): boolean {
  // Shrink the rock's effective radius so the truck overlaps it slightly before
  // it counts as a hit (see ROCK_FORGIVE).
  const radius = Math.max(0, rockRadius - ROCK_FORGIVE);
  // Rock center in the truck's local frame, where the body is the axis-aligned
  // rectangle [-HALF_LENGTH, HALF_LENGTH] x [-HALF_WIDTH, HALF_WIDTH]. Local x
  // runs along the heading (forward), local y across it.
  const dx = rockPos.x - truck.pos.x;
  const dy = rockPos.y - truck.pos.y;
  const cos = Math.cos(truck.heading);
  const sin = Math.sin(truck.heading);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;

  // Closest point on the rectangle to the rock center.
  const nearX = Math.max(-TRUCK_HALF_LENGTH, Math.min(TRUCK_HALF_LENGTH, lx));
  const nearY = Math.max(-TRUCK_HALF_WIDTH, Math.min(TRUCK_HALF_WIDTH, ly));

  // Local push direction for the truck (away from the rock) and how far.
  let pushX: number;
  let pushY: number;
  let gap: number;
  if (nearX !== lx || nearY !== ly) {
    // Rock center is outside the body: the normal edge/corner case.
    const ex = lx - nearX;
    const ey = ly - nearY;
    const d = Math.hypot(ex, ey) || 0.0001;
    if (d >= radius) return false;
    pushX = -ex / d;
    pushY = -ey / d;
    gap = radius - d;
  } else {
    // Rock center is inside the body (deep overlap): eject along the shallowest
    // axis so the truck pops out the nearest face.
    const penX = TRUCK_HALF_LENGTH - Math.abs(lx);
    const penY = TRUCK_HALF_WIDTH - Math.abs(ly);
    if (penX < penY) {
      pushX = lx > 0 ? -1 : 1;
      pushY = 0;
      gap = penX + radius;
    } else {
      pushX = 0;
      pushY = ly > 0 ? -1 : 1;
      gap = penY + radius;
    }
  }

  // Rotate the local push back into world space and apply it, then damp speed.
  truck.pos.x += (pushX * cos - pushY * sin) * gap;
  truck.pos.y += (pushX * sin + pushY * cos) * gap;
  truck.speed *= 0.15;
  truck.vel.x *= 0.15;
  truck.vel.y *= 0.15;
  return true;
}

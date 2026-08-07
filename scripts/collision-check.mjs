// Lightweight, framework-free checks for the game's two collision shapes. The
// project has no test runner, so this runs against the compiled output the same
// way scripts/screenshots.mjs does:
//   npm run build:client && node scripts/collision-check.mjs
//
// Warehouse pickup/delivery: guards the fix for the old bug where collection
// used a fixed 34-unit circle around the warehouse *center* vs the truck's
// *center point*, so large/elongated/rotated warehouses could be driven over
// without collecting. Rock collision: guards the truck's oriented-rectangle vs
// rock-circle test (it replaced a bounding circle, which hit alongside the
// truck too eagerly).
import { truckTouchesWarehouse } from "../dist/game/session.js";
import { sampleTerrain } from "../dist/level/terrain.js";
import { createTruck, resolveRockCollision, updateTruck } from "../dist/physics/truck.js";

const truck = (x, y) => ({ pos: { x, y }, radius: 14 });
const box = (width, height, angle) => ({ kind: "pickup", pos: { x: 0, y: 0 }, width, height, angle });
const rockTruck = (heading) => ({ pos: { x: 0, y: 0 }, vel: { x: 1, y: 1 }, heading, speed: 5, radius: 14 });

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// A big, elongated box (half-width 22.5). The truck's circle overlaps its edge
// at x=35.5 (gap 13 < radius 14), but the center is 35.5 from the box center -
// beyond the old fixed 34 radius. The old check missed this; the new one hits.
check("large box grazed on the long edge collects", truckTouchesWarehouse(truck(35.5, 0), box(45, 20, 0)), true);

// Same geometry rotated 90 degrees: approaching along the (now vertical) long
// axis must behave identically, proving rotation is handled.
check("rotated box grazed along its long axis collects", truckTouchesWarehouse(truck(0, 35.5), box(45, 20, Math.PI / 2)), true);

// Clear of the building: no collection.
check("truck well clear does not collect", truckTouchesWarehouse(truck(60, 0), box(45, 20, 0)), false);

// Small box, truck touching it: collects.
check("small box touched collects", truckTouchesWarehouse(truck(25, 0), box(30, 22.5, 0)), true);

// Small box (half-height 11.25), truck 32 units off along the short axis: the
// truck body is ~20 units clear, so no collection. A fixed 34 radius would have
// wrongly collected this from well before the truck reached the building.
check("small box not over-collected from a distance", truckTouchesWarehouse(truck(0, 32), box(30, 22.5, 0)), false);

// --- Rock collision (truck rectangle vs rock circle) ----------------------

// Alongside the truck: with the body only 11 wide, a rock centered 32 out (gap
// 32 - 11 = 21 > radius 20) is clear. The old bounding circle (14) would have
// hit here (32 < 20 + 14), which is exactly the "too unforgiving" case.
check("rock alongside the body just clears", resolveRockCollision(rockTruck(0), { x: 0, y: 32 }, 20), false);

// Head-on: a rock 33 ahead overlaps the nose. The collider shrinks the rock's
// radius by ROCK_FORGIVE (2), so the effective radius is 18: 33 < 16 + 18 hits.
{
  const t = rockTruck(0);
  const hit = resolveRockCollision(t, { x: 33, y: 0 }, 20);
  check("rock ahead of the nose collides", hit, true);
  // Nose at +16, effective radius 18 -> truck must sit at x = 33 - 34 = -1,
  // leaving it overlapping the drawn rock by ROCK_FORGIVE.
  check("rock collision pushes the truck to the forgiving contact", Math.abs(t.pos.x - -1) < 1e-6, true);
}

// Forgiveness: a rock 35 ahead grazes the nose by 1 (35 < 16 + 20) but clears
// the shrunk collider (35 >= 16 + 18), so the truck drives through the graze.
check("rock grazing the nose is forgiven", resolveRockCollision(rockTruck(0), { x: 35, y: 0 }, 20), false);

// Rotated 90 degrees: the body's short axis now faces world +x, so a rock 33
// out along it clears (proving the box rotates with the heading; a length-based
// 16 half-extent would instead have collided).
check("rotated truck clears a rock off its side", resolveRockCollision(rockTruck(Math.PI / 2), { x: 33, y: 0 }, 20), false);

// --- Mud terrain (truck body vs mud polygon) ------------------------------

// A 20x24 mud square centered at (20, 0). Its bounding radius is ~15.6.
const mudSquare = [
  { x: 10, y: -12 },
  { x: 30, y: -12 },
  { x: 30, y: 12 },
  { x: 10, y: 12 },
];
const mudLevel = { roads: [], muds: [{ pos: { x: 20, y: 0 }, radius: 16, points: mudSquare }] };

// Truck center at (5, 0) is outside the polygon (x < 10), but its (inset) front
// corner reaches (19, 9), which is well inside - so the body-aware test
// registers mud. The old center-point test would have said "not in mud" here.
check("mud registers when a body corner is over it", sampleTerrain({ pos: { x: 5, y: 0 }, heading: 0 }, mudLevel).inMud, true);

// Forgiveness: at x = -5 the full 16-long body corner would reach x = 11 (just
// inside the patch, edge at x = 10), but the inset probe corner (14 long) only
// reaches x = 9, so mud does not register - the truck's edge grazes the patch
// without slowing.
check("mud edge graze is forgiven", sampleTerrain({ pos: { x: -5, y: 0 }, heading: 0 }, mudLevel).inMud, false);

// Well clear of the patch: not in mud.
check("mud clear when the whole body is outside", sampleTerrain({ pos: { x: -30, y: 0 }, heading: 0 }, mudLevel).inMud, false);

// --- Out-of-bounds detection (truck.atBoundary drives the run's fail) ------

const flatTerrain = { onRoad: true, inMud: false, mud: null };
const bounds = { width: 2000, height: 1300 };

// A truck pushed past the map edge is clamped back in and flags atBoundary -
// the signal the session counts up to end the run as "out of bounds".
{
  const t = createTruck({ x: 1000, y: 650 }, 0);
  t.pos.x = 5000;
  updateTruck(t, false, 1 / 60, flatTerrain, bounds);
  check("truck past the edge sets atBoundary", t.atBoundary, true);
  check("truck past the edge is clamped back in bounds", t.pos.x <= bounds.width - t.radius + 1e-6, true);
}

// A truck well inside the map is not at the boundary, so the run continues.
{
  const t = createTruck({ x: 1000, y: 650 }, 0);
  updateTruck(t, false, 1 / 60, flatTerrain, bounds);
  check("truck in the middle is not atBoundary", t.atBoundary, false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall collision checks passed");

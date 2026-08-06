// Lightweight, framework-free checks for warehouse pickup/delivery collision.
// The project has no test runner, so this runs against the compiled output the
// same way scripts/screenshots.mjs does:
//   npm run build:client && node scripts/collision-check.mjs
//
// It guards the fix for the old bug where collection used a fixed 34-unit circle
// around the warehouse *center* vs the truck's *center point*: large, elongated,
// or rotated warehouses could be visibly driven over without ever collecting,
// because the truck's center never got within 34 of the box center.
import { truckTouchesWarehouse } from "../dist/game/session.js";

const truck = (x, y) => ({ pos: { x, y }, radius: 14 });
const box = (width, height, angle) => ({ kind: "pickup", pos: { x: 0, y: 0 }, width, height, angle });

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall collision checks passed");

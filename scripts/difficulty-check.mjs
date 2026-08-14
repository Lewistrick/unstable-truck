// Framework-free checks for the Easy/Hard difficulty split, run the same way
// as the other checks:
//   npm run build:client && node scripts/difficulty-check.mjs
//
// Easy is a real, scored game mode (unlike the tutorial's `practice` flag): it
// shares practice's unfailable cargo/boundary rules but also caps the truck's
// top speed lower. These guard both rules, that Hard is unaffected, and that a
// ghost replayed under the wrong difficulty doesn't silently reuse the other's
// physics.
import { createTruck, EASY_MAX_SPEED, BASE_MAX_SPEED, updateTruck } from "../dist/physics/truck.js";
import { GameSession } from "../dist/game/session.js";
import { GhostPlayer } from "../dist/game/ghost.js";
import { generateLevel } from "../dist/level/generate.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

check("easy tops out lower than hard", EASY_MAX_SPEED < BASE_MAX_SPEED, true);

const level = generateLevel("2026-08-12");

/** Drives `ticks` updates while pinning the truck past the map edge each tick,
 * exactly like tutorial-check's driveIntoWall. Returns the final status. */
function driveIntoWall(session, ticks) {
  for (let i = 0; i < ticks; i++) {
    session.truck.pos.x = level.width + 1000;
    session.update(1 / 60, false);
  }
  return session.status;
}

{
  const hard = driveIntoWall(new GameSession(level, { difficulty: "hard" }), 40);
  check("hard fails when driven out of bounds", hard, "fail");

  const easy = driveIntoWall(new GameSession(level, { difficulty: "easy" }), 40);
  check("easy never fails out of bounds", easy, "playing");

  const defaulted = driveIntoWall(new GameSession(level), 40);
  check("no difficulty option defaults to hard", defaulted, "fail");
}

/** Forces a loaded cargo box into a hopeless state (mirrors tutorial-check's
 * dropCargo) so its stability is driven to 0 in a single tick. */
function dropCargo(difficulty) {
  const scratch = {
    seed: "scratch",
    kind: "daily",
    theme: "grassland",
    width: 800,
    height: 600,
    hubs: [],
    roads: [],
    houses: [],
    scenery: [],
    rocks: [],
    muds: [],
    palette: level.palette,
    warehouses: [
      { kind: "base", pos: { x: 400, y: 300 }, width: 40, height: 40, angle: 0 },
      { kind: "pickup", pos: { x: 600, y: 300 }, width: 40, height: 40, angle: 0 },
      { kind: "destination", pos: { x: 200, y: 300 }, width: 40, height: 40, angle: 0 },
    ],
  };
  const session = new GameSession(scratch, { difficulty });
  session.cargoBoxes.push({ pos: { x: 50, y: 50 }, heading: 0, angularVel: 0, stability: 1, lag: 0, fill: 1, length: 9 });
  session.update(1 / 60, false);
  return session.status;
}

check("hard fails when cargo falls off", dropCargo("hard"), "fail");
check("easy never fails on cargo", dropCargo("easy"), "playing");

// Truck top speed actually caps at the right ceiling. Drive straight (held
// false the whole time so it doesn't curve off whatever it's standing on) on
// flat on-road terrain - no mud/offroad multiplier in the way - for long
// enough that speed settles, then compare against each difficulty's ceiling.
const flatRoad = { onRoad: true, inMud: false, mud: null };
const bounds = { width: 100000, height: 100000 }; // far from any edge
function settledTopSpeed(topSpeed) {
  const truck = createTruck({ x: 50000, y: 50000 }, 0);
  for (let i = 0; i < 600; i++) updateTruck(truck, false, 1 / 60, flatRoad, bounds, topSpeed);
  return truck.speed;
}

check("hard settles at its top speed", Math.abs(settledTopSpeed(BASE_MAX_SPEED) - BASE_MAX_SPEED) < 1, true);
check("easy settles at its (lower) top speed", Math.abs(settledTopSpeed(EASY_MAX_SPEED) - EASY_MAX_SPEED) < 1, true);
check("omitting topSpeed defaults to hard's ceiling", Math.abs(settledTopSpeed(undefined) - BASE_MAX_SPEED) < 1, true);

// A ghost recorded on one difficulty must be replayed on that same difficulty
// - GhostPlayer takes it explicitly rather than reading it off the recording,
// so this confirms the parameter actually reaches the underlying session (an
// easy-replayed ghost tops out at the lower speed too, when driven straight
// on-road the same way).
{
  const recording = { seed: level.seed, time: 10, stability: 100, inputLog: [] };
  const easyGhost = new GhostPlayer(level, recording, "easy");
  for (let i = 0; i < 600; i++) easyGhost.update(1 / 60);
  check("a ghost replayed on easy never exceeds easy's top speed", easyGhost.truck.speed <= EASY_MAX_SPEED + 0.1, true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall difficulty checks passed");

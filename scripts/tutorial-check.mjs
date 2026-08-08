// Framework-free checks for the new-player tutorial's "practice" mode and its
// fixed level, run the same way as the other checks:
//   npm run build:client && node scripts/tutorial-check.mjs
//
// The tutorial must be *unfailable* so a learner can flail around while getting
// the hang of the one control: a practice GameSession ignores both the
// out-of-bounds and cargo-fell-off game-overs that a normal run ends on. These
// guard that the practice flag actually suppresses each fail path (and that a
// normal run still fails, so the flag isn't just disabling failure everywhere).
import { GameSession } from "../dist/game/session.js";
import {
  buildMudSection,
  buildRoadGrassSection,
  buildRockSection,
  buildTutorialLevel,
} from "../dist/game/tutorial-level.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// --- The tutorial level -----------------------------------------------------

const level = buildTutorialLevel();
const kinds = level.warehouses.map((w) => w.kind).sort();
check("tutorial level has exactly one base", kinds.filter((k) => k === "base").length, 1);
check("tutorial level has exactly one pickup", kinds.filter((k) => k === "pickup").length, 1);
check("tutorial level has exactly one destination", kinds.filter((k) => k === "destination").length, 1);
check("tutorial level has no rocks", level.rocks.length, 0);
check("tutorial level has no mud", level.muds.length, 0);

// --- Terrain course sections ------------------------------------------------
// Each section has a road (and grass, which is the default background); the mud
// section carries mud but no rock, and the rock section carries rock but no mud.

const road = buildRoadGrassSection();
check("road/grass section has a road", road.level.roads.length > 0, true);
check("road/grass section has no mud", road.level.muds.length, 0);
check("road/grass section has no rock", road.level.rocks.length, 0);
check("road/grass section has a goal flag", typeof road.goal.x === "number" && typeof road.goal.y === "number", true);

const mud = buildMudSection();
check("mud section has a road", mud.level.roads.length > 0, true);
check("mud section has mud", mud.level.muds.length > 0, true);
check("mud section has no rock", mud.level.rocks.length, 0);

const rock = buildRockSection();
check("rock section has a road", rock.level.roads.length > 0, true);
check("rock section has rock", rock.level.rocks.length > 0, true);
check("rock section has no mud", rock.level.muds.length, 0);

// --- Out-of-bounds: practice ignores it, a normal run ends on it ------------

/** Runs `ticks` updates while pinning the truck past the map edge each tick, so
 * updateTruck clamps it and flags atBoundary - the signal a run counts up to a
 * fail. Returns the final status. */
function driveIntoWall(session, ticks) {
  for (let i = 0; i < ticks; i++) {
    session.truck.pos.x = level.width + 1000; // shove past the right edge
    session.update(1 / 60, false);
  }
  return { status: session.status, reason: session.failReason };
}

{
  // 40 ticks is well past OUT_OF_BOUNDS_TICKS (24).
  const normal = driveIntoWall(new GameSession(level), 40);
  check("normal run fails when driven out of bounds", normal.status, "fail");
  check("normal out-of-bounds fail is flagged as such", normal.reason, "outOfBounds");

  const practice = driveIntoWall(new GameSession(level, { practice: true }), 40);
  check("practice run never fails out of bounds", practice.status, "playing");
}

// --- Cargo fell off: practice ignores it, a normal run ends on it -----------

/** Forces a loaded cargo box into a hopeless state (far from the truck and off
 * any road) so its stability is driven to 0 in a single tick, then updates
 * once. Returns the final status. */
function dropCargo(practice) {
  // A scratch level with no roads, so cargo can't recover, and warehouses the
  // session needs. Placement is irrelevant beyond existing.
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
  const session = new GameSession(scratch, practice ? { practice: true } : {});
  // A box that starts barely stable and sits far off behind the truck: the huge
  // lateral lag destabilizes it well past its recovery rate, clamping it to 0.
  session.cargoBoxes.push({ pos: { x: 50, y: 50 }, heading: 0, angularVel: 0, stability: 1, lag: 0, fill: 1, length: 9 });
  session.update(1 / 60, false);
  return { status: session.status, reason: session.failReason };
}

{
  const normal = dropCargo(false);
  check("normal run fails when cargo falls off", normal.status, "fail");
  check("normal cargo fail is flagged as such", normal.reason, "cargo");

  const practice = dropCargo(true);
  check("practice run never fails on cargo", practice.status, "playing");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall tutorial checks passed");

// Framework-free checks for the new-player tutorial: its fixed levels, the
// "practice" session mode they run on, and the explain/play cycle each section
// steps through. Run the same way as the other checks:
//   npm run build:client && node scripts/tutorial-check.mjs
//
// The tutorial must be *unfailable* so a learner can flail around while getting
// the hang of the one control: a practice GameSession ignores both the
// out-of-bounds and cargo-fell-off game-overs that a normal run ends on. The
// tutorial layer adds its own, gentler setbacks on top (out of bounds or over
// the time limit sends the player back to the explanation), which are checked
// here too.
import { COUNTDOWN_DURATION } from "../dist/game/countdown.js";
import { isOnRoad } from "../dist/level/terrain.js";
import { GameSession } from "../dist/game/session.js";
import { PLAY_TIME_LIMIT, Tutorial } from "../dist/game/tutorial.js";
import {
  buildCargoLevel,
  buildFullLevel,
  buildMudLevel,
  buildRoadLevel,
  buildRockLevel,
  buildSteeringLevel,
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

const kindCount = (level, kind) => level.warehouses.filter((w) => w.kind === kind).length;

// --- The section levels -----------------------------------------------------
// Every section is shaped like a real level - the truck starts at a base and
// finishes at a drop-off (no bespoke goal flags anywhere) - so each one can be
// played by an ordinary GameSession.

for (const [name, level] of [
  ["steering", buildSteeringLevel()],
  ["cargo", buildCargoLevel()],
  ["road", buildRoadLevel()],
  ["mud", buildMudLevel()],
  ["rock", buildRockLevel()],
  ["full", buildFullLevel()],
]) {
  check(`${name} level has exactly one base`, kindCount(level, "base"), 1);
  check(`${name} level has exactly one drop-off`, kindCount(level, "destination"), 1);
  check(`${name} level has a road`, level.roads.length > 0, true);
  // Every warehouse is placed by hand on a hand-written road path, so a typo in
  // either would strand an objective out on the grass. These levels are also
  // hand-sized, so nothing may poke outside the map.
  for (const wh of level.warehouses) {
    check(`${name} level's ${wh.kind} sits on the road`, isOnRoad(wh.pos, level), true);
    const inside =
      wh.pos.x > wh.width && wh.pos.x < level.width - wh.width &&
      wh.pos.y > wh.height && wh.pos.y < level.height - wh.height;
    check(`${name} level's ${wh.kind} is inside the map`, inside, true);
  }
  for (const rock of [...level.rocks, ...level.muds]) {
    const inside =
      rock.pos.x - rock.radius > 0 && rock.pos.x + rock.radius < level.width &&
      rock.pos.y - rock.radius > 0 && rock.pos.y + rock.radius < level.height;
    check(`${name} level's obstacles are inside the map`, inside, true);
  }
}

// The lesson each section is built to teach: only the mud level carries mud,
// only the rock level carries rock, and the steering/road lanes carry neither.
const steering = buildSteeringLevel();
const road = buildRoadLevel();
const mud = buildMudLevel();
const rock = buildRockLevel();

check("steering level has no obstacles", steering.rocks.length + steering.muds.length, 0);
check("road level has no obstacles", road.rocks.length + road.muds.length, 0);
check("mud level has mud", mud.muds.length > 0, true);
check("mud level has no rock", mud.rocks.length, 0);
check("rock level has rock", rock.rocks.length > 0, true);
check("rock level has no mud", rock.muds.length, 0);

// The steering lane is a pure "reach the drop-off" run: nothing to collect.
check("steering level has no pickups", kindCount(steering, "pickup"), 0);
check("cargo level has one pickup", kindCount(buildCargoLevel(), "pickup"), 1);

/** How far the truck has to drive, as the crow flies, from base to drop-off. */
function runLength(level) {
  const from = level.warehouses.find((w) => w.kind === "base").pos;
  const to = level.warehouses.find((w) => w.kind === "destination").pos;
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** The obstacle nearest a point, and how far its edge is from it. */
function nearestGap(obstacles, pos) {
  return Math.min(...obstacles.map((o) => Math.hypot(o.pos.x - pos.x, o.pos.y - pos.y) - o.radius));
}

const baseOf = (level) => level.warehouses.find((w) => w.kind === "base").pos;

// The lane shapes each lesson leans on. Section 1 forgives a wobble with a road
// far broader than the standard one; section 3 is a long, dead-straight run to
// practise holding a line on.
check("steering road is much broader than a normal one", steering.roads[0].width > road.roads[0].width * 2, true);
check("steering lane is one straight piece", steering.roads.length, 1);
check("road lane is one straight piece", road.roads.length, 1);
check("road lane is a longer run than the steering lane", runLength(road) > runLength(steering) * 2, true);
check("mud lane zig-zags", mud.roads.length >= 3, true);
check("rock lane is an L", rock.roads.length, 2);

// Both obstacle sections put one obstacle just south of the start line: it's
// what a phone player can see below the coach card while reading the
// explanation. It has to be clear of the truck, and off the road (it's there to
// be looked at, not driven into on the first tick).
for (const [name, level, obstacles] of [
  ["mud", mud, mud.muds],
  ["rock", rock, rock.rocks],
]) {
  const start = baseOf(level);
  const south = obstacles.filter((o) => o.pos.y > start.y && Math.abs(o.pos.x - start.x) < 100);
  check(`${name} lane has an obstacle just south of the start`, south.length, 1);
  check(`${name} lane's southern obstacle is off the road`, isOnRoad(south[0].pos, level), false);
  check(`${name} lane's southern obstacle is clear of the truck`, nearestGap(south, start) > 40, true);
  // Close enough to be on screen with the truck (the view spans at least 640
  // world units on the short axis, and this sits along the long one).
  check(`${name} lane's southern obstacle is on screen`, south[0].pos.y - start.y < 320, true);
  // ...and the rest are out on the route, where they have to be driven around.
  check(`${name} lane's other obstacles block the route`, obstacles.length - south.length, 2);
  for (const o of obstacles.filter((x) => x !== south[0])) {
    check(`${name} lane's route obstacle sits on the road`, isOnRoad(o.pos, level), true);
  }
}

// The closing section looks like a real map: three pickups to collect, a road
// network that deliberately doesn't connect everything, and both obstacle types.
{
  const full = buildFullLevel();
  check("full level has three pickups", kindCount(full, "pickup"), 3);
  check("full level has rocks", full.rocks.length > 0, true);
  check("full level has mud", full.muds.length > 0, true);
  // 5 warehouses fully connected by direct roads would be more than 4 segments;
  // fewer means some legs of the route are open grass.
  check("full level's roads don't connect everything", full.roads.length < full.warehouses.length - 1, true);
  // Big enough that objectives fall off a phone screen (which is what the edge
  // arrows are for).
  check("full level is bigger than a phone viewport", full.width > 640 && full.height > 640, true);
}

// --- The explain -> countdown -> play -> complete cycle ---------------------

/** Runs `ticks` physics ticks of a tutorial's live play part. */
function drive(tutorial, ticks, held = false) {
  for (let i = 0; i < ticks; i++) tutorial.tick(held);
}

{
  const tutorial = new Tutorial();
  check("tutorial opens on an explanation", tutorial.phase, "explain");
  check("tutorial opens on section 1", tutorial.sectionNumber, 1);
  check("an explanation shows no count-in", tutorial.countdownLabel, null);

  // The scene is frozen while explaining: ticking does nothing at all.
  const startX = tutorial.activeTruck.pos.x;
  drive(tutorial, 60);
  check("the truck doesn't move during an explanation", tutorial.activeTruck.pos.x, startX);

  tutorial.tryItOut();
  check("'Try it out' starts the count-in", tutorial.phase, "countdown");
  check("the count-in starts at 3", tutorial.countdownLabel, "3");
  drive(tutorial, 60);
  check("the truck doesn't move during the count-in", tutorial.activeTruck.pos.x, startX);

  tutorial.advanceCountdown(COUNTDOWN_DURATION);
  check("play starts when the count-in runs out", tutorial.phase, "play");
  drive(tutorial, 60);
  check("the truck moves once play starts", tutorial.activeTruck.pos.x > startX, true);
}

{
  // Running past the limit on a timed section drops the player back on the
  // explanation, flagged with why, and puts the truck back on the start line.
  const tutorial = new Tutorial();
  tutorial.tryItOut();
  tutorial.advanceCountdown(COUNTDOWN_DURATION);
  const startX = tutorial.activeTruck.pos.x;
  drive(tutorial, Math.ceil(PLAY_TIME_LIMIT * 60) + 1, true); // held: circles instead of finishing
  check("running out of time re-explains the section", tutorial.phase, "explain");
  check("the time-up setback is flagged as such", tutorial.setback, "timeUp");
  check("a setback resets the truck to the start", tutorial.activeTruck.pos.x, startX);
  check("a setback stays on the same section", tutorial.sectionNumber, 1);

  tutorial.tryItOut();
  check("trying again clears nothing but the phase", tutorial.phase, "countdown");
  tutorial.explainAgain();
  check("'Explain again' clears the setback note", tutorial.setback, null);
}

{
  // The last section is untimed: a real map takes as long as it takes.
  const tutorial = new Tutorial();
  while (tutorial.nextSection());
  check("advancing lands on the last section", tutorial.isLastSection, true);
  check("the last section is section 6", tutorial.sectionNumber, 6);
  check("'Next section' reports there's nothing after the last", tutorial.nextSection(), false);

  tutorial.tryItOut();
  tutorial.advanceCountdown(COUNTDOWN_DURATION);
  drive(tutorial, Math.ceil(PLAY_TIME_LIMIT * 60) + 600, true);
  check("the last section has no time limit", tutorial.phase, "play");
  check("the last section shows no countdown clock", tutorial.secondsLeft, null);
}

{
  // Reaching the drop-off clears the section and offers the choice screen.
  const tutorial = new Tutorial();
  tutorial.tryItOut();
  tutorial.advanceCountdown(COUNTDOWN_DURATION);
  const dropoff = tutorial.activeLevel.warehouses.find((w) => w.kind === "destination");
  tutorial.activeTruck.pos.x = dropoff.pos.x;
  tutorial.activeTruck.pos.y = dropoff.pos.y;
  tutorial.tick(false);
  check("touching the drop-off clears the section", tutorial.phase, "complete");
  check("a cleared section shows no clock", tutorial.secondsLeft, null);
  check("'Next section' moves on from a cleared section", tutorial.nextSection(), true);
  check("moving on re-explains the next section", tutorial.phase, "explain");
  check("moving on advances the section number", tutorial.sectionNumber, 2);
}

// --- Out-of-bounds: practice ignores it, a normal run ends on it ------------

const level = buildCargoLevel();

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

{
  // The tutorial layer turns that same edge-pinning into a setback instead:
  // no game-over, just the explanation again.
  const tutorial = new Tutorial();
  tutorial.tryItOut();
  tutorial.advanceCountdown(COUNTDOWN_DURATION);
  for (let i = 0; i < 40; i++) {
    tutorial.activeTruck.pos.x = tutorial.activeLevel.width + 1000;
    tutorial.tick(false);
  }
  check("driving out of bounds re-explains the section", tutorial.phase, "explain");
  check("the out-of-bounds setback is flagged as such", tutorial.setback, "outOfBounds");
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

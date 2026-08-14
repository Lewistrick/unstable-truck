// Framework-free checks for the multi-ghost replay theater, run the same way as
// the other checks:
//   npm run build:client && node scripts/replay-check.mjs
//
// The theater plays several recordings back together with a shared timeline and
// a seekable progress bar. Seeking re-simulates each racer from the start, so it
// must land in exactly the same state as having stepped there tick by tick -
// that determinism (plus the timeline length and clamping) is what these guard.
import { ReplayTheater } from "../dist/game/replay.js";
import { generateLevel } from "../dist/level/generate.js";

const FIXED_DT = 1 / 60;

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

const level = generateLevel("2026-01-01");
const rec = (time, inputLog) => ({ seed: "2026-01-01", nickname: "x", time, stability: 100, inputLog });
const racer = (label, time, inputLog) => ({ label, color: "#f00", recording: rec(time, inputLog) });

// The timeline runs until the slowest racer finishes.
{
  const t = new ReplayTheater(level, [racer("a", 2.0, [10, 50]), racer("b", 3.0, [5, 30, 80])], "hard");
  check("totalTicks is the slowest racer's finish tick", t.totalTicks, Math.round(3.0 / FIXED_DT));
}

// Seeking to tick T lands in the same state as stepping there tick by tick.
{
  const racers = [racer("a", 3.0, [10, 40, 90, 150])];
  const stepped = new ReplayTheater(level, racers, "hard");
  for (let i = 0; i < 100; i++) stepped.step();
  const seeked = new ReplayTheater(level, racers, "hard");
  seeked.seekTo(100);

  const a = stepped.views()[0].truck.pos;
  const b = seeked.views()[0].truck.pos;
  check("stepped to tick 100", stepped.tick, 100);
  check("seeked to tick 100", seeked.tick, 100);
  check("seek matches stepping (x)", Math.abs(a.x - b.x) < 1e-9, true);
  check("seek matches stepping (y)", Math.abs(a.y - b.y) < 1e-9, true);
}

// Seeking clamps to [0, totalTicks].
{
  const t = new ReplayTheater(level, [racer("a", 1.0, [10])], "hard");
  t.seekTo(99999);
  check("seek clamps to total", t.tick, t.totalTicks);
  t.seekTo(-50);
  check("seek clamps to zero", t.tick, 0);
}

// Pressing play at the end restarts from the top (like a video player).
{
  const t = new ReplayTheater(level, [racer("a", 0.5, [5])], "hard");
  t.seekTo(t.totalTicks);
  check("atEnd after seeking to the finish", t.atEnd, true);
  t.play();
  check("play from the end restarts to 0", t.tick, 0);
  check("play from the end sets playing", t.playing, true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall replay checks passed");

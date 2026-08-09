// Framework-free checks for `?s=<seed>` deep-link resolution, run the same way
// as the other checks:
//   npm run build:client && node scripts/seed-target-check.mjs
//
// resolveSeedTarget() decides whether a shared seed lands on a live daily/weekly
// board (still browsable) or a generated "orphan" map with no leaderboard. The
// boundaries (exactly 30 days / 52 weeks, impossible dates, weekly-format
// strings) are fiddly, so these pin them down. Daily cases use a fixed "today"
// so the window edges don't drift with the wall clock; weekly cases derive
// their seeds from weekSeed() so they stay correct on any real date.
import { resolveSeedTarget, dailySeedDayOffset } from "../dist/level/seed-target.js";
import { shiftSeed, weekSeed } from "../dist/level/generate.js";

const MAX_PAST_DAYS = 30;
const MAX_PAST_WEEKS = 52;
const TODAY = new Date(2026, 7, 9); // 2026-08-09, local midnight-ish
const BASE = "2026-08-09";

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${name} - expected ${e}, got ${a}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

const daily = (seed) => resolveSeedTarget(seed, MAX_PAST_DAYS, MAX_PAST_WEEKS, TODAY);

// --- Daily seeds ---
check("today is live daily offset 0", daily(BASE), { kind: "live", mode: "daily", offset: 0 });
check("yesterday is live daily offset -1", daily(shiftSeed(BASE, -1)), { kind: "live", mode: "daily", offset: -1 });
check("30 days back is still live (boundary)", daily(shiftSeed(BASE, -30)), {
  kind: "live",
  mode: "daily",
  offset: -30,
});
check("31 days back is an expired orphan", daily(shiftSeed(BASE, -31)), { kind: "orphan", mode: "daily" });
check("a future date is an orphan", daily(shiftSeed(BASE, 1)), { kind: "orphan", mode: "daily" });
check("an impossible date is an orphan", daily("2026-02-31"), { kind: "orphan", mode: "daily" });
check("a non-standard string is a daily orphan", daily("hello"), { kind: "orphan", mode: "daily" });
check("impossible date has no day offset", dailySeedDayOffset("2026-02-31", TODAY), null);
check("real date day offset is exact", dailySeedDayOffset(shiftSeed(BASE, -12), TODAY), -12);

// --- Weekly seeds (independent of the pinned TODAY) ---
check("this week is live weekly offset 0", resolveSeedTarget(weekSeed(0), MAX_PAST_DAYS, MAX_PAST_WEEKS), {
  kind: "live",
  mode: "weekly",
  offset: 0,
});
check("3 weeks back is live weekly offset -3", resolveSeedTarget(weekSeed(-3), MAX_PAST_DAYS, MAX_PAST_WEEKS), {
  kind: "live",
  mode: "weekly",
  offset: -3,
});
check("52 weeks back is still live (boundary)", resolveSeedTarget(weekSeed(-52), MAX_PAST_DAYS, MAX_PAST_WEEKS), {
  kind: "live",
  mode: "weekly",
  offset: -52,
});
check("53 weeks back is an expired weekly orphan", resolveSeedTarget(weekSeed(-53), MAX_PAST_DAYS, MAX_PAST_WEEKS), {
  kind: "orphan",
  mode: "weekly",
});

if (failures > 0) {
  console.error(`\n${failures} seed-target check(s) failed`);
  process.exit(1);
}
console.log("\nall seed-target checks passed");

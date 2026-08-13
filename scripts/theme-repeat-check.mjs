// Framework-free checks that daily/weekly themes never repeat on consecutive
// periods, run the same way as the other checks:
//   npm run build:client && node scripts/theme-repeat-check.mjs
//
// pickTheme() picks a per-day/per-week biome. Independent per-period hashing
// used to let the same theme land on several days in a row (e.g. the Aug 10-12
// 2026 swamp streak that prompted this). resolveThemeId() now re-rolls a day
// whose raw pick equals the previous period's resolved theme, so runs are
// broken - except for holidays, which are deliberately forced (and multi-day
// holidays like Christmas snow are allowed to repeat).
import { pickTheme } from "../dist/level/themes.js";
import { shiftSeed } from "../dist/level/generate.js";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

const dailySeed = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// --- The specific regression: the Aug 10-12 2026 swamp streak is broken -----
const aug = ["2026-08-10", "2026-08-11", "2026-08-12"].map((s) => pickTheme(s).id);
check(`2026-08-10 still swamp (unchanged anchor): got ${aug[0]}`, aug[0] === "swamp");
check(`2026-08-11 no longer swamp (re-rolled): got ${aug[1]}`, aug[1] !== "swamp");
check("2026-08-10 and 2026-08-11 differ", aug[0] !== aug[1]);
check("2026-08-11 and 2026-08-12 differ", aug[1] !== aug[2]);

// --- No non-holiday consecutive daily repeat across a long span -------------
// Skip any pair touching a holiday override (matches themes.ts): the fixed-date
// holidays are matched exactly; Easter weekend is a computed multi-day window,
// so we conservatively ignore all of March/April for the repeat assertion.
const isFixedHoliday = (date) => {
  const mo = date.getMonth() + 1;
  const da = date.getDate();
  if (mo === 12 && da >= 24 && da <= 26) return true; // Christmas
  if (mo === 10 && da === 31) return true; // Halloween
  if ((mo === 12 && da === 31) || (mo === 1 && da === 1)) return true; // New Year
  return false;
};
const holidayProne = (date) => {
  const mo = date.getMonth() + 1;
  return isFixedHoliday(date) || mo === 3 || mo === 4; // Mar/Apr covers Easter
};

let dailyPairs = 0;
let dailyRepeats = 0;
const cursor = new Date(2024, 0, 1);
let prevSeed = dailySeed(cursor);
let prevTheme = pickTheme(prevSeed).id;
for (let i = 0; i < 366 * 12; i++) {
  const prevDate = new Date(cursor);
  cursor.setDate(cursor.getDate() + 1);
  const seed = dailySeed(cursor);
  const theme = pickTheme(seed).id;
  if (!holidayProne(cursor) && !holidayProne(prevDate)) {
    dailyPairs++;
    if (theme === prevTheme) {
      dailyRepeats++;
      if (dailyRepeats <= 5) console.error(`  repeat: ${prevSeed} and ${seed} both ${theme}`);
    }
  }
  prevSeed = seed;
  prevTheme = theme;
}
check(`no non-holiday daily repeats over ${dailyPairs} pairs (12 years)`, dailyRepeats === 0);

// --- No consecutive weekly repeats (holiday-free summer weeks) ---------------
// ISO weeks 22-34 fall in June-August every year, well clear of every holiday
// override, and w and w-1 are genuinely consecutive weeks that previousSeed()
// links, so this exercises the weekly path end to end.
let weeklyPairs = 0;
let weeklyRepeats = 0;
for (let y = 2024; y <= 2034; y++) {
  for (let w = 23; w <= 34; w++) {
    const seed = `${y}-W${String(w).padStart(2, "0")}`;
    const prev = `${y}-W${String(w - 1).padStart(2, "0")}`;
    weeklyPairs++;
    if (pickTheme(seed).id === pickTheme(prev).id) {
      weeklyRepeats++;
      console.error(`  weekly repeat: ${prev} and ${seed}`);
    }
  }
}
check(`no consecutive weekly repeats over ${weeklyPairs} summer pairs`, weeklyRepeats === 0);

// --- Anchors preserved: a non-colliding day keeps its original salt-0 theme --
check("2026-08-09 unchanged (city)", pickTheme("2026-08-09").id === "city");
check("shiftSeed steps one day back", shiftSeed("2026-08-11", -1) === "2026-08-10");

if (failures > 0) {
  console.error(`\n${failures} theme-repeat check(s) failed`);
  process.exit(1);
}
console.log("\nall theme-repeat checks passed");

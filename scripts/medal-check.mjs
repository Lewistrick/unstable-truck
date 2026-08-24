// Framework-free checks for medal logic, run against compiled dist/ output:
//   npm run build:client && node scripts/medal-check.mjs
//
// Covers the champion-medal rules now that the threshold is persisted: the
// threshold a run implies (championTime), and that a player earns champion iff
// their time is at or under the stored threshold - including losing it when a
// faster record lowers the threshold beneath them (the streak-strip colouring
// and the server's monotonic lowering both rely on these semantics).
import { championTime, clampParsToOptimal, medalFor } from "../dist/game/medals.js";

let failures = 0;
function check(name, actual, expected) {
  const same =
    typeof actual === "object" && actual !== null
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
  if (!same) {
    console.error(`FAIL: ${name} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// A representative level: bronze 34, silver 26, gold 20 (silver/bronze are
// gold * 1.18 / 1.45 in the real par calc, but any ordered triple works here).
const pars = { gold: 20, silver: 26, bronze: 34 };

// --- championTime: the threshold a record implies -------------------------

// (gold + 3*top)/4. With gold 20 and a 16s record: (20 + 48)/4 = 17.
check("champion threshold from a sub-gold record", championTime(20, 16), 17);

// No record, or a record no faster than gold, means no champion tier.
check("no champion threshold without a record", championTime(20, null), null);
check("no champion threshold when record ties gold", championTime(20, 20), null);

// --- medalFor with a champion threshold -----------------------------------

// At or under the threshold earns champion; the WR holder (16 <= 17) qualifies.
check("record holder earns champion", medalFor(16, pars, 17), "champion");
check("exactly on the threshold earns champion", medalFor(17, pars, 17), "champion");

// Under gold but above the champion threshold is gold, not champion.
check("fast-but-not-record run is gold", medalFor(18, pars, 17), "gold");

// The ordinary tiers still apply below gold.
check("silver tier", medalFor(24, pars, 17), "silver");
check("bronze tier", medalFor(30, pars, 17), "bronze");
check("slower than bronze earns no medal", medalFor(40, pars, 17), null);

// Without any champion threshold, a gold-beating time is just gold.
check("no champion threshold means gold caps the top", medalFor(16, pars, null), "gold");

// --- Losing the champion medal when the threshold drops -------------------

// A 17.5s run is champion while the threshold sits at 18 (an earlier, slower
// record). When a 16s record lowers the threshold to 17, that same 17.5 run is
// no longer champion - it falls back to gold. This is the "can lose the medal"
// behaviour the persisted, ratcheting-down threshold produces.
check("champion under the old, higher threshold", medalFor(17.5, pars, 18), "champion");
check("same time loses champion after the threshold drops", medalFor(17.5, pars, 17), "gold");

// --- clampParsToOptimal: keeping gold achievable --------------------------

// The geometric gold is a route-length estimate, and on some maps it lands
// below what the solver can actually drive - an unobtainable medal, which reads
// as a broken level rather than a hard one. When that happens the solver's time
// becomes the new raw gold and the other tiers are re-derived from it with the
// same multipliers computeMedalPars uses.
const tight = { gold: 10, silver: 12, bronze: 14 };

// Optimal 13.6s against a gold of 10: gold becomes ceil(13.6 + 0.5) = 15,
// silver ceil(13.6 * 1.18 + 0.5) = 17, bronze ceil(13.6 * 1.45 + 0.5) = 21.
const loosened = clampParsToOptimal(tight, 13.6);
check("impossible gold is raised to the optimal time", loosened.gold, 15);
check("silver is re-derived from the optimal", loosened.silver, 17);
check("bronze is re-derived from the optimal", loosened.bronze, 21);
check("the raised gold is actually reachable", medalFor(13.6, loosened), "gold");
// Under the original pars that same run was only worth bronze - the gold it
// was never able to reach is exactly what the clamp exists to fix.
check("the original gold was out of reach", medalFor(13.6, tight), "bronze");

// It only ever loosens. A map whose gold the solver already beats keeps the
// geometry-derived pars every player computes offline, untouched.
const achievable = { gold: 20, silver: 24, bronze: 29 };
check("an achievable gold is left alone", clampParsToOptimal(achievable, 16), achievable);
check("gold equal to the optimal is left alone", clampParsToOptimal(achievable, 20), achievable);

// A missing or nonsense optimal must never move the pars.
check("a zero optimal is ignored", clampParsToOptimal(tight, 0), tight);
check("a negative optimal is ignored", clampParsToOptimal(tight, -5), tight);
check("an infinite optimal is ignored", clampParsToOptimal(tight, Infinity), tight);
check("a NaN optimal is ignored", clampParsToOptimal(tight, NaN), tight);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall medal checks passed");

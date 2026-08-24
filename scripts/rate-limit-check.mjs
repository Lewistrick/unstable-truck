// Framework-free checks for the login rate limiter, run against compiled
// server output:
//   npm run build:server && node scripts/rate-limit-check.mjs
//
// or, without a Node toolchain on the host:
//   scripts/server-check.sh
//
// This is the thing standing between a public login endpoint and an offline
// password search, so it is worth pinning down: that the limit is enforced per
// key, that a window actually expires, that a successful login clears the
// count, and that the key table can't grow without bound.
import { RateLimiter } from "../server/dist/rate-limit.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// --- the limit itself -------------------------------------------------------

const limiter = new RateLimiter(3, 60_000);
check("1st attempt allowed", limiter.check("alice").allowed, true);
check("2nd attempt allowed", limiter.check("alice").allowed, true);
check("3rd attempt allowed", limiter.check("alice").allowed, true);
check("4th attempt blocked", limiter.check("alice").allowed, false);
check("blocked response carries a Retry-After", limiter.check("alice").retryAfterSeconds > 0, true);

// Limits are per key: one player being throttled must not throttle anyone else.
check("a different key is unaffected", limiter.check("bob").allowed, true);

// --- windows expire ---------------------------------------------------------

const shortWindow = new RateLimiter(1, 20);
check("first attempt allowed", shortWindow.check("carol").allowed, true);
check("second attempt blocked", shortWindow.check("carol").allowed, false);
await new Promise((resolve) => setTimeout(resolve, 40));
check("allowed again once the window lapses", shortWindow.check("carol").allowed, true);

// --- a successful login clears the count ------------------------------------

// Someone who mistypes their password twice and then gets it right shouldn't
// spend the rest of the window one attempt from being locked out.
const afterSuccess = new RateLimiter(3, 60_000);
afterSuccess.check("dave");
afterSuccess.check("dave");
afterSuccess.reset("dave");
check("reset clears the window", afterSuccess.check("dave").allowed, true);
check("and the full budget is back", [1, 2].every(() => afterSuccess.check("dave").allowed), true);
check("still enforced after the reset", afterSuccess.check("dave").allowed, false);

// --- the key table stays bounded --------------------------------------------

// Expired entries are dropped during an ordinary check rather than on a timer.
// Without that sweep, an attacker cycling usernames would grow the map forever.
const sweeper = new RateLimiter(1, 5);
for (let i = 0; i < 2000; i++) sweeper.check(`key-${i}`);
await new Promise((resolve) => setTimeout(resolve, 20));
// One more pass triggers the amortised sweep, which finds every window lapsed.
for (let i = 0; i < 600; i++) sweeper.check(`late-${i}`);
check("expired windows are swept", sweeper.size < 2000, true);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall rate-limit checks passed");

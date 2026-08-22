// Framework-free checks for password hashing, run against compiled server
// output:
//   npm run build:server && node scripts/password-check.mjs
//
// or, without a Node toolchain on the host:
//   scripts/server-check.sh
//
// server/password.ts imports nothing but node:crypto, which is what makes it
// runnable here at all - the rest of server/ needs express and pg.
//
// Covers the round-trip, that a stored hash carries its own cost parameters
// (so they can be raised later without invalidating existing passwords), and
// that malformed or tampered rows fail closed rather than throwing.
import { hashPassword, verifyPassword } from "../server/dist/password.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// --- round-trip -------------------------------------------------------------

const stored = await hashPassword("correct horse battery staple");
check("correct password verifies", await verifyPassword("correct horse battery staple", stored), true);
check("wrong password rejected", await verifyPassword("Correct horse battery staple", stored), false);
check("empty password rejected", await verifyPassword("", stored), false);

// Unicode and long passwords must survive the base64 round-trip intact.
const unicode = await hashPassword("wachtwoord-éèê-🚛");
check("unicode password verifies", await verifyPassword("wachtwoord-éèê-🚛", unicode), true);

// --- salting ----------------------------------------------------------------

// Two hashes of the same password must differ, or the salt isn't doing its job
// and identical passwords would be identifiable across rows.
const a = await hashPassword("same-password");
const b = await hashPassword("same-password");
check("same password hashes differently", a === b, false);
check("both still verify", (await verifyPassword("same-password", a)) && (await verifyPassword("same-password", b)), true);

// --- self-describing format -------------------------------------------------

const parts = stored.split("$");
check("six fields", parts.length, 6);
check("algorithm tag", parts[0], "scrypt");
check("N is a power of two", Number.isInteger(Math.log2(Number(parts[1]))), true);

// A hash written with different cost parameters must still verify, which is the
// whole point of storing them per-row: raising N later can't lock anyone out.
const cheap = ["scrypt", "1024", "8", "1", parts[4], parts[5]].join("$");
check("wrong parameters for the stored key reject", await verifyPassword("correct horse battery staple", cheap), false);

// --- malformed input fails closed, never throws -----------------------------

for (const [name, bad] of [
  ["empty string", ""],
  ["not our format", "$2b$10$abcdefghijklmnopqrstuv"],
  ["too few fields", "scrypt$16384$8$1$c2FsdA=="],
  ["unknown algorithm", stored.replace("scrypt", "bcrypt")],
  ["non-numeric N", stored.replace(/^scrypt\$\d+/, "scrypt$abc")],
  ["N not a power of two", stored.replace(/^scrypt\$\d+/, "scrypt$16383")],
  ["absurd N", stored.replace(/^scrypt\$\d+/, "scrypt$1073741824")],
  ["empty salt", ["scrypt", "16384", "8", "1", "", parts[5]].join("$")],
  ["empty key", ["scrypt", "16384", "8", "1", parts[4], ""].join("$")],
]) {
  let threw = false;
  let result = null;
  try {
    result = await verifyPassword("correct horse battery staple", bad);
  } catch {
    threw = true;
  }
  check(`malformed hash (${name}) returns false`, threw ? "threw" : result, false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall password checks passed");

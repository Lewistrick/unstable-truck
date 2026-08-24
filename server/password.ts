// Password hashing, using scrypt from node's own crypto module.
//
// scrypt rather than bcrypt or argon2 because both of those are native modules,
// and this project's entire dependency list is express + pg. Keeping it that way
// matters for the Docker build. scrypt is a memory-hard KDF in the same family
// and is a perfectly good choice at these parameters.
//
// This file imports nothing but node:crypto, which is what makes it the one
// piece of server/ that can be compiled and exercised without a real npm ci -
// see scripts/password-check.mjs.
import crypto from "node:crypto";

// Cost parameters. N is the work factor (memory and CPU both scale with it),
// r the block size, p the parallelisation. N=16384/r=8 needs about
// 128 * N * r = 16 MiB per hash, which is the usual interactive-login setting.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// node's default maxmem is 32 MiB, comfortably above the 16 MiB the parameters
// above need - stated explicitly so raising N later fails loudly here rather
// than mysteriously at runtime.
const MAX_MEM = 64 * 1024 * 1024;

// Bounds on parameters read back out of a stored hash. They come from our own
// database, so this is belt-and-braces: it stops a corrupted or tampered row
// from turning a login into a multi-gigabyte allocation.
const MAX_STORED_N = 1 << 20;
const MAX_STORED_R = 32;
const MAX_STORED_P = 16;

/** Always the async form. scrypt is deliberately CPU- and memory-heavy, so
 * scryptSync would block the event loop for every other request - and this
 * server already shares a small VPS with the solver precompute. */
function derive(password: string, salt: Buffer, keyLength: number, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hashes a password into a self-describing string:
 * `scrypt$N$r$p$<salt-base64>$<hash-base64>`.
 *
 * Self-describing so the cost parameters can be raised later without a
 * migration - every existing hash still carries the parameters it was made
 * with, and verifyPassword() uses those rather than today's constants. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Checks a password against a stored hash. Returns false - never throws - for
 * anything malformed, so a bad row can't 500 a login. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, rawN, rawR, rawP, saltB64, keyB64] = parts;
  if (rawN === undefined || rawR === undefined || rawP === undefined || saltB64 === undefined || keyB64 === undefined) {
    return false;
  }

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  // N must be a power of two; scrypt rejects anything else outright.
  const nIsPowerOfTwo = Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
  if (!nIsPowerOfTwo || n > MAX_STORED_N) return false;
  if (!Number.isInteger(r) || r < 1 || r > MAX_STORED_R) return false;
  if (!Number.isInteger(p) || p < 1 || p > MAX_STORED_P) return false;

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await derive(password, salt, expected.length, n, r, p);
  } catch {
    return false;
  }
  // Lengths match by construction (expected.length was the requested key
  // length), but timingSafeEqual throws on a mismatch, so check anyway.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

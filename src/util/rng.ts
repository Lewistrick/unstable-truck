/** Deterministic PRNG (Mulberry32) returning floats in [0, 1). */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hashes a string (e.g. "2026-08-03") into a 32-bit seed for mulberry32. */
export function seedFromString(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export const randRange = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);
export const randInt = (rng: Rng, min: number, max: number): number =>
  Math.floor(randRange(rng, min, max + 1));

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick() called on empty array");
  return item;
}

/** Fisher-Yates shuffle using a seeded rng, returns a new array. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const ai = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = ai;
  }
  return arr;
}

/**
 * Smooth 2D value noise seeded from an rng. Returns a function mapping
 * (x, y) -> [-1, 1] with continuous, smoothly-interpolated output, used for
 * distributing hubs/obstacles across the map without hard boundaries.
 */
export function makeValueNoise2D(rng: Rng): (x: number, y: number) => number {
  const gridSize = 256;
  const mask = gridSize - 1;
  const lattice = new Float32Array(gridSize * gridSize);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng() * 2 - 1;

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const at = (xi: number, yi: number) => lattice[((yi & mask) * gridSize) + (xi & mask)]!;

  return (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = fade(x - x0);
    const ty = fade(y - y0);
    const v00 = at(x0, y0);
    const v10 = at(x0 + 1, y0);
    const v01 = at(x0, y0 + 1);
    const v11 = at(x0 + 1, y0 + 1);
    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return top + (bottom - top) * ty;
  };
}

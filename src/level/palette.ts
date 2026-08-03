import { type Rng, randInt, randRange } from "../util/rng.js";
import type { Palette } from "./types.js";

const hsl = (h: number, s: number, l: number, a = 1): string =>
  a === 1 ? `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)` : `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a})`;

/** Daily palette: one seeded hue offset drives the grass/road tint, while
 * warehouse colors (base/pickup/destination) stay fixed so their meaning is
 * always readable. */
export function generatePalette(rng: Rng): Palette {
  const hueOffset = randInt(rng, 0, 360);
  // Spans yellow-green through teal-green (70-165deg) so every day reads as
  // "grass" while still landing somewhere clearly different on the wheel.
  const grassHue = (70 + hueOffset * (95 / 360)) % 360;
  const grassSat = randRange(rng, 18, 42);
  const grassLight = randRange(rng, 72, 88);
  const roadWarm = hueOffset < 180;
  const roadHue = roadWarm ? randRange(rng, 12, 42) : randRange(rng, 195, 225);
  const roadSat = randRange(rng, 8, 20);
  const roadLight = randRange(rng, 36, 48);

  return {
    hueOffset,
    grass: hsl(grassHue, grassSat, grassLight),
    grassAlt: hsl(grassHue, grassSat, grassLight - 6),
    road: hsl(roadHue, roadSat, roadLight),
    roadLine: "rgba(255, 255, 255, 0.55)",
    warehouseBase: hsl(212, 70, 45),
    warehousePickup: hsl(2, 72, 50),
    warehouseDestination: hsl(140, 55, 38),
    rock: hsl(25, 14, 30),
    mud: hsl(30, 45, 27),
    rough: hsl(38, 32, 52),
  };
}

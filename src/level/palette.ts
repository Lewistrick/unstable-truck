import { type Rng, randInt, randRange } from "../util/rng.js";
import type { Palette } from "./types.js";

const hsl = (h: number, s: number, l: number, a = 1): string =>
  a === 1 ? `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)` : `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a})`;

/** Daily palette: one seeded hue offset drives grass/road tint and the
 * decorative-warehouse color cycle, while gameplay-critical warehouse colors
 * (base/pickup/destination) stay fixed so their meaning is always readable. */
export function generatePalette(rng: Rng): Palette {
  const hueOffset = randInt(rng, 0, 360);
  const grassHue = (100 + hueOffset * 0.15) % 360;
  const roadWarm = hueOffset < 180;
  const roadHue = roadWarm ? 30 : 210;

  return {
    hueOffset,
    grass: hsl(grassHue, randRange(rng, 26, 38), randRange(rng, 78, 85)),
    grassAlt: hsl(grassHue, randRange(rng, 26, 38), randRange(rng, 72, 78)),
    road: hsl(roadHue, 10, 43),
    roadLine: "rgba(255, 255, 255, 0.55)",
    warehouseBase: hsl(212, 70, 45),
    warehousePickup: hsl(2, 72, 50),
    warehouseDestination: hsl(140, 55, 38),
    warehouseDecorative: hsl(hueOffset, 50, 55),
    rock: hsl(25, 14, 30),
    mud: hsl(30, 45, 27),
    rough: hsl(38, 32, 52),
  };
}

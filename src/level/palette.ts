import { type Rng, randInt, randRange } from "../util/rng.js";
import type { Palette } from "./types.js";

const hsl = (h: number, s: number, l: number, a = 1): string =>
  a === 1 ? `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)` : `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a})`;

/** Daily palette: grass, road, rock, and mud each get an independently
 * seeded hue, so a day's theme can land anywhere on the color wheel (grass
 * might be blue or pink, not just green) while still respecting their
 * material's brightness: grass always stays light/pastel, road/rock/mud
 * always stay dark with just a clearly visible tint. Independent hues (
 * rather than one shared tint) keep obstacles reading as distinct from the
 * road even when the same day's palette leans toward one part of the wheel.
 * Warehouse colors stay fixed so their gameplay meaning is always readable. */
export function generatePalette(rng: Rng): Palette {
  const grassHue = randInt(rng, 0, 360);
  const grassSat = randRange(rng, 15, 40);
  const grassLight = randRange(rng, 75, 90);

  const roadHue = randInt(rng, 0, 360);
  const roadSat = randRange(rng, 12, 28);
  const roadLight = randRange(rng, 28, 42);

  const rockHue = randInt(rng, 0, 360);
  const rockSat = randRange(rng, 12, 28);
  const rockLight = randRange(rng, 22, 32);

  const mudHue = randInt(rng, 0, 360);
  const mudSat = randRange(rng, 20, 42);
  const mudLight = randRange(rng, 24, 34);

  const roughHue = (rockHue + 15) % 360;
  const roughSat = randRange(rng, 15, 30);
  const roughLight = randRange(rng, 45, 58);

  return {
    grass: hsl(grassHue, grassSat, grassLight),
    grassAlt: hsl(grassHue, grassSat, grassLight - 6),
    road: hsl(roadHue, roadSat, roadLight),
    roadLine: "rgba(255, 255, 255, 0.55)",
    warehouseBase: hsl(212, 70, 45),
    warehousePickup: hsl(2, 72, 50),
    warehouseDestination: hsl(140, 55, 38),
    rock: hsl(rockHue, rockSat, rockLight),
    mud: hsl(mudHue, mudSat, mudLight),
    rough: hsl(roughHue, roughSat, roughLight),
  };
}

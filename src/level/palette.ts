import { type Rng, randRange } from "../util/rng.js";
import type { HslRange, Theme } from "./themes.js";
import type { Palette } from "./types.js";

const hsl = (h: number, s: number, l: number, a = 1): string =>
  a === 1 ? `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)` : `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a})`;

/** Samples one HSL channel triple from a theme's range. Hue ranges may wrap
 * past 360 (min > max), so the hue is taken modulo 360. */
function sample(rng: Rng, range: HslRange): { h: number; s: number; l: number } {
  const [hMin, hMax] = range.h;
  const h = randRange(rng, hMin, hMax < hMin ? hMax + 360 : hMax) % 360;
  return { h, s: randRange(rng, range.s[0], range.s[1]), l: randRange(rng, range.l[0], range.l[1]) };
}

/** Daily/weekly palette, biased by the level's theme. Each material (grass,
 * road, rock, mud, house) samples an independent color within the theme's
 * range, so every day within a biome still looks unique while reading as that
 * biome. Warehouse colors stay fixed so their gameplay meaning is always
 * readable. Sampled last in level generation, so tweaking this never shifts
 * hub/road/warehouse/obstacle placement. */
export function generatePalette(rng: Rng, theme: Theme): Palette {
  const grass = sample(rng, theme.ground);
  const road = sample(rng, theme.road);
  const rock = sample(rng, theme.rock);
  const mud = sample(rng, theme.mud);
  const house = sample(rng, theme.house);

  return {
    grass: hsl(grass.h, grass.s, grass.l),
    grassAlt: hsl(grass.h, grass.s, Math.max(0, grass.l - 6)),
    road: hsl(road.h, road.s, road.l),
    roadLine: "rgba(255, 255, 255, 0.55)",
    warehouseBase: hsl(212, 70, 45),
    warehousePickup: hsl(2, 72, 50),
    warehouseDestination: hsl(140, 55, 38),
    rock: hsl(rock.h, rock.s, rock.l),
    mud: hsl(mud.h, mud.s, mud.l),
    house: hsl(house.h, house.s, house.l),
  };
}

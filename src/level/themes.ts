import { seedFromString } from "../util/rng.js";

// A biome/theme gives each day a recognisable identity. It biases the seeded
// palette (so a desert day reads as sandy, a snow day as white) while still
// leaving room for per-day variation within each range, and picks a ground
// texture. Later phases add scattered, no-hitbox scenery props per theme.

export type TextureStyle = "mottle" | "dunes" | "rows" | "grid" | "speckle" | "craters" | "dots";

export type ThemeId =
  | "grassland"
  | "desert"
  | "town"
  | "city"
  | "moon"
  | "snow"
  | "beach"
  | "forest"
  | "farmland"
  | "autumn"
  | "savanna"
  | "volcanic"
  | "swamp"
  | "candy";

/** A range for one HSL channel; the palette samples uniformly within it. Hue
 * ranges may wrap past 360 (min > max) - the palette normalises that. */
export type Band = [min: number, max: number];

export interface HslRange {
  h: Band;
  s: Band;
  l: Band;
}

export interface Theme {
  id: ThemeId;
  /** Human-readable name, shown as a teaser on the home screen. */
  name: string;
  texture: TextureStyle;
  /** Ground (grass) color range - the theme's dominant identity. */
  ground: HslRange;
  road: HslRange;
  rock: HslRange;
  mud: HslRange;
  house: HslRange;
}

const band = (h: Band, s: Band, l: Band): HslRange => ({ h, s, l });

// Insertion order here is also the pool order pickTheme() indexes into.
export const THEMES: Record<ThemeId, Theme> = {
  grassland: {
    id: "grassland",
    name: "Grassland",
    texture: "mottle",
    ground: band([95, 135], [28, 45], [70, 84]),
    road: band([95, 135], [8, 16], [30, 40]),
    rock: band([95, 135], [10, 18], [24, 32]),
    mud: band([28, 42], [32, 46], [26, 34]),
    house: band([18, 38], [26, 40], [52, 64]),
  },
  desert: {
    id: "desert",
    name: "Desert",
    texture: "dunes",
    ground: band([36, 50], [38, 58], [74, 85]),
    road: band([35, 50], [14, 24], [42, 52]),
    rock: band([10, 26], [30, 48], [38, 48]),
    mud: band([28, 40], [34, 50], [34, 44]),
    house: band([30, 44], [28, 44], [58, 70]),
  },
  town: {
    id: "town",
    name: "Town",
    texture: "mottle",
    ground: band([95, 140], [12, 22], [66, 78]),
    road: band([210, 230], [6, 12], [34, 44]),
    rock: band([210, 230], [6, 12], [26, 34]),
    mud: band([28, 42], [24, 38], [30, 40]),
    house: band([8, 30], [24, 40], [50, 64]),
  },
  city: {
    id: "city",
    name: "City",
    texture: "grid",
    ground: band([210, 235], [5, 12], [56, 68]),
    road: band([220, 240], [4, 10], [26, 34]),
    rock: band([220, 240], [5, 12], [22, 30]),
    mud: band([30, 45], [18, 30], [30, 40]),
    house: band([205, 235], [10, 20], [46, 60]),
  },
  moon: {
    id: "moon",
    name: "Moon",
    texture: "craters",
    ground: band([220, 240], [2, 7], [54, 66]),
    road: band([220, 240], [2, 6], [24, 32]),
    rock: band([220, 240], [2, 8], [30, 40]),
    mud: band([220, 240], [2, 6], [34, 44]),
    house: band([220, 240], [3, 8], [48, 60]),
  },
  snow: {
    id: "snow",
    name: "Snow",
    texture: "speckle",
    ground: band([200, 220], [8, 18], [88, 95]),
    road: band([210, 230], [8, 16], [30, 40]),
    rock: band([205, 225], [8, 16], [52, 64]),
    mud: band([205, 225], [10, 20], [62, 74]),
    house: band([205, 225], [10, 20], [70, 82]),
  },
  beach: {
    id: "beach",
    name: "Beach",
    texture: "dunes",
    ground: band([42, 54], [42, 60], [78, 88]),
    road: band([40, 52], [18, 30], [46, 56]),
    rock: band([30, 46], [24, 40], [50, 62]),
    mud: band([38, 50], [30, 46], [40, 50]),
    house: band([30, 46], [30, 46], [60, 72]),
  },
  forest: {
    id: "forest",
    name: "Forest",
    texture: "mottle",
    ground: band([100, 140], [30, 50], [52, 64]),
    road: band([100, 140], [10, 20], [28, 38]),
    rock: band([100, 140], [10, 18], [22, 30]),
    mud: band([28, 44], [34, 50], [24, 32]),
    house: band([18, 38], [28, 44], [46, 58]),
  },
  farmland: {
    id: "farmland",
    name: "Farmland",
    texture: "rows",
    ground: band([70, 100], [32, 48], [62, 74]),
    road: band([70, 100], [10, 18], [32, 42]),
    rock: band([70, 100], [10, 18], [24, 32]),
    mud: band([28, 42], [36, 52], [28, 36]),
    house: band([8, 28], [30, 46], [50, 62]),
  },
  autumn: {
    id: "autumn",
    name: "Autumn",
    texture: "dots",
    ground: band([24, 42], [46, 66], [60, 72]),
    road: band([24, 42], [18, 30], [34, 44]),
    rock: band([18, 34], [26, 42], [34, 44]),
    mud: band([20, 36], [36, 52], [28, 36]),
    house: band([10, 30], [34, 50], [48, 60]),
  },
  savanna: {
    id: "savanna",
    name: "Savanna",
    texture: "rows",
    ground: band([44, 60], [38, 54], [66, 78]),
    road: band([40, 56], [16, 26], [40, 50]),
    rock: band([28, 44], [26, 42], [40, 50]),
    mud: band([30, 44], [34, 50], [34, 44]),
    house: band([28, 44], [30, 46], [52, 64]),
  },
  volcanic: {
    id: "volcanic",
    name: "Volcanic",
    texture: "craters",
    ground: band([10, 26], [34, 52], [42, 54]),
    road: band([10, 26], [10, 20], [18, 26]),
    rock: band([10, 26], [14, 26], [22, 30]),
    mud: band([0, 16], [50, 68], [36, 46]),
    house: band([10, 26], [16, 28], [40, 52]),
  },
  swamp: {
    id: "swamp",
    name: "Swamp",
    texture: "mottle",
    ground: band([74, 104], [24, 40], [46, 58]),
    road: band([74, 104], [10, 20], [26, 36]),
    rock: band([74, 104], [10, 18], [22, 30]),
    mud: band([60, 90], [30, 46], [26, 34]),
    house: band([40, 70], [20, 34], [42, 54]),
  },
  candy: {
    id: "candy",
    name: "Candyland",
    texture: "dots",
    ground: band([300, 346], [36, 54], [84, 90]),
    road: band([280, 320], [16, 28], [40, 50]),
    rock: band([190, 240], [24, 40], [56, 68]),
    mud: band([330, 366], [36, 52], [64, 74]),
    house: band([320, 350], [40, 56], [66, 78]),
  },
};

/** Certain calendar dates always get a fitting theme (seeds are dates, so this
 * is a cheap seasonal easter egg). Keyed by the MM-DD part of a daily seed. */
const DATE_OVERRIDES: Record<string, ThemeId> = {
  "12-24": "snow",
  "12-25": "snow",
  "12-26": "snow",
  "10-31": "autumn",
};

function dateOverride(seed: string): ThemeId | null {
  const match = seed.match(/^\d{4}-(\d{2}-\d{2})$/);
  if (!match) return null; // weekly seeds (YYYY-Www) never override
  return DATE_OVERRIDES[match[1]!] ?? null;
}

export function getTheme(id: ThemeId): Theme {
  return THEMES[id];
}

/** Deterministic theme for a seed. Uses a hash independent of the main level
 * rng stream so adding themes never shifts hub/road/warehouse/obstacle
 * generation - only the palette and texture change for existing seeds. */
export function pickTheme(seed: string): Theme {
  const override = dateOverride(seed);
  if (override) return THEMES[override];
  const ids = Object.keys(THEMES) as ThemeId[];
  const idx = seedFromString(`${seed}#theme`) % ids.length;
  return THEMES[ids[idx]!]!;
}

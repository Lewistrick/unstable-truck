// Renders a 600x400 screenshot of every biome to images/, for eyeballing the
// scenery/palette/textures without launching the game.
//
// Requires the frontend to be built (npm run build:client) and a headless
// canvas backend:  npm i -D @napi-rs/canvas
// Run all biomes:   node scripts/screenshots.mjs
// Run one biome:    node scripts/screenshots.mjs autumn
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

// render.ts builds its texture tiles via document.createElement("canvas");
// shim that to the headless backend before importing the render module.
globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`unsupported element: ${tag}`);
  },
};

const { generateLevel } = await import("../dist/level/generate.js");
const { THEMES, getTheme } = await import("../dist/level/themes.js");
const { generatePalette } = await import("../dist/level/palette.js");
const { generateScenery } = await import("../dist/level/scenery.js");
const { mulberry32, seedFromString } = await import("../dist/util/rng.js");
const { GameSession } = await import("../dist/game/session.js");
const { renderWorld } = await import("../dist/game/render.js");

const WIDTH = 800;
const HEIGHT = 600;
const SEED = "2026-08-09"; // any seed; road/warehouse geometry is shared

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "images");
mkdirSync(outDir, { recursive: true });

// Optional single-biome argument; otherwise render them all.
const only = process.argv[2];
if (only && !THEMES[only]) {
  console.error(`unknown biome "${only}". Valid: ${Object.keys(THEMES).join(", ")}`);
  process.exit(1);
}
const ids = only ? [only] : Object.keys(THEMES);

// One base level supplies the geometry; each biome just re-skins the palette and
// re-scatters its own props on top, so every screenshot shows the same map.
const base = generateLevel(SEED);

for (const id of ids) {
  const theme = getTheme(id);
  const palette = generatePalette(mulberry32(seedFromString(`${SEED}#pal`)), theme);
  const scenery = generateScenery(SEED, theme, base.width, base.height, base.roads, base.warehouses, base.houses, base.rocks, base.muds);
  const level = { ...base, theme: id, palette, scenery };

  const session = new GameSession(level);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const camera = { x: session.truck.pos.x, y: session.truck.pos.y };
  renderWorld(ctx, level, session.truck, session.cargoBoxes, session.visited, [], camera, WIDTH, HEIGHT);

  await writeFile(join(outDir, `${id}.png`), await canvas.encode("png"));
  console.log(`images/${id}.png  -  ${theme.name} (${scenery.length} props)`);
}

console.log("done");

// Renders n instances of a prop type t drawn with algorithm k, side by side in
// one image, for comparing sprite-drawing algorithms.
//
// Requires:  npm run build:client  and  npm i -D @napi-rs/canvas
// Usage:     node scripts/prop-variants.mjs <k> <type> <n>
// Example:   node scripts/prop-variants.mjs 2 palm 5
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const k = Number(process.argv[2] ?? 1);
const type = process.argv[3] ?? "palm";
const n = Number(process.argv[4] ?? 5);

const { PALM_VARIANTS } = await import("../dist/game/palm-variants.js");
const { mulberry32 } = await import("../dist/util/rng.js");

// Only palms have algorithm variants so far.
const registry = { palm: PALM_VARIANTS };
const variants = registry[type];
if (!variants) {
  console.error(`no algorithm variants for type "${type}" (have: ${Object.keys(registry).join(", ")})`);
  process.exit(1);
}
const draw = variants[k];
if (!draw) {
  console.error(`no algorithm ${k} for "${type}" (have: ${Object.keys(variants).join(", ")})`);
  process.exit(1);
}

const CELL_W = 200;
const HEIGHT = 340;
const SCALE = 7;
const GROUND_Y = HEIGHT - 34;
const WIDTH = CELL_W * n;

const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#efe6cf"; // sand
ctx.fillRect(0, 0, WIDTH, HEIGHT);
ctx.fillStyle = "#5a5140";
ctx.font = "bold 18px sans-serif";
ctx.textAlign = "left";
ctx.fillText(`${type} - algorithm ${k}  (n=${n})`, 12, 26);

for (let i = 0; i < n; i++) {
  const cx = CELL_W * i + CELL_W / 2;
  ctx.save();
  ctx.translate(cx, GROUND_Y - 9 * SCALE); // local base (y=9) lands on GROUND_Y
  ctx.scale(SCALE, SCALE);
  const rng = mulberry32(1000 + i * 97 + k * 13);
  ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
  ctx.beginPath();
  ctx.ellipse(0, 9, 8, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
  draw(ctx, rng);
  ctx.restore();
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "images");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${type}-algo${k}.png`);
await writeFile(file, await canvas.encode("png"));
console.log(`images/${type}-algo${k}.png`);

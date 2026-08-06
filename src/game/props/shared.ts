import { randInt, randRange, type Rng } from "../../util/rng.js";

// Shared helpers and palettes for the code-authored scenery sprites. Each prop
// lives in its own file under this folder and is drawn in local space with its
// base near y = 9 (the ground/shadow line), growing upward.

/** Signature every prop drawer implements. `variant` is a small stable integer
 * (0-3) for props that pick a look from a fixed set; `rng` is a deterministic
 * per-instance stream for props with internal randomness. Most props use one or
 * the other, so the unused parameter is prefixed with `_`. */
export type PropDrawer = (ctx: CanvasRenderingContext2D, variant: number, rng: Rng) => void;

export const TAU = Math.PI * 2;

/** Rounded-rect path helper (fill/stroke is the caller's job). */
export function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Filled triangle with apex at (cx, apexY) and a base `height` below it. */
export function triangle(ctx: CanvasRenderingContext2D, cx: number, apexY: number, halfW: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, apexY);
  ctx.lineTo(cx - halfW, apexY + height);
  ctx.lineTo(cx + halfW, apexY + height);
  ctx.closePath();
  ctx.fill();
}

/** Recursive fractal branch drawn as a tapered rectangle (broad base, thinner
 * top). Children start in the top 25% of their parent and veer 20-50 degrees to
 * either side; each is 0.9x the length and 0.5x the width of its parent, down to
 * `maxDepth`. The trunk (depth 0) forks 2-5 ways, deeper levels 0-3. Shared by
 * the bare and charred trees - only the fill color differs between those biomes. */
export function drawTreeBranch(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  depth: number,
  maxDepth: number,
): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ex = x + dx * length;
  const ey = y + dy * length;
  const baseHalf = Math.max(0.4, width) / 2;
  const topHalf = Math.max(0.3, width * 0.5) / 2;
  const nx = -dy; // unit normal to the branch
  const ny = dx;
  ctx.beginPath();
  ctx.moveTo(x + nx * baseHalf, y + ny * baseHalf);
  ctx.lineTo(ex + nx * topHalf, ey + ny * topHalf);
  ctx.lineTo(ex - nx * topHalf, ey - ny * topHalf);
  ctx.lineTo(x - nx * baseHalf, y - ny * baseHalf);
  ctx.closePath();
  ctx.fill();
  // Round the joint so angled children connect smoothly.
  ctx.beginPath();
  ctx.arc(x, y, baseHalf, 0, TAU);
  ctx.fill();

  if (depth >= maxDepth) return;
  const children = depth === 0 ? randInt(rng, 2, 5) : randInt(rng, 0, 3);
  for (let i = 0; i < children; i++) {
    const t = randRange(rng, 0.75, 1); // start in the top 25% of this branch
    const sx = x + dx * length * t;
    const sy = y + dy * length * t;
    const deviation = (randRange(rng, 15, 40) * Math.PI) / 180; // 20-50 deg, either side
    const childAngle = angle + (rng() < 0.5 ? -deviation : deviation);
    drawTreeBranch(ctx, rng, sx, sy, childAngle, length * 0.85, width * 0.65, depth + 1, maxDepth);
  }
}

/** Conifer body shared by the plain pine and the snow-dusted variant: a stack
 * of 2-5 triangular tiers, widest at the bottom and tapering to the top. When
 * `snow` is set, each tier gets a small white cap at its peak. */
export function conifer(ctx: CanvasRenderingContext2D, rng: Rng, snow: boolean): void {
  // Trunk starts above the foliage base (y = 3) so it connects, not floats.
  ctx.fillStyle = "#6b4a2f";
  ctx.fillRect(-1.5, 2, 3, 7);

  const tiers = randInt(rng, 2, 5);
  const maxHalf = 8; // bottom tier half-width
  const widthStep = 1.4; // each tier up narrows by this much
  const tierHeight = 7;
  const apexSpacing = 4.5; // vertical rise between successive tier apexes
  // The bottom tier's base sits at y = 3 (apex at 3 - tierHeight), so taller
  // trees grow upward from a fixed, trunk-connected base.
  const tierY = (i: number) => 3 - tierHeight - i * apexSpacing;
  const tierHalf = (i: number) => maxHalf - i * widthStep;

  // Green body first (largest tier at the bottom, up to the smallest on top)...
  ctx.fillStyle = snow ? "#2f6d43" : "#2e6b3f";
  for (let i = 0; i < tiers; i++) triangle(ctx, 0, tierY(i), tierHalf(i), tierHeight);
  // ...then the snow caps on top so they stay visible over the foliage.
  if (snow) {
    ctx.fillStyle = "#eef4f7";
    for (let i = 0; i < tiers; i++) triangle(ctx, 0, tierY(i), tierHalf(i) * 0.56, 3);
  }
}

export const SHRUB_FLOWERS = ["#e85d75", "#f2c14e", "#6fb1e0", "#f4f1ea"];
export const MUSHROOM_CAPS = ["#d64545", "#e0873c", "#b0553a", "#c94f8a"];
export const CAR_COLORS = ["#c0392b", "#2980b9", "#f1c40f", "#7f8c8d"];
export const TRACTOR_COLORS = ["#c0433a", "#2f6bb0", "#3f9e57"]; // red, blue, green
export const CANDY_COLORS = ["#e8503a", "#f2c14e", "#6fb1e0", "#e88bb0"];
export const GUMDROP_COLORS = ["#e8503a", "#f2c14e", "#8fd18f", "#6fb1e0", "#e88bb0", "#b07de0"];
export const BEACHBALL_COLORS = ["#e8503a", "#f2c14e", "#3f9e57", "#6fb1e0", "#e88bb0", "#f4f1ea"];
export const AUTUMN_LEAF_COLORS = ["#8a4b2a", "#b5451f", "#d8722a", "#d9a72b"]; // brown/red/orange/yellow
export const EGG_COLORS = ["#e88bb0", "#6fb1e0", "#f2c14e", "#8fd18f"];
export const FESTIVE_COLORS = ["#f2c14e", "#e8503a", "#6fb1e0", "#8fd18f"];

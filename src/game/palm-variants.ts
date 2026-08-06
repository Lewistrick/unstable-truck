import { randInt, randRange, type Rng } from "../util/rng.js";

// Three palm-tree drawing algorithms, kept side by side so they can be compared
// (see scripts/prop-variants.mjs). Each draws a palm in local space with its
// base at y = 9 (the ground/shadow line), growing upward. The game currently
// uses drawPalmV1; swap the palm case in render.ts to try another.

const TAU = Math.PI * 2;
type Pt = [number, number];

// --- shared pieces ---------------------------------------------------------

function palmTrunk(ctx: CanvasRenderingContext2D, rng: Rng): { topX: number; topY: number } {
  ctx.lineCap = "round";
  const lean = randRange(rng, -3.5, 3.5);
  const topX = lean;
  const topY = -randRange(rng, 6, 10);
  ctx.strokeStyle = "#8a6a44";
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.quadraticCurveTo(lean * 0.4 + randRange(rng, -2, 2), 2, topX, topY);
  ctx.stroke();
  return { topX, topY };
}

function underCrown(ctx: CanvasRenderingContext2D, topX: number, topY: number, rx: number, ry: number): void {
  ctx.fillStyle = "rgba(28, 78, 44, 0.55)";
  ctx.beginPath();
  ctx.ellipse(topX, topY - 1, rx, ry, 0, 0, TAU);
  ctx.fill();
}

function palmCoconuts(ctx: CanvasRenderingContext2D, rng: Rng, topX: number, topY: number): void {
  ctx.fillStyle = "#5a3a24";
  const count = randInt(rng, 1, 3);
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.arc(topX + randRange(rng, -2, 2), topY + randRange(rng, 0.5, 2.5), 1.3, 0, TAU);
    ctx.fill();
  }
}

// --- Algorithm 1: arched rachis with swept pinnate leaflets -----------------

/** Frond as an arched rachis (rises up-and-out, then droops), with pinnate
 * leaflets on both sides at each station, swept toward the tip and tapering. */
function drawFrondArched(ctx: CanvasRenderingContext2D, rng: Rng, x: number, y: number, baseAngle: number, length: number): void {
  const ox = Math.cos(baseAngle);
  const oy = Math.sin(baseAngle);
  const droop = randRange(rng, 0.2, 0.4) + 0.3 * Math.abs(ox);
  const ctrlX = x + ox * length * 0.55;
  const ctrlY = y + oy * length * 0.55 - length * 0.28;
  const tipX = x + ox * length * 0.95;
  const tipY = y + oy * length * 0.95 + droop * length;

  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
  ctx.stroke();

  ctx.lineWidth = 0.6;
  const stations = randInt(rng, 6, 10);
  const sweep = 0.6;
  for (let j = 1; j <= stations; j++) {
    const t = j / (stations + 1);
    const mt = 1 - t;
    const px = mt * mt * x + 2 * mt * t * ctrlX + t * t * tipX;
    const py = mt * mt * y + 2 * mt * t * ctrlY + t * t * tipY;
    let tx = 2 * mt * (ctrlX - x) + 2 * t * (tipX - ctrlX);
    let ty = 2 * mt * (ctrlY - y) + 2 * t * (tipY - ctrlY);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    const llen = 1.2 + 3.2 * Math.sin(Math.PI * t);
    for (const side of [-1, 1]) {
      const lvx = (nx * side * Math.cos(sweep) + tx * Math.sin(sweep)) * llen;
      const lvy = (ny * side * Math.cos(sweep) + ty * Math.sin(sweep)) * llen;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + lvx * 0.5 + tx * llen * 0.15, py + lvy * 0.5 + ty * llen * 0.15, px + lvx, py + lvy);
      ctx.stroke();
    }
  }
}

export function drawPalmV1(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const { topX, topY } = palmTrunk(ctx, rng);
  underCrown(ctx, topX, topY, 5, 3.5);
  ctx.strokeStyle = "#3f9e57";
  const fronds = randInt(rng, 5, 8);
  const spread = 1.15;
  for (let i = 0; i < fronds; i++) {
    const base = -Math.PI / 2 + (i / (fronds - 1) - 0.5) * 2 * spread;
    drawFrondArched(ctx, rng, topX, topY, base + randRange(rng, -0.22, 0.22), randRange(rng, 9, 13));
  }
  palmCoconuts(ctx, rng, topX, topY);
}

// --- Algorithm 2: filled blade crown (silhouette) ---------------------------

/** Frond as a filled, tapered leaf blade with a serrated (leaflet) edge along
 * an arched midrib, so the crown reads as a full silhouette rather than hairline
 * strokes. */
function drawBlade(ctx: CanvasRenderingContext2D, rng: Rng, x: number, y: number, baseAngle: number, length: number, fill: string): void {
  const ox = Math.cos(baseAngle);
  const oy = Math.sin(baseAngle);
  const droop = randRange(rng, 0.2, 0.4) + 0.3 * Math.abs(ox);
  const ctrlX = x + ox * length * 0.55;
  const ctrlY = y + oy * length * 0.55 - length * 0.28;
  const tipX = x + ox * length * 0.95;
  const tipY = y + oy * length * 0.95 + droop * length;

  const q = (a: number, b: number, c: number, t: number): number => {
    const mt = 1 - t;
    return mt * mt * a + 2 * mt * t * b + t * t * c;
  };
  const K = 10;
  const w0 = length * 0.16;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let j = 0; j <= K; j++) {
    const t = j / K;
    const px = q(x, ctrlX, tipX, t);
    const py = q(y, ctrlY, tipY, t);
    let tx = 2 * (1 - t) * (ctrlX - x) + 2 * t * (tipX - ctrlX);
    let ty = 2 * (1 - t) * (ctrlY - y) + 2 * t * (tipY - ctrlY);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const serr = 0.78 + 0.22 * (j % 2); // jagged leaflet edge
    const hw = w0 * Math.sin(Math.PI * Math.min(1, t * 1.03)) * serr;
    left.push([px - ty * hw, py + tx * hw]);
    right.push([px + ty * hw, py - tx * hw]);
  }

  ctx.beginPath();
  ctx.moveTo(x, y);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  ctx.lineTo(tipX, tipY);
  for (let j = right.length - 1; j >= 0; j--) {
    const p = right[j]!;
    ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.strokeStyle = "rgba(20, 60, 35, 0.5)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
  ctx.stroke();
}

export function drawPalmV2(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const { topX, topY } = palmTrunk(ctx, rng);
  underCrown(ctx, topX, topY, 7, 5);
  const fronds = randInt(rng, 6, 9);
  const spread = 1.2;
  // Back layer (darker, drawn first) then front layer (lighter) for depth.
  for (const [layerFill, layerLen] of [["#2f7d47", 12] as const, ["#48a95e", 10] as const]) {
    for (let i = 0; i < fronds; i++) {
      const base = -Math.PI / 2 + (i / (fronds - 1) - 0.5) * 2 * spread;
      drawBlade(ctx, rng, topX, topY, base + randRange(rng, -0.2, 0.2), layerLen + randRange(rng, -1.5, 1.5), layerFill);
    }
  }
  palmCoconuts(ctx, rng, topX, topY);
}

// --- Algorithm 3: gravity-sampled strand fronds with shared wind ------------

/** Frond as a strand integrated step by step: each step bends the heading down
 * (cumulative gravity) plus a shared wind, then emits swept, tapering leaflets -
 * so the arcs are organic and the whole crown agrees on a wind direction. */
function drawStrandFrond(ctx: CanvasRenderingContext2D, rng: Rng, x: number, y: number, baseAngle: number, length: number, wind: number): void {
  let dx = Math.cos(baseAngle);
  let dy = Math.sin(baseAngle);
  let px = x;
  let py = y;
  const steps = 9;
  const seg = length / steps;
  const gravity = 0.11;
  const pts: Pt[] = [[px, py]];
  for (let s = 1; s <= steps; s++) {
    dy += gravity;
    dx += wind;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    px += dx * seg;
    py += dy * seg;
    pts.push([px, py]);
  }

  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.stroke();

  ctx.lineWidth = 0.6;
  const sweep = 0.6;
  for (let i = 1; i < pts.length - 1; i++) {
    const t = i / (pts.length - 1);
    const cur = pts[i]!;
    const prev = pts[i - 1]!;
    const next = pts[i + 1]!;
    let ax = next[0] - prev[0];
    let ay = next[1] - prev[1];
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    const nx = -ay;
    const ny = ax;
    const llen = 1.2 + 3.0 * Math.sin(Math.PI * t);
    for (const side of [-1, 1]) {
      const lvx = (nx * side * Math.cos(sweep) + ax * Math.sin(sweep)) * llen;
      const lvy = (ny * side * Math.cos(sweep) + ay * Math.sin(sweep)) * llen;
      ctx.beginPath();
      ctx.moveTo(cur[0], cur[1]);
      ctx.quadraticCurveTo(cur[0] + lvx * 0.5 + ax * llen * 0.15, cur[1] + lvy * 0.5 + ay * llen * 0.15, cur[0] + lvx, cur[1] + lvy);
      ctx.stroke();
    }
  }
}

export function drawPalmV3(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const { topX, topY } = palmTrunk(ctx, rng);
  underCrown(ctx, topX, topY, 5, 3.5);
  ctx.strokeStyle = "#3f9e57";
  const wind = randRange(rng, -0.06, 0.06); // shared across this tree's fronds
  const fronds = randInt(rng, 6, 9);
  const spread = 1.2;
  for (let i = 0; i < fronds; i++) {
    const base = -Math.PI / 2 + (i / (fronds - 1) - 0.5) * 2 * spread + randRange(rng, -0.2, 0.2);
    drawStrandFrond(ctx, rng, topX, topY, base, randRange(rng, 9, 13), wind);
  }
  palmCoconuts(ctx, rng, topX, topY);
}

export const PALM_VARIANTS: Record<number, (ctx: CanvasRenderingContext2D, rng: Rng) => void> = {
  1: drawPalmV1,
  2: drawPalmV2,
  3: drawPalmV3,
};

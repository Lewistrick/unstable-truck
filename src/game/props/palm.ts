import { randInt, randRange, type Rng } from "../../util/rng.js";

// Palm tree, drawn in local space with its base at y = 9 (the ground/shadow
// line), growing upward. Its crown is built from filled, tapered leaf blades
// layered back-to-front so it reads as a full silhouette at small sizes.

const TAU = Math.PI * 2;
type Pt = [number, number];

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

function palmCoconuts(ctx: CanvasRenderingContext2D, rng: Rng, topX: number, topY: number): void {
  ctx.fillStyle = "#5a3a24";
  const count = randInt(rng, 1, 3);
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.arc(topX + randRange(rng, -2, 2), topY + randRange(rng, 0.5, 2.5), 1.3, 0, TAU);
    ctx.fill();
  }
}

/** A frond as a filled, tapered leaf blade with a serrated (leaflet) edge along
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

export function drawPalm(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const { topX, topY } = palmTrunk(ctx, rng);
  const fronds = randInt(rng, 6, 9);
  const spread = 1.3;
  // Back layer (darker, drawn first) then front layer (lighter) for depth.
  for (const [layerFill, layerLen] of [["#2f7d47", 12] as const, ["#48a95e", 10] as const]) {
    for (let i = 0; i < fronds; i++) {
      const base = -Math.PI / 2 + (i / (fronds - 1) - 0.5) * 2 * spread;
      drawBlade(ctx, rng, topX, topY, base + randRange(rng, -0.2, 0.2), layerLen + randRange(rng, -1.5, 1.5) + 5, layerFill);
    }
  }
  palmCoconuts(ctx, rng, topX, topY);
}

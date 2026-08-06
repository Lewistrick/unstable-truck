import { randRange, type Rng } from "../../util/rng.js";
import { TAU } from "./shared.js";

export function drawCrater(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // A shallow impact crater on the ground: a light raised rim around a darker
  // bowl. Flat, so it gets no drop shadow (see SHADOWLESS).
  const r = randRange(rng, 7, 12);
  const cy = 4;
  // Raised rim (light).
  ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
  ctx.beginPath();
  ctx.ellipse(0, cy, r, r * 0.6, 0, 0, TAU);
  ctx.fill();
  // Bowl interior (dark).
  ctx.fillStyle = "rgba(0, 0, 0, 0.20)";
  ctx.beginPath();
  ctx.ellipse(0, cy, r * 0.82, r * 0.48, 0, 0, TAU);
  ctx.fill();
  // Deeper shadow crescent toward the lower-left.
  ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
  ctx.beginPath();
  ctx.ellipse(-r * 0.14, cy + 0.6, r * 0.55, r * 0.3, 0, 0, TAU);
  ctx.fill();
  // Highlight along the upper rim.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, cy, r * 0.9, r * 0.54, 0, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
}

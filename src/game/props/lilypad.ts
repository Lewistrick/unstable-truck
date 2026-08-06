import { randRange, type Rng } from "../../util/rng.js";
import { TAU } from "./shared.js";

export function drawLilypad(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Round pad with a small notch at a random angle; flower size/place vary.
  const r = randRange(rng, 4.5, 7);
  const notch = randRange(rng, 0, TAU);
  const gap = randRange(rng, 0.22, 0.42);
  ctx.fillStyle = "#3f8f4e";
  ctx.beginPath();
  ctx.arc(0, 7, r, notch + gap, notch - gap + TAU);
  ctx.lineTo(0, 7);
  ctx.closePath();
  ctx.fill();
  if (rng() < 0.7) {
    const fa = randRange(rng, 0, TAU);
    const fd = randRange(rng, 0, r * 0.5);
    ctx.fillStyle = rng() < 0.5 ? "#e88bb0" : "#f4f1ea";
    ctx.beginPath();
    ctx.arc(Math.cos(fa) * fd, 7 + Math.sin(fa) * fd, randRange(rng, 1.2, 2.2), 0, TAU);
    ctx.fill();
  }
}

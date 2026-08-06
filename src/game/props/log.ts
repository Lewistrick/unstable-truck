import { randInt, randRange, type Rng } from "../../util/rng.js";
import { roundedRect, TAU } from "./shared.js";

export function drawLog(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // A fallen tree lying on the ground: a horizontal bark body with a ringed cut
  // face at one end and the occasional patch of moss on top.
  const len = randRange(rng, 14, 20);
  const left = -len / 2;
  const right = len / 2;
  const topY = 3;
  const h = 5.5;
  // Bark body.
  ctx.fillStyle = "#6b4a2f";
  roundedRect(ctx, left, topY, len, h, h / 2);
  ctx.fill();
  // Length-wise bark shading streaks.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.16)";
  ctx.lineWidth = 0.6;
  for (const yy of [topY + h * 0.34, topY + h * 0.62]) {
    ctx.beginPath();
    ctx.moveTo(left + 2, yy);
    ctx.lineTo(right - 3.5, yy);
    ctx.stroke();
  }
  // Cut face with growth rings at the right end.
  const cx = right - 1.4;
  const cy = topY + h / 2;
  const rw = 2.2;
  const rh = h / 2;
  ctx.fillStyle = "#c9a36b";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rw, rh, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#9c7a4a";
  ctx.lineWidth = 0.5;
  for (const f of [0.62, 0.3]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rw * f, rh * f, 0, 0, TAU);
    ctx.stroke();
  }
  // Occasional moss on top.
  if (rng() < 0.6) {
    ctx.fillStyle = "#5a8f3c";
    const patches = randInt(rng, 2, 4);
    for (let i = 0; i < patches; i++) {
      ctx.beginPath();
      ctx.ellipse(randRange(rng, left + 2, right - 4), topY + 0.6, randRange(rng, 1.5, 3), 1, 0, 0, TAU);
      ctx.fill();
    }
  }
}

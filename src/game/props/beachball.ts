import { randInt, shuffle, type Rng } from "../../util/rng.js";
import { BEACHBALL_COLORS, TAU } from "./shared.js";

export function drawBeachball(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  const segs = 6;
  // 2-4 random colors from the palette, cycled around the segments.
  const colors = shuffle(rng, BEACHBALL_COLORS).slice(0, randInt(rng, 2, 4));
  for (let i = 0; i < segs; i++) {
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.beginPath();
    ctx.moveTo(0, 3);
    ctx.arc(0, 3, 6, (i / segs) * TAU - Math.PI / 2, ((i + 1) / segs) * TAU - Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(0, 3, 6, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
  ctx.beginPath();
  ctx.arc(-2, 1, 1.6, 0, TAU);
  ctx.fill();
}

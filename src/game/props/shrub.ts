import { SHRUB_FLOWERS, TAU } from "./shared.js";

export function drawShrub(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.fillStyle = "#4b7a3a";
  ctx.beginPath();
  ctx.arc(-3, 3, 5, 0, TAU);
  ctx.arc(3, 3, 5, 0, TAU);
  ctx.arc(0, -1, 5.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = SHRUB_FLOWERS[variant % SHRUB_FLOWERS.length]!;
  ctx.beginPath();
  ctx.arc(-2, -1, 1.4, 0, TAU);
  ctx.arc(2, 1, 1.4, 0, TAU);
  ctx.arc(0, 3, 1.4, 0, TAU);
  ctx.fill();
}

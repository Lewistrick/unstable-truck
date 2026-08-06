import { roundedRect, TAU } from "./shared.js";

export function drawAstronaut(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#eef1f4";
  roundedRect(ctx, -4, -4, 8, 12, 3);
  ctx.fill();
  ctx.fillRect(-3.5, 8, 2.5, 2);
  ctx.fillRect(1, 8, 2.5, 2);
  ctx.beginPath();
  ctx.arc(0, -6, 4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#3a4a63";
  ctx.beginPath();
  ctx.arc(0, -6, 2.6, 0, TAU);
  ctx.fill();
}

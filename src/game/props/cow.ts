import { roundedRect, TAU } from "./shared.js";

export function drawCow(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#4a423d";
  ctx.fillRect(-6, 4, 2.5, 5);
  ctx.fillRect(3.5, 4, 2.5, 5);
  ctx.fillStyle = "#f4f1ea";
  roundedRect(ctx, -8, -5, 16, 10, 5);
  ctx.fill();
  ctx.fillStyle = "#4a423d";
  ctx.beginPath();
  ctx.ellipse(-2, 0, 3, 2.6, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(4, -2, 2, 1.8, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#f4f1ea";
  roundedRect(ctx, 6, -4, 7, 7, 3);
  ctx.fill();
  ctx.fillStyle = "#caa0a0";
  roundedRect(ctx, 9.5, -1, 4, 3.5, 1.5);
  ctx.fill();
}

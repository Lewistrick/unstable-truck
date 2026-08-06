import { roundedRect, TAU } from "./shared.js";

export function drawPenguin(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#2b2b30";
  roundedRect(ctx, -5, -8, 10, 17, 5);
  ctx.fill();
  ctx.fillStyle = "#f4f1ea";
  roundedRect(ctx, -3.5, -3, 7, 11, 3.5);
  ctx.fill();
  ctx.fillStyle = "#2b2b30";
  ctx.beginPath();
  ctx.arc(-1.8, -4, 0.9, 0, TAU);
  ctx.arc(1.8, -4, 0.9, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#e8912f";
  ctx.beginPath();
  ctx.moveTo(-1.5, -2);
  ctx.lineTo(1.5, -2);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(-3, 8, 2.5, 1.8);
  ctx.fillRect(0.6, 8, 2.5, 1.8);
}

import { roundedRect, TAU } from "./shared.js";

export function drawBunny(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#f0ece4";
  ctx.beginPath();
  ctx.ellipse(0, 4, 4.5, 5, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -2, 3.2, 0, TAU);
  ctx.fill();
  roundedRect(ctx, -2.6, -11, 1.8, 7, 0.9);
  ctx.fill();
  roundedRect(ctx, 0.8, -11, 1.8, 7, 0.9);
  ctx.fill();
  ctx.fillStyle = "#e8b3c0";
  roundedRect(ctx, -2.1, -10, 0.8, 5, 0.4);
  ctx.fill();
  roundedRect(ctx, 1.3, -10, 0.8, 5, 0.4);
  ctx.fill();
  ctx.fillStyle = "#4a423d";
  ctx.beginPath();
  ctx.arc(-1, -2, 0.6, 0, TAU);
  ctx.arc(1, -2, 0.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#e8879c";
  ctx.beginPath();
  ctx.arc(0, -0.5, 0.7, 0, TAU);
  ctx.fill();
}

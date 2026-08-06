import { roundedRect, TAU } from "./shared.js";

export function drawScarecrow(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "#8a6a44";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(0, -6);
  ctx.moveTo(-6, -1);
  ctx.lineTo(6, -1);
  ctx.stroke();
  ctx.fillStyle = "#7ea04a";
  roundedRect(ctx, -4, -4, 8, 8, 2);
  ctx.fill();
  ctx.fillStyle = "#d9b46a";
  ctx.beginPath();
  ctx.arc(0, -7, 3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#8a5a2a";
  ctx.beginPath();
  ctx.moveTo(-4, -8);
  ctx.lineTo(4, -8);
  ctx.lineTo(2, -12);
  ctx.lineTo(-2, -12);
  ctx.closePath();
  ctx.fill();
}

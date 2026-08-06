import { TAU } from "./shared.js";

export function drawCyclist(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "#33373d";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(-4, 6, 3, 0, TAU);
  ctx.moveTo(7, 6);
  ctx.arc(4, 6, 3, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-4, 6);
  ctx.lineTo(0, 6);
  ctx.lineTo(-1, 1);
  ctx.lineTo(-4, 6);
  ctx.moveTo(0, 6);
  ctx.lineTo(3, 2);
  ctx.stroke();
  ctx.strokeStyle = "#c23b3b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-1, 1);
  ctx.lineTo(1, -2);
  ctx.lineTo(3, 2);
  ctx.stroke();
  ctx.fillStyle = "#e0b48c";
  ctx.beginPath();
  ctx.arc(1, -4, 1.6, 0, TAU);
  ctx.fill();
}

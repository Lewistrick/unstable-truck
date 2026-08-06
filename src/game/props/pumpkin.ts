import { TAU } from "./shared.js";

export function drawPumpkin(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#e07b28";
  ctx.beginPath();
  ctx.ellipse(0, 4, 7, 5.5, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(150, 80, 20, 0.4)";
  ctx.beginPath();
  ctx.ellipse(0, 4, 2.5, 5.3, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#5a7a2a";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, -1);
  ctx.lineTo(0, -4);
  ctx.stroke();
}

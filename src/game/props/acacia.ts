import { TAU } from "./shared.js";

export function drawAcacia(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#6b4a2f";
  ctx.fillRect(-1.3, -1, 2.6, 10);
  ctx.strokeStyle = "#6b4a2f";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -1);
  ctx.lineTo(-5, -4);
  ctx.moveTo(0, -1);
  ctx.lineTo(5, -4);
  ctx.stroke();
  ctx.fillStyle = "#5a8f3c";
  ctx.beginPath();
  ctx.ellipse(0, -6, 10, 3.5, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, -8, 7, 2.5, 0, 0, TAU);
  ctx.fill();
}

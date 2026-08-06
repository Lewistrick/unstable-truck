import { EGG_COLORS, TAU } from "./shared.js";

export function drawEgg(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.fillStyle = EGG_COLORS[variant % EGG_COLORS.length]!;
  ctx.beginPath();
  ctx.ellipse(0, 3, 4.5, 6, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#f4f1ea";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-4.2, 2);
  ctx.lineTo(-2, 4);
  ctx.lineTo(0, 2);
  ctx.lineTo(2, 4);
  ctx.lineTo(4.2, 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.beginPath();
  ctx.arc(-1, -1, 0.8, 0, TAU);
  ctx.arc(2, 0, 0.8, 0, TAU);
  ctx.fill();
}

import { FESTIVE_COLORS, TAU } from "./shared.js";

export function drawBalloon(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.fillStyle = FESTIVE_COLORS[variant % FESTIVE_COLORS.length]!;
  ctx.beginPath();
  ctx.ellipse(0, -4, 4, 5, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-1, 1);
  ctx.lineTo(1, 1);
  ctx.lineTo(0, 2.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(120, 120, 120, 0.7)";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(0, 2.5);
  ctx.quadraticCurveTo(2, 6, 0, 9);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.beginPath();
  ctx.ellipse(-1.3, -6, 1, 1.6, 0, 0, TAU);
  ctx.fill();
}

import { CANDY_COLORS, TAU } from "./shared.js";

export function drawLollipop(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.strokeStyle = "#e8e2d6";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(0, -2);
  ctx.stroke();
  ctx.fillStyle = CANDY_COLORS[variant % CANDY_COLORS.length]!;
  ctx.beginPath();
  ctx.arc(0, -5, 4.5, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let a = 0; a < TAU * 2; a += 0.3) {
    const r = (a / (TAU * 2)) * 4.2;
    const x = Math.cos(a) * r;
    const y = -5 + Math.sin(a) * r;
    if (a === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

import { FESTIVE_COLORS, TAU } from "./shared.js";

export function drawFirework(ctx: CanvasRenderingContext2D, variant: number): void {
  const color = FESTIVE_COLORS[variant % FESTIVE_COLORS.length]!;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(0, -2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 2, -6 + Math.sin(a) * 2);
    ctx.lineTo(Math.cos(a) * 7, -6 + Math.sin(a) * 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 7.5, -6 + Math.sin(a) * 7.5, 0.9, 0, TAU);
    ctx.fill();
  }
}

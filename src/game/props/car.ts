import { CAR_COLORS, roundedRect, TAU } from "./shared.js";

export function drawCar(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.fillStyle = CAR_COLORS[variant % CAR_COLORS.length]!;
  roundedRect(ctx, -8, -1, 16, 6, 2);
  ctx.fill();
  roundedRect(ctx, -4.5, -5, 9, 5, 2);
  ctx.fill();
  ctx.fillStyle = "#bcd7e6";
  roundedRect(ctx, -3, -4, 6, 3, 1);
  ctx.fill();
  ctx.fillStyle = "#26292e";
  ctx.beginPath();
  ctx.arc(-4.5, 5, 2, 0, TAU);
  ctx.arc(4.5, 5, 2, 0, TAU);
  ctx.fill();
}

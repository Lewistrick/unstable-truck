import { MUSHROOM_CAPS, roundedRect, TAU } from "./shared.js";

export function drawMushroom(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.fillStyle = "#efe6d2";
  roundedRect(ctx, -2, -1, 4, 9, 2);
  ctx.fill();
  ctx.fillStyle = MUSHROOM_CAPS[variant % MUSHROOM_CAPS.length]!;
  ctx.beginPath();
  ctx.moveTo(-7, -1);
  ctx.quadraticCurveTo(0, -11, 7, -1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#f4efe0";
  ctx.beginPath();
  ctx.arc(-2.5, -4, 1, 0, TAU);
  ctx.arc(2.5, -3, 1, 0, TAU);
  ctx.arc(0, -6, 1, 0, TAU);
  ctx.fill();
}

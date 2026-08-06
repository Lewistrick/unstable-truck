import { TAU } from "./shared.js";

export function drawTree(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#6b4a2f";
  ctx.fillRect(-1.5, 2, 3, 7);
  ctx.fillStyle = "#3f8f4e";
  ctx.beginPath();
  ctx.arc(0, -3, 7, 0, TAU);
  ctx.arc(-4, 0, 5, 0, TAU);
  ctx.arc(4, 0, 5, 0, TAU);
  ctx.fill();
}

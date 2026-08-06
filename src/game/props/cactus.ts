import { roundedRect } from "./shared.js";

export function drawCactus(ctx: CanvasRenderingContext2D, variant: number): void {
  // Every cactus has at least one arm; arms bend outward then up (saguaro).
  const hasLeft = variant !== 2;
  const hasRight = variant !== 1;
  ctx.fillStyle = "#3f8f4e";
  roundedRect(ctx, -2.5, -9, 5, 18, 2.5); // trunk
  ctx.fill();
  if (hasLeft) {
    roundedRect(ctx, -7, 1, 5.5, 2.5, 1.2); // elbow out to the left
    ctx.fill();
    roundedRect(ctx, -7, -5, 3, 8, 1.5); // then up
    ctx.fill();
  }
  if (hasRight) {
    roundedRect(ctx, 1.5, 3, 5.5, 2.5, 1.2); // elbow out to the right
    ctx.fill();
    roundedRect(ctx, 4, -3, 3, 8, 1.5); // then up
    ctx.fill();
  }
}

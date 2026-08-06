import { randInt, randRange, type Rng } from "../../util/rng.js";
import { roundedRect } from "./shared.js";

export function drawReeds(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Random clump: varied count, positions, heights, sway, and head size.
  const count = randInt(rng, 3, 7);
  for (let i = 0; i < count; i++) {
    const x = randRange(rng, -5, 5);
    const top = -randRange(rng, 4, 9);
    const sway = randRange(rng, -1.2, 1.2);
    ctx.strokeStyle = "#5f7d3a";
    ctx.lineWidth = randRange(rng, 0.9, 1.5);
    ctx.beginPath();
    ctx.moveTo(x, 9);
    ctx.quadraticCurveTo(x + sway, (top + 9) / 2, x + sway, top);
    ctx.stroke();
    ctx.fillStyle = "#7a5230";
    const hw = randRange(rng, 1.6, 2.4);
    roundedRect(ctx, x + sway - hw / 2, top, hw, randRange(rng, 3.5, 5), hw / 2);
    ctx.fill();
  }
}

import { randInt, randRange, type Rng } from "../../util/rng.js";
import { AUTUMN_LEAF_COLORS, TAU } from "./shared.js";

export function drawLeaves(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // A patch of scattered fallen leaves, random count and autumn colors.
  const count = randInt(rng, 6, 16);
  for (let i = 0; i < count; i++) {
    ctx.save();
    ctx.translate(randRange(rng, -9, 9), randRange(rng, -3, 8));
    ctx.rotate(randRange(rng, 0, TAU));
    const len = randRange(rng, 1.6, 3);
    ctx.fillStyle = AUTUMN_LEAF_COLORS[randInt(rng, 0, AUTUMN_LEAF_COLORS.length - 1)]!;
    ctx.beginPath();
    ctx.ellipse(0, 0, len, len * 0.55, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.restore();
  }
}

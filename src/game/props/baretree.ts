import { randRange, type Rng } from "../../util/rng.js";
import { drawTreeBranch } from "./shared.js";

export function drawBaretree(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  ctx.fillStyle = "#6b4a2f";
  drawTreeBranch(ctx, rng, 0, 9, -Math.PI / 2, randRange(rng, 7, 10), 2.4, 0, 6);
}

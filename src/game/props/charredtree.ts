import { randRange, type Rng } from "../../util/rng.js";
import { drawTreeBranch } from "./shared.js";

export function drawCharredtree(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Same recursive tree as the autumn bare tree, only darker.
  ctx.fillStyle = "#2e2724";
  drawTreeBranch(ctx, rng, 0, 9, -Math.PI / 2, randRange(rng, 7, 10), 2.4, 0, 6);
}

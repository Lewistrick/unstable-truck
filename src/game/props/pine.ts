import { type Rng } from "../../util/rng.js";
import { conifer } from "./shared.js";

export function drawPine(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  conifer(ctx, rng, false);
}

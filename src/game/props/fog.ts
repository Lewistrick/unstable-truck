import { randInt, randRange, type Rng } from "../../util/rng.js";
import { TAU } from "./shared.js";

export function drawFog(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Soft translucent patch of overlapping puffs.
  ctx.fillStyle = "rgba(232, 236, 239, 0.13)";
  const puffs = randInt(rng, 4, 7);
  for (let i = 0; i < puffs; i++) {
    ctx.beginPath();
    ctx.ellipse(randRange(rng, -8, 8), randRange(rng, -2, 6), randRange(rng, 5, 9), randRange(rng, 3, 5), 0, 0, TAU);
    ctx.fill();
  }
}

import { randInt, randRange, type Rng } from "../../util/rng.js";
import { TAU } from "./shared.js";

export function drawFog(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Soft translucent patch of overlapping puffs. Layered a bit heavier than a
  // single wash so the mist actually reads against the swamp ground.
  ctx.fillStyle = "rgba(234, 238, 241, 0.22)";
  const puffs = randInt(rng, 5, 8);
  for (let i = 0; i < puffs; i++) {
    ctx.beginPath();
    ctx.ellipse(randRange(rng, -9, 9), randRange(rng, -2, 6), randRange(rng, 6, 11), randRange(rng, 4, 6), 0, 0, TAU);
    ctx.fill();
  }
}

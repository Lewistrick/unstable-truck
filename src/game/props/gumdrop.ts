import { randInt, randRange, type Rng } from "../../util/rng.js";
import { GUMDROP_COLORS, TAU } from "./shared.js";

export function drawGumdrop(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  ctx.fillStyle = GUMDROP_COLORS[randInt(rng, 0, GUMDROP_COLORS.length - 1)]!;
  ctx.beginPath();
  ctx.moveTo(-4.5, 7);
  ctx.quadraticCurveTo(-4.7, -2, 0, -2);
  ctx.quadraticCurveTo(4.7, -2, 4.5, 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(randRange(rng, -3.5, 3.5), randRange(rng, -1, 6), 0.5, 0, TAU);
    ctx.fill();
  }
}

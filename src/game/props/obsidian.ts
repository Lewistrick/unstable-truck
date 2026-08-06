import { randRange, type Rng } from "../../util/rng.js";

export function drawObsidian(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Angular black glassy shard with a cool sheen facet.
  const w = randRange(rng, 3, 5);
  const h = randRange(rng, 6, 10);
  ctx.fillStyle = "#1c1a22";
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(-w, 4);
  ctx.lineTo(-w * 0.4, 9 - h);
  ctx.lineTo(w * 0.6, 9 - h * 0.8);
  ctx.lineTo(w, 5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(150, 140, 190, 0.5)";
  ctx.beginPath();
  ctx.moveTo(-w * 0.1, 8);
  ctx.lineTo(-w * 0.4, 10 - h);
  ctx.lineTo(w * 0.1, 10 - h * 0.8);
  ctx.closePath();
  ctx.fill();
}

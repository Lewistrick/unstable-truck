import { randInt, type Rng } from "../../util/rng.js";
import { roundedRect, TAU } from "./shared.js";

export function drawTrafficlight(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  ctx.strokeStyle = "#3a3f47";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(0, -6);
  ctx.stroke();
  ctx.fillStyle = "#26292e";
  roundedRect(ctx, -2.2, -12, 4.4, 8, 1.4);
  ctx.fill();
  // Panel spans y -12..-4; place the three lights centered so none spill off.
  const lights = ["#e8503a", "#f2c14e", "#3f9e57"];
  const muted = ["#5a2a25", "#5a4e28", "#26402e"];
  const on = randInt(rng, 0, 2);
  for (let i = 0; i < 3; i++) {
    const cy = -10.4 + i * 2.4;
    if (i === on) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = lights[i]!;
      ctx.beginPath();
      ctx.arc(0, cy, 2, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = i === on ? lights[i]! : muted[i]!;
    ctx.beginPath();
    ctx.arc(0, cy, 1.1, 0, TAU);
    ctx.fill();
  }
}

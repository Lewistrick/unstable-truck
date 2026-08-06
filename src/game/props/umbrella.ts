import { randRange, type Rng } from "../../util/rng.js";

export function drawUmbrella(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Lean the whole umbrella -30..30 deg, pivoting where it meets the sand.
  ctx.translate(0, 9);
  ctx.rotate(randRange(rng, -Math.PI / 6, Math.PI / 6));
  ctx.translate(0, -9);
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(0, -4);
  ctx.stroke();
  ctx.fillStyle = "#e8503a";
  ctx.beginPath();
  ctx.moveTo(-8, -4);
  ctx.quadraticCurveTo(0, -13, 8, -4);
  ctx.quadraticCurveTo(4, -2, 2, -4);
  ctx.quadraticCurveTo(0, -2, -2, -4);
  ctx.quadraticCurveTo(-4, -2, -8, -4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.moveTo(-4, -5.5);
  ctx.quadraticCurveTo(-2, -9, 0, -10.5);
  ctx.quadraticCurveTo(-1, -6.5, -1.5, -4.3);
  ctx.closePath();
  ctx.fill();
}

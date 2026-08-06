import { randRange, type Rng } from "../../util/rng.js";

export function drawTermitemound(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // A tall, lumpy clay termite mound with a main spire and a lower shoulder.
  const h = randRange(rng, 12, 18);
  ctx.fillStyle = "#9c6338";
  ctx.beginPath();
  ctx.moveTo(-5, 9);
  ctx.quadraticCurveTo(-3.5, -h * 0.35, -1, -h); // main peak
  ctx.quadraticCurveTo(0.2, -h * 0.7, 1.6, -h * 0.5); // saddle to a second bump
  ctx.quadraticCurveTo(3.2, -h * 0.75, 3.8, -h * 0.25);
  ctx.quadraticCurveTo(5, 0, 5.5, 9);
  ctx.closePath();
  ctx.fill();
  // Shaded right flank for a bit of form.
  ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
  ctx.beginPath();
  ctx.moveTo(1.6, -h * 0.5);
  ctx.quadraticCurveTo(3.2, -h * 0.75, 3.8, -h * 0.25);
  ctx.quadraticCurveTo(5, 0, 5.5, 9);
  ctx.lineTo(1.5, 9);
  ctx.closePath();
  ctx.fill();
  // Vertical clay streaks.
  ctx.strokeStyle = "rgba(90, 55, 30, 0.5)";
  ctx.lineWidth = 0.5;
  const streaks: Array<[number, number]> = [
    [-1.5, -h * 0.5],
    [0.5, -h * 0.3],
    [2.6, -h * 0.2],
  ];
  for (const [sx, sy] of streaks) {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx * 1.4, 8);
    ctx.stroke();
  }
}

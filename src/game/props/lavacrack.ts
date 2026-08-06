import { randInt, randRange, type Rng } from "../../util/rng.js";

export function drawLavacrack(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Jagged glowing fissure across the ground.
  const pts: Array<[number, number]> = [];
  const steps = randInt(rng, 4, 6);
  let cy = randRange(rng, 3, 7);
  for (let i = 0; i <= steps; i++) {
    pts.push([-8 + (16 / steps) * i, Math.max(0, Math.min(9, cy))]);
    cy += randRange(rng, -3, 3);
  }
  const trace = (width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    ctx.stroke();
  };
  trace(3.6, "#2a1f1c");
  trace(1.8, "#e8531f");
  trace(0.7, "#ffc04a");
}

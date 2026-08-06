import { randRange, type Rng } from "../../util/rng.js";
import { TAU } from "./shared.js";

export function drawFrozenlake(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // A flat sheet of ice: a pale blue irregular blob with a sheen streak and a
  // crack. Flat, so it gets no drop shadow (see SHADOWLESS).
  const rx = randRange(rng, 10, 15);
  const ry = rx * randRange(rng, 0.5, 0.66);
  const cy = 5;
  const lobes = 11;
  ctx.beginPath();
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU;
    const rr = 1 + randRange(rng, -0.12, 0.12);
    const x = Math.cos(a) * rx * rr;
    const y = cy + Math.sin(a) * ry * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(188, 216, 232, 0.8)";
  ctx.fill();
  ctx.strokeStyle = "rgba(120, 150, 172, 0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Sheen streak.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-rx * 0.4, cy - ry * 0.3);
  ctx.lineTo(rx * 0.1, cy - ry * 0.45);
  ctx.stroke();
  // A hairline crack.
  ctx.strokeStyle = "rgba(150, 178, 196, 0.5)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(rx * 0.2, cy + ry * 0.2);
  ctx.lineTo(rx * 0.5, cy - ry * 0.1);
  ctx.lineTo(rx * 0.35, cy + ry * 0.4);
  ctx.stroke();
}

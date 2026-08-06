import { type Rng } from "../../util/rng.js";
import { TAU } from "./shared.js";

export function drawDeer(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Standing deer in side view; faces left or right at random.
  if (rng() < 0.5) ctx.scale(-1, 1);
  const body = "#a06a3a";
  const dark = "#6b4a2f";

  // Legs.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  for (const lx of [-4.5, -2.8, 2.6, 4]) {
    ctx.beginPath();
    ctx.moveTo(lx, 2);
    ctx.lineTo(lx, 9);
    ctx.stroke();
  }

  // Body.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(-0.5, 0, 6, 3.2, 0, 0, TAU);
  ctx.fill();

  // Neck rising toward the head at the front (right) end.
  ctx.beginPath();
  ctx.moveTo(3, -1.5);
  ctx.lineTo(5.5, 1);
  ctx.lineTo(8.4, -4.6);
  ctx.lineTo(6.2, -6);
  ctx.closePath();
  ctx.fill();

  // Head (with an ear), tilted so the snout points forward.
  ctx.save();
  ctx.translate(8.2, -6);
  ctx.rotate(-0.35);
  ctx.beginPath();
  ctx.ellipse(0, 0, 2.6, 1.4, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-1.6, -0.8);
  ctx.lineTo(-2.8, -2.2);
  ctx.lineTo(-1, -1.6);
  ctx.closePath();
  ctx.fill();
  // Eye.
  ctx.fillStyle = "#2b241f";
  ctx.beginPath();
  ctx.arc(0.6, -0.2, 0.4, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Antlers branching up off the brow.
  ctx.strokeStyle = "#8a6a44";
  ctx.lineWidth = 0.8;
  const ax = 7.6;
  const ay = -7.4;
  ctx.beginPath();
  ctx.moveTo(ax, ay + 1.2);
  ctx.lineTo(ax + 0.5, ay - 3); // main beam
  ctx.moveTo(ax + 0.2, ay - 0.8);
  ctx.lineTo(ax - 1.3, ay - 2.3); // back tine
  ctx.moveTo(ax + 0.4, ay - 1.9);
  ctx.lineTo(ax + 1.9, ay - 3.2); // front tine
  ctx.stroke();

  // White tail patch at the rump.
  ctx.fillStyle = "#efe9dd";
  ctx.beginPath();
  ctx.ellipse(-6, -0.5, 1.3, 1.9, 0, 0, TAU);
  ctx.fill();
}

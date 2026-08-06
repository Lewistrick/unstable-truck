import { type Rng } from "../../util/rng.js";
import { TAU, TRACTOR_COLORS } from "./shared.js";

export function drawTractor(ctx: CanvasRenderingContext2D, variant: number, rng: Rng): void {
  // Face left or right at random (as if driving either way).
  if (rng() < 0.5) ctx.scale(-1, 1);
  // Classic farm tractor: big rear wheel, small front wheel, colored body.
  ctx.fillStyle = TRACTOR_COLORS[variant % TRACTOR_COLORS.length]!;
  ctx.beginPath();
  ctx.moveTo(-8, 6);
  ctx.lineTo(-8, 2.5);
  ctx.lineTo(-2, 2.5);
  ctx.lineTo(-2, -2);
  ctx.lineTo(5, -2);
  ctx.lineTo(6.5, 2);
  ctx.lineTo(6.5, 6);
  ctx.closePath();
  ctx.fill();
  // Grille shading (color-agnostic so it works on any body color).
  ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
  ctx.fillRect(-8, 4, 6, 1.4);
  // Exhaust stack rising off the hood.
  ctx.fillStyle = "#3a3a3a";
  ctx.fillRect(-7.4, -3, 1.1, 6);
  // Seat + steering column.
  ctx.fillStyle = "#2b2b2b";
  ctx.fillRect(0.5, -3, 2.2, 1.6);
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(3.5, -1.5);
  ctx.lineTo(5, -4);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(5, -4.4, 1, 0, TAU);
  ctx.stroke();
  // Wheels (drawn over the body so the fenders tuck behind them).
  ctx.fillStyle = "#2b2b2b";
  ctx.beginPath();
  ctx.arc(3.2, 4.5, 4.5, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-6, 6.4, 2.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#d9b46a";
  ctx.beginPath();
  ctx.arc(3.2, 4.5, 2, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-6, 6.4, 1.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#5f5140";
  ctx.beginPath();
  ctx.arc(3.2, 4.5, 0.7, 0, TAU);
  ctx.fill();
}

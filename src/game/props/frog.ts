import { TAU } from "./shared.js";

export function drawFrog(ctx: CanvasRenderingContext2D): void {
  // A squat green frog seen from just above/in front.
  const green = "#5a9e3f";
  const dark = "#3f7a2c";
  // Splayed hind legs.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(-4.5, 6, 2.4, 1.5, -0.5, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(4.5, 6, 2.4, 1.5, 0.5, 0, TAU);
  ctx.fill();
  // Body.
  ctx.fillStyle = green;
  ctx.beginPath();
  ctx.ellipse(0, 4, 5, 3.6, 0, 0, TAU);
  ctx.fill();
  // Front feet.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(-3, 7.4, 1.4, 0.9, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(3, 7.4, 1.4, 0.9, 0, 0, TAU);
  ctx.fill();
  // Eye bumps on top of the head.
  ctx.fillStyle = green;
  ctx.beginPath();
  ctx.arc(-2.1, 0.6, 1.9, 0, TAU);
  ctx.arc(2.1, 0.6, 1.9, 0, TAU);
  ctx.fill();
  // Eyes.
  ctx.fillStyle = "#f2e9b8";
  ctx.beginPath();
  ctx.arc(-2.1, 0.4, 1.1, 0, TAU);
  ctx.arc(2.1, 0.4, 1.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#1e2a1a";
  ctx.beginPath();
  ctx.arc(-2.1, 0.5, 0.55, 0, TAU);
  ctx.arc(2.1, 0.5, 0.55, 0, TAU);
  ctx.fill();
  // Smiling mouth.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(0, 4.2, 3, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
}

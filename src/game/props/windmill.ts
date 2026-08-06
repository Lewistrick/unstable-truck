import { TAU } from "./shared.js";

export function drawWindmill(ctx: CanvasRenderingContext2D): void {
  // American farm windmill: a lattice tower under a face-on multi-blade fan
  // wheel, with a tail vane off to one side.
  const baseHalf = 3.4;
  const topHalf = 1.1;
  const topY = -5;
  const baseY = 9;
  ctx.strokeStyle = "#9aa0a8";
  ctx.lineCap = "round";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-baseHalf, baseY);
  ctx.lineTo(-topHalf, topY);
  ctx.moveTo(baseHalf, baseY);
  ctx.lineTo(topHalf, topY);
  ctx.stroke();
  // Cross-bracing between the rails so the tower reads as a lattice.
  ctx.lineWidth = 0.6;
  const segs = 3;
  const railX = (t: number) => -baseHalf + (baseHalf - topHalf) * t;
  const railY = (t: number) => baseY + (topY - baseY) * t;
  ctx.beginPath();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    ctx.moveTo(railX(t0), railY(t0));
    ctx.lineTo(-railX(t1), railY(t1));
    ctx.moveTo(-railX(t0), railY(t0));
    ctx.lineTo(railX(t1), railY(t1));
    ctx.moveTo(railX(t1), railY(t1));
    ctx.lineTo(-railX(t1), railY(t1));
  }
  ctx.stroke();
  // Mast from the tower top up to the fan hub.
  const hubY = topY - 3;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, topY);
  ctx.lineTo(0, hubY);
  ctx.stroke();
  // Tail vane boom + fin behind the wheel.
  ctx.strokeStyle = "#8a8f96";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, hubY);
  ctx.lineTo(8, hubY + 1);
  ctx.stroke();
  ctx.fillStyle = "#c0433a";
  ctx.beginPath();
  ctx.moveTo(6.5, hubY - 2.5);
  ctx.lineTo(9.5, hubY - 1.5);
  ctx.lineTo(9.5, hubY + 3.5);
  ctx.lineTo(6.5, hubY + 2.5);
  ctx.closePath();
  ctx.fill();
  // Fan wheel: narrow blades fanning out into a near-solid disc.
  const R = 4.8;
  const blades = 18;
  ctx.fillStyle = "#c7ccd2";
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU;
    const a2 = a + (TAU / blades) * 0.62;
    ctx.beginPath();
    ctx.moveTo(0, hubY);
    ctx.lineTo(Math.cos(a) * R, hubY + Math.sin(a) * R);
    ctx.lineTo(Math.cos(a2) * R, hubY + Math.sin(a2) * R);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "#5f6873";
  ctx.beginPath();
  ctx.arc(0, hubY, 1.4, 0, TAU);
  ctx.fill();
}

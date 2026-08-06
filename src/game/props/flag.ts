export function drawFlag(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "#c9ccd2";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.lineTo(0, -9);
  ctx.stroke();
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(8, -7);
  ctx.lineTo(0, -4);
  ctx.closePath();
  ctx.fill();
}

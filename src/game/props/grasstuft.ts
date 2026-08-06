export function drawGrasstuft(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "#7ea04a";
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 1.2, 9);
    ctx.quadraticCurveTo(i * 1.6, 3, i * 2.2, -2 + Math.abs(i));
    ctx.stroke();
  }
}

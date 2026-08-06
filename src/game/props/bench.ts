export function drawBench(ctx: CanvasRenderingContext2D): void {
  // A simple park bench: seat and back planks on two legs.
  const wood = "#8a5a34";
  const dark = "#5f3f24";
  // Legs.
  ctx.fillStyle = dark;
  ctx.fillRect(-5, 3, 1.6, 6);
  ctx.fillRect(3.4, 3, 1.6, 6);
  // Back supports.
  ctx.fillRect(-5.6, -3.5, 1.2, 5);
  ctx.fillRect(4.4, -3.5, 1.2, 5);
  // Seat plank.
  ctx.fillStyle = wood;
  ctx.fillRect(-6.5, 1.5, 13, 1.8);
  // Backrest planks.
  ctx.fillRect(-6.5, -3.5, 13, 1.5);
  ctx.fillRect(-6.5, -1, 13, 1.2);
}

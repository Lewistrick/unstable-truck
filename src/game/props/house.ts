// Little cottage scenery prop for the town biome (distinct from the level's
// plain decorative `houses`, which are unadorned rectangles).
const ROOFS = ["#a4503a", "#8a6b3c", "#6f7c8a"]; // terracotta, thatch, slate

export function drawHouse(ctx: CanvasRenderingContext2D, variant: number): void {
  // Wall.
  ctx.fillStyle = "#e3d3b0";
  ctx.fillRect(-6, -1, 12, 10);
  // Pitched roof.
  ctx.fillStyle = ROOFS[variant % ROOFS.length]!;
  ctx.beginPath();
  ctx.moveTo(-8, -0.5);
  ctx.lineTo(0, -9);
  ctx.lineTo(8, -0.5);
  ctx.closePath();
  ctx.fill();
  // Door.
  ctx.fillStyle = "#7a4a2a";
  ctx.fillRect(-1.6, 3.5, 3.2, 5.5);
  // Window.
  ctx.fillStyle = "#a9d3e0";
  ctx.fillRect(2.2, 1, 2.8, 2.8);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(2.2, 1, 2.8, 2.8);
}

export function drawDeadbush(ctx: CanvasRenderingContext2D, variant: number): void {
  // Tangled ball of twigs: strands cross the interior at irregular (golden-
  // angle) headings through off-center control points, so it reads as a
  // tumbleweed rather than a spoked wheel.
  ctx.strokeStyle = "#b08a53";
  ctx.lineWidth = 0.9;
  ctx.lineCap = "round";
  const cx = 0;
  const cy = 3;
  const radius = 6;
  for (let i = 0; i < 9; i++) {
    const a = i * 2.399963 + variant * 0.9; // golden angle avoids symmetry
    const b = a + 1.7 + (i % 3) * 0.35;
    const r1 = radius * (0.75 + 0.25 * Math.abs(Math.sin(a * 3)));
    const r2 = radius * (0.75 + 0.25 * Math.abs(Math.sin(b * 2)));
    const mx = cx + Math.cos((a + b) / 2) * radius * 0.25;
    const my = cy + Math.sin((a + b) / 2) * radius * 0.25;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.quadraticCurveTo(mx, my, cx + Math.cos(b) * r2, cy + Math.sin(b) * r2);
    ctx.stroke();
  }
}

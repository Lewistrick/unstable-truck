export function drawCandycane(ctx: CanvasRenderingContext2D): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Centerline: straight stick, then the hooked top.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 8; i++) pts.push([2, 9 + (i / 8) * -13]); // (2,9) -> (2,-4)
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    const mt = 1 - t;
    pts.push([mt * mt * 2 + 2 * mt * t * 2 + t * t * -2, mt * mt * -4 + 2 * mt * t * -9 + t * t * -8]);
  }
  // Red body.
  ctx.strokeStyle = "#e8503a";
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.stroke();
  // Diagonal white stripes: short segments crossing the stick at a slant
  // (tangent rotated ~63 deg), spaced along the length.
  ctx.strokeStyle = "#f4f1ea";
  ctx.lineWidth = 1.5;
  const half = 1.9;
  for (let i = 1; i < pts.length - 1; i += 2) {
    const prev = pts[i - 1]!;
    const next = pts[i + 1]!;
    const cur = pts[i]!;
    const ang = Math.atan2(next[1] - prev[1], next[0] - prev[0]) + Math.PI * 0.35;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(cur[0] - dx * half, cur[1] - dy * half);
    ctx.lineTo(cur[0] + dx * half, cur[1] + dy * half);
    ctx.stroke();
  }
}

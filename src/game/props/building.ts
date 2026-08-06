import { randInt, randRange, type Rng } from "../../util/rng.js";

export function drawBuilding(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  // Size the building around a randomized window grid.
  const cols = randInt(rng, 2, 4);
  const rows = randInt(rng, 3, 7);
  const winW = randRange(rng, 1.4, 2.4);
  const winH = randRange(rng, 1.6, 2.8);
  const gapX = randRange(rng, 1.4, 2.2);
  const gapY = randRange(rng, 1.6, 2.4);
  const sideMargin = 2;
  const topMargin = 3; // clears the roof band
  const bottomMargin = 2;
  const bw = sideMargin * 2 + cols * winW + (cols - 1) * gapX;
  const bh = topMargin + bottomMargin + rows * winH + (rows - 1) * gapY;
  const left = -bw / 2;
  const top = 9 - bh;
  ctx.fillStyle = "#7a8494";
  ctx.fillRect(left, top, bw, bh);
  ctx.fillStyle = "#5f6875";
  ctx.fillRect(left, top, bw, 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = left + sideMargin + c * (winW + gapX);
      const wy = top + topMargin + r * (winH + gapY);
      ctx.fillStyle = rng() < 0.68 ? "rgba(255, 236, 180, 0.9)" : "rgba(40, 48, 58, 0.9)";
      ctx.fillRect(wx, wy, winW, winH);
    }
  }
}

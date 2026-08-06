import { randInt, randRange, type Rng } from "../../util/rng.js";

export function drawHaybale(ctx: CanvasRenderingContext2D, _variant: number, rng: Rng): void {
  const w = 15;
  const h = 10;
  const left = -w / 2;
  const top = 9 - h;
  // Solid rectangular bale.
  ctx.fillStyle = "#d8b45a";
  ctx.fillRect(left, top, w, h);
  // A soft darker band plus two twine ties for a baled look.
  ctx.fillStyle = "rgba(120, 90, 30, 0.16)";
  ctx.fillRect(left, top + h * 0.52, w, h * 0.14);
  ctx.strokeStyle = "rgba(90, 66, 24, 0.55)";
  ctx.lineWidth = 0.8;
  for (const tx of [left + w * 0.3, left + w * 0.7]) {
    ctx.beginPath();
    ctx.moveTo(tx, top);
    ctx.lineTo(tx, top + h);
    ctx.stroke();
  }
  // Loose straw wisps poking out of the top and side edges (random count and
  // lengths), so the bale reads as hay rather than a plain box.
  ctx.strokeStyle = "#e7cd82";
  ctx.lineWidth = 0.7;
  ctx.lineCap = "round";
  const wisps = randInt(rng, 8, 14);
  for (let i = 0; i < wisps; i++) {
    const edge = rng();
    let x: number;
    let y: number;
    let ox: number;
    let oy: number;
    if (edge < 0.6) {
      // Top edge -> poke upward.
      x = randRange(rng, left, left + w);
      y = top;
      ox = randRange(rng, -1.2, 1.2);
      oy = -randRange(rng, 1.5, 3.5);
    } else if (edge < 0.8) {
      // Left edge -> poke left.
      x = left;
      y = randRange(rng, top + 1, top + h - 1);
      ox = -randRange(rng, 1.5, 3);
      oy = randRange(rng, -1, 1);
    } else {
      // Right edge -> poke right.
      x = left + w;
      y = randRange(rng, top + 1, top + h - 1);
      ox = randRange(rng, 1.5, 3);
      oy = randRange(rng, -1, 1);
    }
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + ox, y + oy);
    ctx.stroke();
  }
}

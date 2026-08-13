import { mulberry32, seedFromString, type Rng } from "../util/rng.js";
import type { ThemeId } from "../level/themes.js";
import type { Level } from "../level/types.js";

// --- Biome map boundaries --------------------------------------------------
// Each biome fences its map edge in a fitting style: farmland gets a post-and-
// rail fence, grassland a hedge, beach a shoreline with sea beyond, and so on.
// The decoration is purely cosmetic - it never changes the play area (the truck
// is still clamped by the same bounds as before). Everything here is seeded from
// the level seed (never the generation RNG), so a given day's edges look
// identical every frame and on replay, but each seed varies size, spacing,
// jitter, wave length, and which planks have fallen off.
//
// Rendering is done per edge in a rotated local frame (x runs along the edge,
// +y points into the map, y<0 is out of bounds), so each style is authored once
// for a horizontal top edge and reused on all four sides. Only the on-screen
// span of each edge is drawn, so even the huge weekly map stays cheap.

export type BoundaryKind =
  | "hedge"
  | "fence"
  | "shore"
  | "cliff"
  | "crater"
  | "barrier"
  | "snowbank"
  | "candy"
  | "festive";

export interface BoundaryStyle {
  kind: BoundaryKind;
  /** Shore only: the water body filling the out-of-bounds area. */
  water?: string;
  /** Shore only: foam-line colour drawn over the water. */
  foam?: string;
  /** Cliff only: draw glowing lava seams along the lip (volcanic). */
  lava?: boolean;
}

/** The boundary style each biome uses. Several biomes share a style (tinted per
 * biome at draw time); a few have their own. Every ThemeId must appear here. */
export const BOUNDARY_STYLES: Record<ThemeId, BoundaryStyle> = {
  grassland: { kind: "hedge" },
  forest: { kind: "hedge" },
  easter: { kind: "hedge" },
  autumn: { kind: "hedge" },
  farmland: { kind: "fence" },
  town: { kind: "fence" },
  savanna: { kind: "fence" },
  beach: { kind: "shore", water: "hsl(200 60% 55%)", foam: "rgba(255, 255, 255, 0.6)" },
  swamp: { kind: "shore", water: "hsl(96 30% 26%)", foam: "rgba(210, 230, 180, 0.32)" },
  desert: { kind: "cliff" },
  volcanic: { kind: "cliff", lava: true },
  moon: { kind: "crater" },
  city: { kind: "barrier" },
  snow: { kind: "snowbank" },
  candy: { kind: "candy" },
  newyear: { kind: "festive" },
};

const SPACE_COLOR = "hsl(230 32% 8%)";

// How far (world units) an edge's decoration can reach beyond the map line; also
// the cull margin and the corner overlap so adjacent edges meet cleanly.
const BAND = 90;
const OVERLAP = 26;

// --- Colour helpers --------------------------------------------------------

function parseHsl(color: string): { h: number; s: number; l: number } {
  const m = color.match(/hsl\(\s*([\d.-]+)\s+([\d.]+)%\s+([\d.]+)%/);
  return m ? { h: parseFloat(m[1]!), s: parseFloat(m[2]!), l: parseFloat(m[3]!) } : { h: 0, s: 0, l: 50 };
}

function hsl(h: number, s: number, l: number): string {
  const H = ((h % 360) + 360) % 360;
  return `hsl(${H.toFixed(0)} ${Math.max(0, Math.min(100, s)).toFixed(0)}% ${Math.max(0, Math.min(100, l)).toFixed(0)}%)`;
}

function shift(color: string, ds: number, dl: number): string {
  const p = parseHsl(color);
  return hsl(p.h, p.s + ds, p.l + dl);
}

/** The colour filling the area beyond the map edge for a level's biome: sea for
 * beaches, murky water for swamps, space for the moon, a dark chasm for cliffs,
 * and the ordinary grass colour everywhere else. */
export function beyondFill(level: Level): string {
  const style = BOUNDARY_STYLES[level.theme];
  switch (style.kind) {
    case "shore":
      return style.water!;
    case "crater":
      return SPACE_COLOR;
    case "cliff": {
      const r = parseHsl(level.palette.rock);
      return hsl(r.h, Math.min(60, r.s + 6), Math.max(6, r.l * 0.42));
    }
    default:
      return level.palette.grass;
  }
}

// --- Geometry helpers ------------------------------------------------------

export interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Position-keyed RNG: stable per (seed, tag), independent of the generation
 * stream, so decoration is identical every frame and only depends on the seed. */
function keyRng(seed: string, tag: string): Rng {
  return mulberry32(seedFromString(`${seed}#bnd#${tag}`));
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

type LocalDrawer = (ctx: CanvasRenderingContext2D, x0: number, x1: number, len: number, edge: number) => void;

/** Runs `draw` once per map edge in a local frame where x runs along the edge
 * (0..edge length), +y points into the map and y<0 is out of bounds. Skips
 * edges that are off screen and clips the drawn span to the visible range (plus
 * a corner overlap so neighbouring edges join up). */
function withEdges(ctx: CanvasRenderingContext2D, level: Level, vb: ViewRect, draw: LocalDrawer): void {
  const { width: W, height: H } = level;
  const edges = [
    { i: 0, a: 0, tx: 0, ty: 0, len: W },
    { i: 1, a: Math.PI / 2, tx: W, ty: 0, len: H },
    { i: 2, a: Math.PI, tx: W, ty: H, len: W },
    { i: 3, a: -Math.PI / 2, tx: 0, ty: H, len: H },
  ];
  for (const e of edges) {
    const cos = Math.cos(e.a);
    const sin = Math.sin(e.a);
    let lxMin = Infinity;
    let lxMax = -Infinity;
    let lyMin = Infinity;
    let lyMax = -Infinity;
    for (const [X, Y] of [
      [vb.minX, vb.minY],
      [vb.maxX, vb.minY],
      [vb.minX, vb.maxY],
      [vb.maxX, vb.maxY],
    ] as const) {
      const dx = X - e.tx;
      const dy = Y - e.ty;
      const lx = dx * cos + dy * sin; // inverse rotation (R(-a))
      const ly = -dx * sin + dy * cos;
      lxMin = Math.min(lxMin, lx);
      lxMax = Math.max(lxMax, lx);
      lyMin = Math.min(lyMin, ly);
      lyMax = Math.max(lyMax, ly);
    }
    if (lyMax < -BAND || lyMin > BAND) continue; // this edge's band isn't visible
    const x0 = Math.max(-OVERLAP, lxMin - BAND);
    const x1 = Math.min(e.len + OVERLAP, lxMax + BAND);
    if (x1 <= x0) continue;
    ctx.save();
    ctx.translate(e.tx, e.ty);
    ctx.rotate(e.a);
    draw(ctx, x0, x1, e.len, e.i);
    ctx.restore();
  }
}

// --- Circular styles (hedge / crater rim / snowbank) -----------------------
// A lumpy line of overlapping discs whose radius and offset-from-the-edge both
// vary per disc, over a solid core band so the gaps read as one continuous wall.

const DISC_SPACING = 30;
const DISC_R0 = 15;
const DISC_RVAR = 12;
const DISC_PERP = 12; // perpendicular (offset-to-edge) jitter
const DISC_TANG = 8; // along-edge jitter

function drawCircularEdge(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  edge: number,
  level: Level,
  tag: string,
  coreW: number,
  body: string,
  highlight: string,
  shadow: string | null,
  stars: boolean,
): void {
  ctx.fillStyle = body;
  ctx.fillRect(x0, -coreW / 2, x1 - x0, coreW);
  const from = Math.floor(x0 / DISC_SPACING);
  const to = Math.ceil(x1 / DISC_SPACING);
  for (let i = from; i <= to; i++) {
    const rng = keyRng(level.seed, `${tag}:${edge}:${i}`);
    const r = DISC_R0 + rng() * DISC_RVAR;
    const along = i * DISC_SPACING + (rng() - 0.5) * DISC_TANG;
    const perp = (rng() - 0.5) * DISC_PERP;
    if (stars) {
      // A couple of faint stars out in the void near this rock.
      disc(ctx, along + (rng() - 0.5) * 24, -coreW / 2 - 6 - rng() * (BAND - 20), rng() < 0.5 ? 1.5 : 0.9, "rgba(255,255,255,0.8)");
    }
    if (along < x0 - r || along > x1 + r) continue;
    if (shadow) disc(ctx, along + 2, perp + 3, r, shadow);
    disc(ctx, along, perp, r, body);
    disc(ctx, along - r * 0.3, perp - r * 0.34, r * 0.42, highlight);
  }
}

// --- Post-and-rail fence ---------------------------------------------------

const FENCE_POST_SPACING = 64;

function drawFenceEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, edge: number, level: Level): void {
  const wood = "#8a5e36";
  const dark = "#6f4a29";
  ctx.fillStyle = wood;
  ctx.fillRect(x0, -11, x1 - x0, 4);
  ctx.fillRect(x0, -4, x1 - x0, 4);
  ctx.fillStyle = dark;
  for (let i = Math.floor(x0 / FENCE_POST_SPACING); i <= Math.ceil(x1 / FENCE_POST_SPACING); i++) {
    const bx = i * FENCE_POST_SPACING;
    if (bx < x0 - 8 || bx > x1 + 8) continue;
    ctx.fillRect(bx - 6, -16, 12, 26);
  }
  // Fallen-off planks: some rail sections drop just inside the fence line.
  const step = 18;
  for (let i = Math.floor(x0 / step); i <= Math.ceil(x1 / step); i++) {
    const rng = keyRng(level.seed, `fence:${edge}:${i}`);
    if (rng() >= 0.12) continue;
    const bx = i * step;
    if (bx < x0 || bx > x1) continue;
    ctx.save();
    ctx.translate(bx, 8 + rng() * 18);
    ctx.rotate((rng() - 0.5) * 1.8);
    ctx.fillStyle = wood;
    ctx.fillRect(-15, -3, 30, 6);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(-15, -3, 30, 1.6);
    ctx.restore();
  }
}

// --- Shoreline -------------------------------------------------------------
// The straight sand edge is broken into a wavy shore (two summed sine waves of
// different wavelengths), with sand tongues reaching into the water and water
// tongues biting into the sand, a wet-sand rim, and foam lines out in the sea.

function drawShoreEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, edge: number, level: Level, style: BoundaryStyle): void {
  const rng = keyRng(level.seed, `shore:${edge}`);
  const wl1 = 110 + rng() * 80;
  const a1 = 8 + rng() * 7;
  const p1 = rng() * Math.PI * 2;
  const wl2 = 41 + rng() * 30;
  const a2 = 4 + rng() * 4;
  const p2 = rng() * Math.PI * 2;
  const amp = a1 + a2 + 2;
  const step = 6;
  const waveAt = (x: number): number => -(Math.sin(x / wl1 + p1) * a1 + Math.sin(x / wl2 + p2) * a2);
  const sand = level.palette.grass;
  const water = style.water!;
  const wet = shift(sand, 4, -12);

  // Sand from the wave inward; then water from the wave outward. Their shared
  // border is the wave line, so together they carve the wavy shore.
  ctx.beginPath();
  ctx.moveTo(x0, amp);
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, waveAt(x));
  ctx.lineTo(x1, amp);
  ctx.closePath();
  ctx.fillStyle = sand;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x0, -amp - 60);
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, waveAt(x));
  ctx.lineTo(x1, -amp - 60);
  ctx.closePath();
  ctx.fillStyle = water;
  ctx.fill();

  ctx.strokeStyle = wet;
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += step) {
    const y = waveAt(x);
    x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = style.foam!;
  ctx.lineWidth = 2;
  for (const off of [amp + 12, amp + 28]) {
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) {
      const y = -off + Math.sin(x / wl2 + p2) * a2;
      x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// --- Rock ledge / cliff ----------------------------------------------------
// A rock lip along the inside of the edge with a randomly jagged inner border;
// the drop (out of bounds) is the dark chasm from beyondFill(). Veins/shadows
// always point outward, into the chasm.

const CLIFF_LEDGE = 22;

function drawCliffEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, edge: number, level: Level, style: BoundaryStyle): void {
  const rock = shift(level.palette.rock, 0, 10);
  const shadow = shift(level.palette.rock, 0, -16);
  const vein = shift(level.palette.rock, -6, 26);
  const step = 24;
  const jag = (x: number): number => {
    const rng = keyRng(level.seed, `cliff:${edge}:${Math.round(x / step)}`);
    return CLIFF_LEDGE + (rng() * 16 - 6);
  };

  ctx.beginPath();
  ctx.moveTo(x0, -3);
  ctx.lineTo(x1, -3);
  for (let x = x1; x >= x0; x -= step) ctx.lineTo(x, jag(x));
  ctx.closePath();
  ctx.fillStyle = rock;
  ctx.fill();

  ctx.strokeStyle = shadow;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += step) {
    const y = jag(x);
    x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Veins pointing outward into the chasm.
  ctx.strokeStyle = vein;
  ctx.lineWidth = 1.5;
  const vstep = 16;
  for (let i = Math.floor(x0 / vstep); i <= Math.ceil(x1 / vstep); i++) {
    const bx = i * vstep;
    if (bx < x0 || bx > x1) continue;
    const rng = keyRng(level.seed, `cvein:${edge}:${i}`);
    ctx.beginPath();
    ctx.moveTo(bx, -2);
    ctx.lineTo(bx + (rng() - 0.5) * 8, -2 - (6 + rng() * 12));
    ctx.stroke();
  }

  if (style.lava) {
    ctx.strokeStyle = "rgba(255, 110, 40, 0.85)";
    ctx.lineWidth = 2;
    const ls = 60;
    for (let i = Math.floor(x0 / ls); i <= Math.ceil(x1 / ls); i++) {
      const bx = i * ls;
      if (bx < x0 || bx > x1) continue;
      ctx.beginPath();
      ctx.moveTo(bx - 8, -1);
      ctx.lineTo(bx + 6, -1);
      ctx.stroke();
    }
  }
}

// --- Concrete barrier ------------------------------------------------------

function drawBarrierEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number): void {
  const w = x1 - x0;
  for (let x = Math.floor(x0 / 16) * 16; x < x1; x += 16) {
    const left = Math.max(x, x0);
    ctx.fillStyle = (x / 16) & 1 ? "#1c1f24" : "#f2c14e";
    ctx.fillRect(left, -16, Math.min(x + 16, x1) - left, 4);
  }
  ctx.fillStyle = "#c2c6cc";
  ctx.fillRect(x0, -9, w, 18);
  ctx.fillStyle = "#dfe2e6";
  ctx.fillRect(x0, -9, w, 3);
  ctx.fillStyle = "#7c8088";
  ctx.fillRect(x0, 6, w, 3);
  ctx.fillStyle = "#8f939a";
  for (let i = Math.floor(x0 / 60); i <= Math.ceil(x1 / 60); i++) {
    const bx = i * 60;
    if (bx < x0 || bx > x1) continue;
    ctx.fillRect(bx, -9, 2, 18);
  }
}

// --- Festive barricade -----------------------------------------------------

function drawFestiveEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, edge: number, level: Level): void {
  const w = x1 - x0;
  ctx.fillStyle = "#f2f4f8";
  ctx.fillRect(x0, -6, w, 12);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, -6, w, 12);
  ctx.clip();
  ctx.strokeStyle = "#e8801f";
  ctx.lineWidth = 8;
  for (let x = Math.floor(x0 / 24) * 24 - 20; x < x1 + 20; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x + 16, -8);
    ctx.stroke();
  }
  ctx.restore();

  const rng = keyRng(level.seed, `fest:${edge}`);
  const wl1 = 90 + rng() * 60;
  const a1 = 6 + rng() * 5;
  const p1 = rng() * Math.PI * 2;
  const wl2 = 33 + rng() * 20;
  const a2 = 3 + rng() * 3;
  const p2 = rng() * Math.PI * 2;
  const garland = (x: number): number => -20 - (Math.sin(x / wl1 + p1) * a1 + Math.sin(x / wl2 + p2) * a2);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 5) {
    const y = garland(x);
    x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  const cols = ["#ffd54a", "#ff5a4a", "#4ad06a", "#4aa8ff"];
  const s = 22;
  for (let i = Math.floor(x0 / s); i <= Math.ceil(x1 / s); i++) {
    const bx = i * s;
    if (bx < x0 || bx > x1) continue;
    disc(ctx, bx, garland(bx), 3, cols[((i % 4) + 4) % 4]!);
  }
}

// --- Candy-cane fence ------------------------------------------------------
// Upright candy-cane posts (drawn in world space, always standing up like the
// game's other props), zig-zagged perpendicular to the edge so neighbours never
// overlap, on a pink rail.

function candyCane(ctx: CanvasRenderingContext2D, cx: number, cy: number, alt: boolean): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = "#fff";
  ctx.fillRect(-4, -16, 8, 32);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-4, -16, 8, 32);
  ctx.clip();
  ctx.strokeStyle = "#e2536f";
  ctx.lineWidth = 3;
  for (let o = -20; o < 34; o += 8) {
    ctx.beginPath();
    ctx.moveTo(-6, -16 + o + 8);
    ctx.lineTo(6, -16 + o);
    ctx.stroke();
  }
  ctx.restore();
  disc(ctx, 0, -18, 5, alt ? "#e2536f" : "#7cc5e8");
  ctx.restore();
}

function candyLine(ctx: CanvasRenderingContext2D, horiz: boolean, fixed: number, along: number, min: number, max: number): void {
  const s = 56;
  for (let i = Math.floor((min - 40) / s); i <= Math.ceil((max + 40) / s); i++) {
    const t = i * s;
    if (t < 0 || t > along) continue;
    const alt = (i & 1) === 1;
    if (horiz) candyCane(ctx, t, fixed + (alt ? 6 : -6), alt);
    else candyCane(ctx, fixed + (alt ? 12 : -4), t, alt);
  }
}

function drawCandy(ctx: CanvasRenderingContext2D, level: Level, vb: ViewRect): void {
  const { width: W, height: H } = level;
  const rail = "#ffd6e6";
  const vx0 = Math.max(0, vb.minX);
  const vx1 = Math.min(W, vb.maxX);
  const vy0 = Math.max(0, vb.minY);
  const vy1 = Math.min(H, vb.maxY);
  ctx.fillStyle = rail;
  if (vb.minY <= BAND && vx1 > vx0) {
    ctx.fillRect(vx0, -2, vx1 - vx0, 6);
    candyLine(ctx, true, 0, W, vx0, vx1);
  }
  if (vb.maxY >= H - BAND && vx1 > vx0) {
    ctx.fillStyle = rail;
    ctx.fillRect(vx0, H - 4, vx1 - vx0, 6);
    candyLine(ctx, true, H, W, vx0, vx1);
  }
  if (vb.minX <= BAND && vy1 > vy0) {
    ctx.fillStyle = rail;
    ctx.fillRect(-2, vy0, 6, vy1 - vy0);
    candyLine(ctx, false, 0, H, vy0, vy1);
  }
  if (vb.maxX >= W - BAND && vy1 > vy0) {
    ctx.fillStyle = rail;
    ctx.fillRect(W - 4, vy0, 6, vy1 - vy0);
    candyLine(ctx, false, W, H, vy0, vy1);
  }
}

/** Draws the biome's decorative map boundary around every visible edge/corner,
 * culled to `vb` (the visible world rect). Call inside the world transform. */
export function drawBoundary(ctx: CanvasRenderingContext2D, level: Level, vb: ViewRect): void {
  const style = BOUNDARY_STYLES[level.theme];
  switch (style.kind) {
    case "hedge": {
      const foliage = shift(level.palette.grass, 16, -34);
      const highlight = shift(level.palette.grass, 6, 8);
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) =>
        drawCircularEdge(c, x0, x1, e, level, "hedge", 26, foliage, highlight, null, false),
      );
      break;
    }
    case "crater": {
      const body = shift(level.palette.rock, 0, 0);
      const highlight = shift(level.palette.rock, -2, 22);
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) =>
        drawCircularEdge(c, x0, x1, e, level, "crater", 22, body, highlight, null, true),
      );
      break;
    }
    case "snowbank":
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) =>
        drawCircularEdge(c, x0, x1, e, level, "snow", 24, "#ffffff", "#f4f9ff", "#c3d6e8", false),
      );
      break;
    case "fence":
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) => drawFenceEdge(c, x0, x1, e, level));
      break;
    case "shore":
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) => drawShoreEdge(c, x0, x1, e, level, style));
      break;
    case "cliff":
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) => drawCliffEdge(c, x0, x1, e, level, style));
      break;
    case "barrier":
      withEdges(ctx, level, vb, (c, x0, x1) => drawBarrierEdge(c, x0, x1));
      break;
    case "festive":
      withEdges(ctx, level, vb, (c, x0, x1, _l, e) => drawFestiveEdge(c, x0, x1, e, level));
      break;
    case "candy":
      drawCandy(ctx, level, vb);
      break;
  }
}

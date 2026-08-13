import { mulberry32, seedFromString, type Rng } from "../util/rng.js";
import type { ThemeId } from "../level/themes.js";
import type { Level } from "../level/types.js";

// --- Biome map boundaries --------------------------------------------------
// Each biome fences its map edge in a fitting style: farmland gets a post-and-
// rail fence, grassland a hedge, beach a shoreline with sea beyond, and so on.
// The decoration is purely cosmetic - it never changes the play area (the truck
// is still clamped by the same bounds as before).
//
// The full-perimeter geometry (every disc size/offset, jagged vertex, fallen
// plank, wave, light) is computed ONCE per level from the level seed - never the
// generation RNG - and cached, so it's identical every frame and on replay and
// costs nothing to keep still. Each frame just draws the cached geometry, culled
// to the visible edges, so even the huge weekly map only pays for what's on
// screen. Styles are authored once for a horizontal top edge and reused on all
// four sides via a rotated local frame (x runs along the edge, +y points into
// the map, y<0 is out of bounds).

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
 * biome at build time); a few have their own. Every ThemeId must appear here. */
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

// --- Precomputed geometry --------------------------------------------------

export interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Disc {
  a: number; // along the edge
  p: number; // perpendicular offset (+ = into map)
  r: number;
}
interface Star {
  a: number;
  p: number;
  r: number;
}
interface Plank {
  a: number;
  p: number;
  ang: number;
}
interface RailSeg {
  a: number;
  w: number;
}
interface Vein {
  a: number;
  y: number;
  dx: number;
  dy: number;
}
interface Wave {
  wl1: number;
  a1: number;
  p1: number;
  wl2: number;
  a2: number;
  p2: number;
}
interface Light {
  a: number;
  ci: number;
}

interface EdgeGeom {
  discs?: Disc[];
  stars?: Star[];
  posts?: number[];
  rails?: RailSeg[];
  planks?: Plank[];
  jag?: number[];
  veins?: Vein[];
  lava?: number[];
  wave?: Wave;
  lights?: Light[];
}
interface Pole {
  x: number;
  y: number;
  alt: boolean;
}
interface BoundaryColors {
  body?: string;
  hi?: string;
  shadow?: string;
  coreW?: number;
  sand?: string;
  wet?: string;
  water?: string;
  foam?: string;
  rock?: string;
  vein?: string;
}
interface BoundaryGeom {
  kind: BoundaryKind;
  edges: EdgeGeom[]; // one per side: 0 top, 1 right, 2 bottom, 3 left
  poles: Pole[]; // candy only
  colors: BoundaryColors;
}

const geomCache = new WeakMap<Level, BoundaryGeom>();

/** Position-keyed RNG: stable per (seed, tag), independent of the generation
 * stream. Only used at build time. */
function keyRng(seed: string, tag: string): Rng {
  return mulberry32(seedFromString(`${seed}#bnd#${tag}`));
}

// Layout constants (world units, tuned against the ~2000-wide daily map).
const DISC_SPACING = 30;
const DISC_R0 = 15;
const DISC_RVAR = 12;
const DISC_PERP = 12;
const DISC_TANG = 8;
const FENCE_POST_SPACING = 64;
const FENCE_SEG = 22;
const FENCE_BREAK = 0.11;
const CLIFF_LEDGE = 22;
const CLIFF_STEP = 24;
const CLIFF_VEIN = 16;
const CANDY_SPACING = 56;
const FEST_LIGHT = 22;
const CORE_W: Record<string, number> = { hedge: 26, crater: 22, snow: 24 };

function buildDiscs(seed: string, tag: string, edge: number, len: number): Disc[] {
  const out: Disc[] = [];
  const n = Math.ceil(len / DISC_SPACING);
  for (let i = 0; i <= n; i++) {
    const rng = keyRng(seed, `${tag}:${edge}:${i}`);
    out.push({
      r: DISC_R0 + rng() * DISC_RVAR,
      a: i * DISC_SPACING + (rng() - 0.5) * DISC_TANG,
      p: (rng() - 0.5) * DISC_PERP,
    });
  }
  return out;
}

function buildStars(seed: string, edge: number, len: number, coreW: number): Star[] {
  const out: Star[] = [];
  const n = Math.ceil(len / DISC_SPACING);
  for (let i = 0; i <= n; i++) {
    const rng = keyRng(seed, `star:${edge}:${i}`);
    out.push({
      a: i * DISC_SPACING + (rng() - 0.5) * 24,
      p: -coreW / 2 - 6 - rng() * (BAND - 20),
      r: rng() < 0.5 ? 1.5 : 0.9,
    });
  }
  return out;
}

function buildFence(seed: string, edge: number, len: number): EdgeGeom {
  const posts: number[] = [];
  for (let i = 0; i * FENCE_POST_SPACING <= len; i++) posts.push(i * FENCE_POST_SPACING);
  const rails: RailSeg[] = [];
  const planks: Plank[] = [];
  const n = Math.ceil(len / FENCE_SEG);
  for (let i = 0; i <= n; i++) {
    const rng = keyRng(seed, `fence:${edge}:${i}`);
    const a = i * FENCE_SEG;
    if (rng() < FENCE_BREAK) {
      // A broken section: leave a gap in the rail and drop the plank inside.
      planks.push({ a: a + FENCE_SEG / 2, p: 8 + rng() * 18, ang: (rng() - 0.5) * 1.8 });
    } else {
      rails.push({ a, w: FENCE_SEG - 3 });
    }
  }
  return { posts, rails, planks };
}

function buildCliff(seed: string, style: BoundaryStyle, edge: number, len: number): EdgeGeom {
  const jag: number[] = [];
  const cells = Math.ceil(len / CLIFF_STEP) + 1;
  for (let i = 0; i <= cells; i++) {
    const rng = keyRng(seed, `cliff:${edge}:${i}`);
    jag.push(CLIFF_LEDGE + (rng() * 16 - 6));
  }
  // Veins sit ON the rock ledge (inside the ledge band, y in [~4, LEDGE-2]) so
  // they read as cracks on the rock face rather than floating in the chasm.
  const veins: Vein[] = [];
  for (let i = 0; i * CLIFF_VEIN <= len; i++) {
    const rng = keyRng(seed, `cvein:${edge}:${i}`);
    veins.push({ a: i * CLIFF_VEIN, y: 4 + rng() * 4, dx: (rng() - 0.5) * 8, dy: 6 + rng() * 8 });
  }
  const lava: number[] | undefined = style.lava ? [] : undefined;
  if (lava) for (let i = 0; i * 60 <= len; i++) lava.push(i * 60);
  return { jag, veins, lava };
}

function buildWave(seed: string, tag: string, edge: number, base: number): Wave {
  const rng = keyRng(seed, `${tag}:${edge}`);
  return {
    wl1: base + rng() * (base * 0.7),
    a1: 8 + rng() * 7,
    p1: rng() * Math.PI * 2,
    wl2: base * 0.37 + rng() * (base * 0.27),
    a2: 4 + rng() * 4,
    p2: rng() * Math.PI * 2,
  };
}

function buildFestive(seed: string, edge: number, len: number): EdgeGeom {
  const lights: Light[] = [];
  for (let i = 0; i * FEST_LIGHT <= len; i++) lights.push({ a: i * FEST_LIGHT, ci: ((i % 4) + 4) % 4 });
  return { wave: buildWave(seed, "fest", edge, 90), lights };
}

function buildPoles(level: Level): Pole[] {
  const { width: W, height: H } = level;
  const out: Pole[] = [];
  const line = (horiz: boolean, fixed: number, along: number): void => {
    for (let i = 0; i * CANDY_SPACING <= along; i++) {
      const t = i * CANDY_SPACING;
      const alt = (i & 1) === 1;
      if (horiz) out.push({ x: t, y: fixed + (alt ? 6 : -6), alt });
      else out.push({ x: fixed + (alt ? 12 : -4), y: t, alt });
    }
  };
  line(true, 0, W);
  line(true, H, W);
  line(false, 0, H);
  line(false, W, H);
  return out;
}

/** Precomputes the whole-perimeter boundary geometry for a level, purely from
 * its seed and dimensions (never the camera). Exported for the determinism
 * check; callers should use drawBoundary, which caches this per level. */
export function buildBoundaryGeometry(level: Level): BoundaryGeom {
  const style = BOUNDARY_STYLES[level.theme];
  const { width: W, height: H } = level;
  const lens = [W, H, W, H];
  const edges: EdgeGeom[] = [{}, {}, {}, {}];
  const colors: BoundaryColors = {};
  const seed = level.seed;

  switch (style.kind) {
    case "hedge":
      colors.body = shift(level.palette.grass, 16, -34);
      colors.hi = shift(level.palette.grass, 6, 8);
      colors.coreW = CORE_W.hedge;
      for (let e = 0; e < 4; e++) edges[e] = { discs: buildDiscs(seed, "hedge", e, lens[e]!) };
      break;
    case "crater":
      colors.body = level.palette.rock;
      colors.hi = shift(level.palette.rock, -2, 22);
      colors.coreW = CORE_W.crater;
      for (let e = 0; e < 4; e++)
        edges[e] = { discs: buildDiscs(seed, "crater", e, lens[e]!), stars: buildStars(seed, e, lens[e]!, CORE_W.crater!) };
      break;
    case "snowbank":
      colors.body = "#ffffff";
      colors.hi = "#f4f9ff";
      colors.shadow = "#c3d6e8";
      colors.coreW = CORE_W.snow;
      for (let e = 0; e < 4; e++) edges[e] = { discs: buildDiscs(seed, "snow", e, lens[e]!) };
      break;
    case "fence":
      for (let e = 0; e < 4; e++) edges[e] = buildFence(seed, e, lens[e]!);
      break;
    case "shore":
      colors.sand = level.palette.grass;
      colors.wet = shift(level.palette.grass, 4, -12);
      colors.water = style.water!;
      colors.foam = style.foam!;
      for (let e = 0; e < 4; e++) edges[e] = { wave: buildWave(seed, "shore", e, 110) };
      break;
    case "cliff":
      colors.rock = shift(level.palette.rock, 0, 10);
      colors.shadow = shift(level.palette.rock, 0, -16);
      colors.vein = shift(level.palette.rock, -6, 26);
      for (let e = 0; e < 4; e++) edges[e] = buildCliff(seed, style, e, lens[e]!);
      break;
    case "festive":
      for (let e = 0; e < 4; e++) edges[e] = buildFestive(seed, e, lens[e]!);
      break;
    case "barrier":
    case "candy":
      break; // no per-edge randomness
  }

  return { kind: style.kind, edges, poles: style.kind === "candy" ? buildPoles(level) : [], colors };
}

function getGeom(level: Level): BoundaryGeom {
  let g = geomCache.get(level);
  if (!g) {
    g = buildBoundaryGeometry(level);
    geomCache.set(level, g);
  }
  return g;
}

// --- Drawing ---------------------------------------------------------------

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

type LocalDrawer = (ctx: CanvasRenderingContext2D, x0: number, x1: number, edge: number) => void;

/** Runs `draw` once per map edge in a local frame where x runs along the edge,
 * +y points into the map and y<0 is out of bounds. Skips edges that are off
 * screen and clips the drawn span to the visible range (plus a corner overlap). */
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
      const lx = dx * cos + dy * sin; // inverse rotation R(-a)
      const ly = -dx * sin + dy * cos;
      lxMin = Math.min(lxMin, lx);
      lxMax = Math.max(lxMax, lx);
      lyMin = Math.min(lyMin, ly);
      lyMax = Math.max(lyMax, ly);
    }
    if (lyMax < -BAND || lyMin > BAND) continue;
    const x0 = Math.max(-OVERLAP, lxMin - BAND);
    const x1 = Math.min(e.len + OVERLAP, lxMax + BAND);
    if (x1 <= x0) continue;
    ctx.save();
    ctx.translate(e.tx, e.ty);
    ctx.rotate(e.a);
    draw(ctx, x0, x1, e.i);
    ctx.restore();
  }
}

function drawDiscEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, geom: BoundaryGeom, edge: number): void {
  const { body, hi, shadow, coreW } = geom.colors;
  ctx.fillStyle = body!;
  ctx.fillRect(x0, -coreW! / 2, x1 - x0, coreW!);
  const eg = geom.edges[edge]!;
  if (eg.stars) {
    for (const s of eg.stars) {
      if (s.a < x0 - 2 || s.a > x1 + 2) continue;
      disc(ctx, s.a, s.p, s.r, "rgba(255,255,255,0.8)");
    }
  }
  for (const d of eg.discs!) {
    if (d.a < x0 - d.r || d.a > x1 + d.r) continue;
    if (shadow) disc(ctx, d.a + 2, d.p + 3, d.r, shadow);
    disc(ctx, d.a, d.p, d.r, body!);
    disc(ctx, d.a - d.r * 0.3, d.p - d.r * 0.34, d.r * 0.42, hi!);
  }
}

function drawFenceEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, geom: BoundaryGeom, edge: number): void {
  const wood = "#8a5e36";
  const dark = "#6f4a29";
  const eg = geom.edges[edge]!;
  ctx.fillStyle = wood;
  for (const r of eg.rails!) {
    if (r.a + r.w < x0 || r.a > x1) continue;
    ctx.fillRect(r.a, -11, r.w, 4);
    ctx.fillRect(r.a, -4, r.w, 4);
  }
  ctx.fillStyle = dark;
  for (const a of eg.posts!) {
    if (a < x0 - 8 || a > x1 + 8) continue;
    ctx.fillRect(a - 6, -16, 12, 26);
  }
  for (const p of eg.planks!) {
    if (p.a < x0 - 20 || p.a > x1 + 20) continue;
    ctx.save();
    ctx.translate(p.a, p.p);
    ctx.rotate(p.ang);
    ctx.fillStyle = wood;
    ctx.fillRect(-15, -3, 30, 6);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(-15, -3, 30, 1.6);
    ctx.restore();
  }
}

function drawShoreEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, geom: BoundaryGeom, edge: number): void {
  const w = geom.edges[edge]!.wave!;
  const { sand, wet, water, foam } = geom.colors;
  const amp = w.a1 + w.a2 + 2;
  const step = 6;
  const waveAt = (x: number): number => -(Math.sin(x / w.wl1 + w.p1) * w.a1 + Math.sin(x / w.wl2 + w.p2) * w.a2);

  ctx.beginPath();
  ctx.moveTo(x0, amp);
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, waveAt(x));
  ctx.lineTo(x1, amp);
  ctx.closePath();
  ctx.fillStyle = sand!;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x0, -amp - 60);
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, waveAt(x));
  ctx.lineTo(x1, -amp - 60);
  ctx.closePath();
  ctx.fillStyle = water!;
  ctx.fill();

  ctx.strokeStyle = wet!;
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += step) {
    const y = waveAt(x);
    x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = foam!;
  ctx.lineWidth = 2;
  for (const off of [amp + 12, amp + 28]) {
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) {
      const y = -off + Math.sin(x / w.wl2 + w.p2) * w.a2;
      x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawCliffEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, geom: BoundaryGeom, edge: number): void {
  const eg = geom.edges[edge]!;
  const jag = eg.jag!;
  const { rock, shadow, vein } = geom.colors;
  const i0 = Math.max(0, Math.floor(x0 / CLIFF_STEP));
  const i1 = Math.min(jag.length - 1, Math.ceil(x1 / CLIFF_STEP));
  if (i1 > i0) {
    ctx.beginPath();
    ctx.moveTo(i0 * CLIFF_STEP, -3);
    ctx.lineTo(i1 * CLIFF_STEP, -3);
    for (let i = i1; i >= i0; i--) ctx.lineTo(i * CLIFF_STEP, jag[i]!);
    ctx.closePath();
    ctx.fillStyle = rock!;
    ctx.fill();
    ctx.strokeStyle = shadow!;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const y = jag[i]!;
      i === i0 ? ctx.moveTo(i * CLIFF_STEP, y) : ctx.lineTo(i * CLIFF_STEP, y);
    }
    ctx.stroke();
  }
  // Veins/cracks on the rock ledge itself (inside the ledge, not out in the void).
  ctx.strokeStyle = vein!;
  ctx.lineWidth = 1.5;
  for (const v of eg.veins!) {
    if (v.a < x0 || v.a > x1) continue;
    ctx.beginPath();
    ctx.moveTo(v.a, v.y);
    ctx.lineTo(v.a + v.dx, v.y + v.dy);
    ctx.stroke();
  }
  if (eg.lava) {
    ctx.strokeStyle = "rgba(255, 110, 40, 0.85)";
    ctx.lineWidth = 2;
    for (const a of eg.lava) {
      if (a < x0 || a > x1) continue;
      ctx.beginPath();
      ctx.moveTo(a - 6, 4);
      ctx.lineTo(a + 5, 9);
      ctx.stroke();
    }
  }
}

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

function drawFestiveEdge(ctx: CanvasRenderingContext2D, x0: number, x1: number, geom: BoundaryGeom, edge: number): void {
  const eg = geom.edges[edge]!;
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

  const g = eg.wave!;
  const garland = (x: number): number => -20 - (Math.sin(x / g.wl1 + g.p1) * g.a1 + Math.sin(x / g.wl2 + g.p2) * g.a2);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 5) {
    const y = garland(x);
    x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  const cols = ["#ffd54a", "#ff5a4a", "#4ad06a", "#4aa8ff"];
  for (const l of eg.lights!) {
    if (l.a < x0 || l.a > x1) continue;
    disc(ctx, l.a, garland(l.a), 3, cols[l.ci]!);
  }
}

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

function drawCandy(ctx: CanvasRenderingContext2D, geom: BoundaryGeom, level: Level, vb: ViewRect): void {
  const { width: W, height: H } = level;
  const vx0 = Math.max(0, vb.minX);
  const vx1 = Math.min(W, vb.maxX);
  const vy0 = Math.max(0, vb.minY);
  const vy1 = Math.min(H, vb.maxY);
  ctx.fillStyle = "#ffd6e6";
  if (vb.minY <= BAND && vx1 > vx0) ctx.fillRect(vx0, -2, vx1 - vx0, 6);
  if (vb.maxY >= H - BAND && vx1 > vx0) ctx.fillRect(vx0, H - 4, vx1 - vx0, 6);
  if (vb.minX <= BAND && vy1 > vy0) ctx.fillRect(-2, vy0, 6, vy1 - vy0);
  if (vb.maxX >= W - BAND && vy1 > vy0) ctx.fillRect(W - 4, vy0, 6, vy1 - vy0);
  for (const p of geom.poles) {
    if (p.x < vb.minX - 20 || p.x > vb.maxX + 20 || p.y < vb.minY - 24 || p.y > vb.maxY + 24) continue;
    candyCane(ctx, p.x, p.y, p.alt);
  }
}

/** Draws the biome's decorative map boundary around every visible edge/corner,
 * from the level's cached geometry, culled to `vb` (the visible world rect).
 * Call inside the world transform. */
export function drawBoundary(ctx: CanvasRenderingContext2D, level: Level, vb: ViewRect): void {
  const geom = getGeom(level);
  switch (geom.kind) {
    case "hedge":
    case "crater":
    case "snowbank":
      withEdges(ctx, level, vb, (c, x0, x1, e) => drawDiscEdge(c, x0, x1, geom, e));
      break;
    case "fence":
      withEdges(ctx, level, vb, (c, x0, x1, e) => drawFenceEdge(c, x0, x1, geom, e));
      break;
    case "shore":
      withEdges(ctx, level, vb, (c, x0, x1, e) => drawShoreEdge(c, x0, x1, geom, e));
      break;
    case "cliff":
      withEdges(ctx, level, vb, (c, x0, x1, e) => drawCliffEdge(c, x0, x1, geom, e));
      break;
    case "barrier":
      withEdges(ctx, level, vb, (c, x0, x1) => drawBarrierEdge(c, x0, x1));
      break;
    case "festive":
      withEdges(ctx, level, vb, (c, x0, x1, e) => drawFestiveEdge(c, x0, x1, geom, e));
      break;
    case "candy":
      drawCandy(ctx, geom, level, vb);
      break;
  }
}

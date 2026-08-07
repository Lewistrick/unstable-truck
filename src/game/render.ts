import { getTheme, type TextureStyle } from "../level/themes.js";
import type { Level, MudObstacle, RockObstacle, Warehouse } from "../level/types.js";
import type { CargoState } from "../physics/cargo.js";
import type { TruckState } from "../physics/truck.js";
import { mulberry32, randRange, seedFromString, type Rng } from "../util/rng.js";
import { distance, type Vec2 } from "../util/vec2.js";
import { drawProp } from "./props/index.js";

function strokeRoad(ctx: CanvasRenderingContext2D, level: Level): void {
  for (const road of level.roads) {
    ctx.beginPath();
    ctx.moveTo(road.p0.x, road.p0.y);
    ctx.bezierCurveTo(road.p1.x, road.p1.y, road.p2.x, road.p2.y, road.p3.x, road.p3.y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = level.palette.road;
    ctx.lineWidth = road.width;
    ctx.stroke();
  }
  for (const road of level.roads) {
    ctx.beginPath();
    ctx.moveTo(road.p0.x, road.p0.y);
    ctx.bezierCurveTo(road.p1.x, road.p1.y, road.p2.x, road.p2.y, road.p3.x, road.p3.y);
    ctx.setLineDash([16, 14]);
    ctx.strokeStyle = level.palette.roadLine;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// --- Obstacle textures -----------------------------------------------------
// Mud and rocks are textured to sit better against the detailed scenery. All of
// it is purely visual: physics still treat a rock as its circle and mud as its
// polygon. Every random detail is derived from the obstacle's position (see
// obstacleRng), so it's identical each frame and on replay and never draws from
// the level's generation RNG - obstacle placement, and per-seed leaderboards,
// are unaffected.

/** Parse an "hsl(H S% L%)" palette color into channels to derive tones from. */
function parseHsl(color: string): { h: number; s: number; l: number } {
  const m = color.match(/hsl\(\s*([\d.-]+)\s+([\d.]+)%\s+([\d.]+)%/);
  return m ? { h: parseFloat(m[1]!), s: parseFloat(m[2]!), l: parseFloat(m[3]!) } : { h: 0, s: 0, l: 50 };
}

function hslStr(h: number, s: number, l: number, a = 1): string {
  const H = ((h % 360) + 360) % 360;
  const S = Math.max(0, Math.min(100, s));
  const L = Math.max(0, Math.min(100, l));
  return a === 1
    ? `hsl(${H.toFixed(0)} ${S.toFixed(0)}% ${L.toFixed(0)}%)`
    : `hsl(${H.toFixed(0)} ${S.toFixed(0)}% ${L.toFixed(0)}% / ${a})`;
}

/** Position-keyed RNG so an obstacle's texture is stable across frames/replays
 * without consuming the level's generation RNG. */
function obstacleRng(pos: Vec2): Rng {
  return mulberry32(seedFromString(`${Math.round(pos.x)}:${Math.round(pos.y)}`));
}

// Seamless rippled-water pattern, built once and reused for every puddle (like
// the ground textures). Tint-neutral black/white so it reads on any mud color.
const WATER_TILE = 80;
let waterPatternCache: CanvasPattern | null | undefined;

/** A tileable water texture: evenly spaced wavy lines, each a bright crest with
 * a soft dark trough beneath, so light glints off the ripples. Two sine cycles
 * across the tile and a 10px row pitch (80/8) keep it seamless in both axes;
 * per-line phase/amplitude jitter (from a fixed seed) makes it read as organic
 * water rather than mechanical stripes. */
function waterPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (waterPatternCache !== undefined) return waterPatternCache;
  const tile = document.createElement("canvas");
  tile.width = WATER_TILE;
  tile.height = WATER_TILE;
  const t = tile.getContext("2d");
  if (!t) return (waterPatternCache = null);

  const rng = mulberry32(0x7a7e12); // fixed, so the tile is stable across runs
  t.lineCap = "round";
  const wave = (y0: number, phase: number, amp: number, color: string, lw: number, dy: number): void => {
    t.beginPath();
    for (let x = 0; x <= WATER_TILE; x++) {
      // 2 whole cycles across the tile width -> ends match -> seamless in x.
      const yy = y0 + dy + Math.sin((x / WATER_TILE) * TAU * 2 + phase) * amp;
      if (x === 0) t.moveTo(x, yy);
      else t.lineTo(x, yy);
    }
    t.strokeStyle = color;
    t.lineWidth = lw;
    t.stroke();
  };
  for (let y0 = 0; y0 < WATER_TILE; y0 += 10) {
    const phase = rng() * TAU;
    const amp = 2 + rng() * 1.6;
    wave(y0, phase, amp, "rgba(0,0,0,0.12)", 1.8, 1.4); // trough shadow
    wave(y0, phase, amp, "rgba(255,255,255,0.32)", 1.4, 0); // crest highlight
  }
  waterPatternCache = ctx.createPattern(tile, "repeat");
  return waterPatternCache;
}

/** Mud as a rounded puddle: a smooth curved silhouette (rounding the physics
 * polygon's corners), a paler dried rim, a soft darker pool for depth, and a
 * seamless rippled-water pattern across the surface. */
function drawMud(ctx: CanvasRenderingContext2D, mud: MudObstacle, mudColor: string): void {
  const base = parseHsl(mudColor);
  const rng = obstacleRng(mud.pos);
  const { x: cx, y: cy } = mud.pos;
  const r = mud.radius;
  const pts = mud.points;
  const n = pts.length;

  // Smooth, rounded silhouette through the polygon vertices: draw quadratic
  // curves via edge midpoints, so the outline is a soft blob rather than an
  // angular 12-gon. `scale` shrinks it toward the center (the physics polygon
  // itself is unchanged). Slightly inside the polygon at corners, which reads as
  // forgiving - matching the mud hitbox's own inset.
  const roundedPath = (scale: number): void => {
    const px = (i: number): number => cx + (pts[i]!.x - cx) * scale;
    const py = (i: number): number => cy + (pts[i]!.y - cy) * scale;
    ctx.beginPath();
    ctx.moveTo((px(n - 1) + px(0)) / 2, (py(n - 1) + py(0)) / 2);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      ctx.quadraticCurveTo(px(i), py(i), (px(i) + px(j)) / 2, (py(i) + py(j)) / 2);
    }
    ctx.closePath();
  };

  ctx.save();
  ctx.globalAlpha = 0.82; // semi-transparent so the ground reads through

  // Drier, paler rim, then the wet body inset over it.
  roundedPath(1);
  ctx.fillStyle = hslStr(base.h + 4, base.s * 0.75, base.l + 14);
  ctx.fill();
  roundedPath(0.86);
  ctx.fillStyle = hslStr(base.h, base.s, base.l);
  ctx.fill();

  // Confine the depth and ripple pattern to the wet body.
  roundedPath(0.86);
  ctx.clip();

  // A soft darker pool for depth (one shape, off-center - not scattered noise).
  ctx.beginPath();
  ctx.ellipse(cx + (rng() - 0.5) * r * 0.3, cy + (rng() - 0.5) * r * 0.3, r * 0.62, r * 0.5, rng() * TAU, 0, TAU);
  ctx.fillStyle = hslStr(base.h - 6, base.s + 8, base.l - 13, 0.5);
  ctx.fill();

  // The watery texture: the seamless ripple pattern, filled across the puddle.
  // A per-patch offset (from this patch's RNG) shifts the pattern phase so
  // neighbouring puddles don't share the exact same ripple alignment.
  const water = waterPattern(ctx);
  if (water) {
    const ox = rng() * WATER_TILE;
    const oy = rng() * WATER_TILE;
    ctx.translate(-ox, -oy); // shift where the (clip-masked) pattern samples
    ctx.fillStyle = water;
    ctx.fillRect(cx - r - WATER_TILE + ox, cy - r - WATER_TILE + oy, r * 2 + WATER_TILE * 2, r * 2 + WATER_TILE * 2);
  }

  ctx.restore();
}

/** Rock with a bumpy silhouette (the collision stays the circle underneath),
 * flat lit/shadow facets for volume, and standout accent veins and grit that
 * read even when the base rock color matches the surrounding ground. */
function drawRock(ctx: CanvasRenderingContext2D, rock: RockObstacle, rockColor: string): void {
  const base = parseHsl(rockColor);
  const rng = obstacleRng(rock.pos);
  const { x: cx, y: cy } = rock.pos;
  const r = rock.radius;

  // Bumpy outline within ~0.9-1.08r, centered on the circular hitbox so it
  // still lines up with the (unchanged) circle collision.
  const verts: Vec2[] = [];
  const n = 10;
  const start = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * TAU;
    const rad = r * (0.9 + rng() * 0.18);
    verts.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
  }
  const outline = (): void => {
    ctx.beginPath();
    verts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  };

  // Accents: strong lightness contrast plus a modest hue shift, so veins and
  // facets stand out even when the rock body blends into the ground.
  const lit = hslStr(base.h + 16, Math.min(72, base.s + 16), Math.min(90, base.l + 32));
  const shadow = hslStr(base.h - 12, Math.min(80, base.s + 18), Math.max(10, base.l - 24));
  const vein = hslStr(base.h + 24, Math.max(30, Math.min(55, base.s + 20)), Math.min(93, base.l + 40));

  outline();
  ctx.fillStyle = rockColor;
  ctx.fill();

  ctx.save();
  ctx.clip();

  // Shadow facet over the lower-right.
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r * 0.1);
  ctx.lineTo(cx + r, cy - r * 0.35);
  ctx.lineTo(cx + r, cy + r);
  ctx.lineTo(cx - r, cy + r);
  ctx.closePath();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = shadow;
  ctx.fill();

  // Lit facet plane toward the top-left light.
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.85, cy - r * 0.25);
  ctx.lineTo(cx + r * 0.1, cy - r * 0.85);
  ctx.lineTo(cx + r * 0.25, cy - r * 0.05);
  ctx.lineTo(cx - r * 0.35, cy + r * 0.3);
  ctx.closePath();
  ctx.fillStyle = lit;
  ctx.fill();
  ctx.globalAlpha = 1;

  // 1-2 bright veins wandering across the face.
  const veinCount = 1 + (rng() < 0.5 ? 1 : 0);
  ctx.strokeStyle = vein;
  ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.75;
  for (let vI = 0; vI < veinCount; vI++) {
    let a = rng() * TAU;
    let px = cx + Math.cos(a) * r;
    let py = cy + Math.sin(a) * r;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let s = 0; s < 3; s++) {
      a += (rng() - 0.5) * 1.3;
      const step = r * (0.45 + rng() * 0.5);
      px += Math.cos(a) * step;
      py += Math.sin(a) * step;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // A few grit speckles in the lit accent.
  const speckles = 3 + Math.floor(rng() * 4);
  ctx.fillStyle = lit;
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < speckles; i++) {
    const a = rng() * TAU;
    const rr = rng() * r * 0.8;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, Math.max(0.8, r * 0.045), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Dark outline on the bumpy silhouette.
  outline();
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawObstacles(ctx: CanvasRenderingContext2D, level: Level, bounds: Bounds): void {
  const margin = 40;
  const visible = (pos: Vec2, r: number): boolean =>
    pos.x + r >= bounds.minX - margin &&
    pos.x - r <= bounds.maxX + margin &&
    pos.y + r >= bounds.minY - margin &&
    pos.y - r <= bounds.maxY + margin;

  for (const mud of level.muds) {
    if (visible(mud.pos, mud.radius)) drawMud(ctx, mud, level.palette.mud);
  }
  for (const rock of level.rocks) {
    if (visible(rock.pos, rock.radius)) drawRock(ctx, rock, level.palette.rock);
  }
}

/** Decorative houses: plain little buildings, no label or state. */
function drawHouses(ctx: CanvasRenderingContext2D, level: Level): void {
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1.5;
  for (const house of level.houses) {
    ctx.save();
    ctx.translate(house.pos.x, house.pos.y);
    ctx.rotate(house.angle);
    ctx.fillStyle = level.palette.house;
    ctx.fillRect(-house.width / 2, -house.height / 2, house.width, house.height);
    ctx.strokeRect(-house.width / 2, -house.height / 2, house.width, house.height);
    ctx.restore();
  }
}

/** Points the player toward the nearest unvisited pickup (red), or once every
 * pickup is done, toward the destination (green). Sits just off the truck in
 * the target's direction and rotates to point at it. */
function drawGuidanceArrow(
  ctx: CanvasRenderingContext2D,
  truck: TruckState,
  level: Level,
  visited: ReadonlySet<Warehouse>,
): void {
  const unvisited = level.warehouses.filter((w) => w.kind === "pickup" && !visited.has(w));
  let target: Warehouse | undefined;
  let done = false;
  if (unvisited.length > 0) {
    target = unvisited.reduce((a, b) => (distance(truck.pos, a.pos) <= distance(truck.pos, b.pos) ? a : b));
  } else {
    target = level.warehouses.find((w) => w.kind === "destination");
    done = true;
  }
  if (!target) return;

  const dx = target.pos.x - truck.pos.x;
  const dy = target.pos.y - truck.pos.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const offset = truck.radius + 30;

  ctx.save();
  ctx.translate(truck.pos.x + nx * offset, truck.pos.y + ny * offset);
  ctx.rotate(Math.atan2(ny, nx));
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(-10, -13);
  ctx.lineTo(-10, 13);
  ctx.closePath();
  ctx.fillStyle = done ? "#22c55e" : "#ef3b2a";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

type PaletteColorKey = keyof Level["palette"];

const WAREHOUSE_COLOR: Record<string, PaletteColorKey> = {
  base: "warehouseBase",
  pickup: "warehousePickup",
  destination: "warehouseDestination",
};

const WAREHOUSE_LABEL: Record<string, string> = { base: "B", pickup: "W", destination: "D" };

function drawWarehouses(
  ctx: CanvasRenderingContext2D,
  level: Level,
  visited: ReadonlySet<Warehouse>,
): void {
  for (const wh of level.warehouses) {
    // Once collected, a pickup blends back into the scenery as a plain house
    // (tan square, no label) so only the still-active objectives stand out.
    const isVisited = wh.kind === "pickup" && visited.has(wh);

    ctx.save();
    ctx.translate(wh.pos.x, wh.pos.y);
    ctx.rotate(wh.angle);
    if (isVisited) {
      ctx.fillStyle = level.palette.house;
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = level.palette[WAREHOUSE_COLOR[wh.kind]!];
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 2;
    }
    ctx.fillRect(-wh.width / 2, -wh.height / 2, wh.width, wh.height);
    ctx.strokeRect(-wh.width / 2, -wh.height / 2, wh.width, wh.height);
    ctx.restore();

    const label = isVisited ? undefined : WAREHOUSE_LABEL[wh.kind];
    if (label) {
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "bold 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, wh.pos.x, wh.pos.y);
      ctx.restore();
    }
  }
}

const CARGO_RENDER_WIDTH = 18;

function drawCargo(ctx: CanvasRenderingContext2D, cargo: CargoState): void {
  ctx.save();
  ctx.translate(cargo.pos.x, cargo.pos.y);
  ctx.rotate(cargo.heading);
  // Length (along travel) grows as the box fills; width is fixed.
  const len = cargo.length;
  const wid = CARGO_RENDER_WIDTH;
  const stabilityColor = cargo.stability > 50 ? "#8a5a34" : cargo.stability > 25 ? "#b0632f" : "#c23b2a";
  ctx.fillStyle = stabilityColor;
  ctx.fillRect(-len / 2, -wid / 2, len, wid);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(-len / 2, -wid / 2, len, wid);
  ctx.restore();
}

/** Draws a chain of trailing cargo boxes back-to-front (the box farthest
 * from the truck first) so nearer boxes correctly overlap farther ones
 * during tight turns. */
function drawCargoChain(ctx: CanvasRenderingContext2D, cargoBoxes: readonly CargoState[]): void {
  for (let i = cargoBoxes.length - 1; i >= 0; i--) drawCargo(ctx, cargoBoxes[i]!);
}

function drawTruck(ctx: CanvasRenderingContext2D, truck: TruckState): void {
  ctx.save();
  ctx.translate(truck.pos.x, truck.pos.y);
  ctx.rotate(truck.heading);
  ctx.fillStyle = "#2b3440";
  ctx.fillRect(-16, -11, 32, 22);
  ctx.fillStyle = "#5fa8e0";
  ctx.fillRect(6, -9, 9, 18);
  ctx.restore();
}

/** Small muted name tag above a truck (drawn outside any rotation transform,
 * so it stays upright regardless of heading). */
function drawNameLabel(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, text: string): void {
  ctx.save();
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.fillStyle = "rgba(240, 242, 245, 0.75)";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, pos.x, pos.y - 20);
  ctx.restore();
}

export interface Camera {
  x: number;
  y: number;
}

export function updateCamera(camera: Camera, truck: TruckState, dt: number): void {
  const rate = 4.5;
  camera.x += (truck.pos.x - camera.x) * Math.min(1, rate * dt);
  camera.y += (truck.pos.y - camera.y) * Math.min(1, rate * dt);
}

export interface GhostView {
  truck: TruckState;
  cargoBoxes: readonly CargoState[];
  /** Small muted label drawn above the ghost - e.g. "pb" or a nickname. */
  label: string;
}

const GHOST_ALPHA = 0.45;

// The world is drawn at roughly 1 unit = 1 CSS pixel. On a large screen that
// shows most of the 2000x1300 level, but on a phone it would show only a tiny
// slice. So on small screens we zoom out to guarantee at least this many world
// units are visible along the shorter viewport axis - never zooming in past
// 1:1, so desktop is unaffected.
const MIN_VIEW_SPAN = 640;

/** World-to-screen zoom factor for the current canvas size (<= 1). */
function viewZoom(canvasW: number, canvasH: number): number {
  return Math.min(1, Math.min(canvasW, canvasH) / MIN_VIEW_SPAN);
}

// --- Ground texture --------------------------------------------------------
// Each theme paints a subtle repeating texture over the flat grass fill. The
// texture is drawn once onto a small offscreen tile, cached as a CanvasPattern
// per level, then painted with a single fillRect per frame - so it costs no
// more than the grass fill it sits on. Overlays are low-alpha black/white, so
// they read correctly on any seeded ground color without needing the palette.

const TILE = 128;
const texturePatternCache = new WeakMap<Level, CanvasPattern | null>();

/** Draws `render` at (x, y) plus its 8 wrapped neighbours, so a mark near a
 * tile edge appears seamlessly on the opposite edge when the pattern repeats. */
function stampWrapped(ctx: CanvasRenderingContext2D, x: number, y: number, render: () => void): void {
  for (let dx = -TILE; dx <= TILE; dx += TILE) {
    for (let dy = -TILE; dy <= TILE; dy += TILE) {
      ctx.save();
      ctx.translate(x + dx, y + dy);
      render();
      ctx.restore();
    }
  }
}

function dot(ctx: CanvasRenderingContext2D, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function paintTile(ctx: CanvasRenderingContext2D, style: TextureStyle, rng: Rng): void {
  const DARK = "rgba(0, 0, 0, 0.05)";
  const LIGHT = "rgba(255, 255, 255, 0.06)";
  switch (style) {
    case "mottle": {
      // Organic scattered soft blobs, mostly darkening.
      for (let i = 0; i < 26; i++) {
        const x = rng() * TILE;
        const y = rng() * TILE;
        const r = randRange(rng, 7, 20);
        const fill = rng() < 0.65 ? DARK : LIGHT;
        stampWrapped(ctx, x, y, () => dot(ctx, r, fill));
      }
      break;
    }
    case "speckle": {
      // Fine sparkle: lots of tiny light flecks, a few dark ones.
      for (let i = 0; i < 110; i++) {
        const x = rng() * TILE;
        const y = rng() * TILE;
        const light = rng() < 0.8;
        stampWrapped(ctx, x, y, () =>
          dot(ctx, randRange(rng, 0.6, 1.8), light ? "rgba(255, 255, 255, 0.5)" : DARK),
        );
      }
      break;
    }
    case "craters": {
      // Shaded pits: a dark disc with a light rim offset to one side.
      for (let i = 0; i < 11; i++) {
        const x = rng() * TILE;
        const y = rng() * TILE;
        const r = randRange(rng, 5, 16);
        stampWrapped(ctx, x, y, () => {
          dot(ctx, r, "rgba(0, 0, 0, 0.07)");
          ctx.beginPath();
          ctx.arc(-r * 0.25, -r * 0.25, r * 0.7, 0, Math.PI * 2);
          ctx.strokeStyle = LIGHT;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        });
      }
      break;
    }
    case "dots": {
      // Confetti/petals: medium soft dots in a loose scatter.
      for (let i = 0; i < 20; i++) {
        const x = rng() * TILE;
        const y = rng() * TILE;
        const r = randRange(rng, 3, 6);
        const fill = rng() < 0.5 ? "rgba(255, 255, 255, 0.10)" : "rgba(0, 0, 0, 0.05)";
        stampWrapped(ctx, x, y, () => dot(ctx, r, fill));
      }
      break;
    }
    case "rows": {
      // Tilled furrows: evenly spaced horizontal bands (16 divides 128).
      for (let y = 0; y < TILE; y += 16) {
        ctx.fillStyle = DARK;
        ctx.fillRect(0, y, TILE, 8);
        ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
        ctx.fillRect(0, y + 8, TILE, 8);
      }
      break;
    }
    case "dunes": {
      // Wind ripples: closely spaced wavy lines, each a darker trough with a
      // lighter crest just above so it reads as raised sand (the earlier faint
      // white lines were near-invisible on light sandy ground). Two full sine
      // cycles across the width keep them seamless left-to-right; the even 16px
      // spacing (128 / 8) keeps them seamless top-to-bottom.
      const amplitude = 5;
      const wave = (y0: number, offset: number) => {
        ctx.beginPath();
        for (let x = 0; x <= TILE; x++) {
          const yy = y0 + offset + Math.sin((x / TILE) * Math.PI * 4) * amplitude;
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      };
      for (let y0 = 0; y0 < TILE; y0 += 16) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
        ctx.lineWidth = 1.5;
        wave(y0, -2);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.10)";
        ctx.lineWidth = 2;
        wave(y0, 0);
      }
      break;
    }
    case "grid": {
      // City block lines (32 divides 128; skip the far edges to avoid a double
      // line where tiles meet).
      ctx.strokeStyle = "rgba(0, 0, 0, 0.06)";
      ctx.lineWidth = 2;
      for (let p = 0; p < TILE; p += 32) {
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, TILE);
        ctx.moveTo(0, p);
        ctx.lineTo(TILE, p);
        ctx.stroke();
      }
      break;
    }
  }
}

/** The ground-texture pattern for a level, built once and cached. Null if the
 * platform can't create the pattern (then the flat grass fill stands alone). */
function texturePattern(ctx: CanvasRenderingContext2D, level: Level): CanvasPattern | null {
  const cached = texturePatternCache.get(level);
  if (cached !== undefined) return cached;

  const tile = document.createElement("canvas");
  tile.width = TILE;
  tile.height = TILE;
  const tileCtx = tile.getContext("2d");
  let pattern: CanvasPattern | null = null;
  if (tileCtx) {
    // A texture-only rng, independent of the level's generation stream.
    const rng = mulberry32(seedFromString(`${level.seed}#tex`));
    paintTile(tileCtx, getTheme(level.theme).texture, rng);
    pattern = ctx.createPattern(tile, "repeat");
  }
  texturePatternCache.set(level, pattern);
  return pattern;
}

// --- Scenery props ---------------------------------------------------------
// Decorative, no-collision biome scenery. Positions are precomputed in
// generation (deterministic, replay-safe); here they're drawn as small
// code-authored vector sprites, culled to the visible viewport so even a dense
// weekly map only draws what's on screen. Sprites are laid out upright (the
// world isn't rotated) with their base near y = 9, over a shared soft shadow.

const TAU = Math.PI * 2;

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Flat, ground-hugging props that shouldn't get the standing-prop drop shadow.
const SHADOWLESS = new Set(["fog", "lavacrack", "lilypad", "leaves", "crater", "frozenlake"]);

/** Draws the level's scenery, skipping anything outside the visible bounds. */
function drawScenery(ctx: CanvasRenderingContext2D, level: Level, bounds: Bounds): void {
  const margin = 140; // props (esp. large trees) extend well past their center
  for (const prop of level.scenery) {
    if (
      prop.pos.x < bounds.minX - margin ||
      prop.pos.x > bounds.maxX + margin ||
      prop.pos.y < bounds.minY - margin ||
      prop.pos.y > bounds.maxY + margin
    ) {
      continue;
    }
    ctx.save();
    ctx.translate(prop.pos.x, prop.pos.y);
    ctx.scale(prop.scale, prop.scale);
    if (prop.angle !== 0) ctx.rotate(prop.angle);
    if (!SHADOWLESS.has(prop.kind)) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
      ctx.beginPath();
      ctx.ellipse(0, 9, 8, 2.6, 0, 0, TAU);
      ctx.fill();
    }
    drawProp(ctx, prop.kind, prop.variant, mulberry32(prop.seed));
    ctx.restore();
  }
}

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  level: Level,
  truck: TruckState,
  cargoBoxes: readonly CargoState[],
  visited: ReadonlySet<Warehouse>,
  ghosts: readonly GhostView[],
  camera: Camera,
  canvasW: number,
  canvasH: number,
): void {
  // Area beyond the level bounds (visible near the world's edges) matches
  // the grass color instead of a hardcoded dark void.
  ctx.fillStyle = level.palette.grass;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Center the camera on screen, then scale about that center so the truck
  // stays put while more of the world comes into view on small screens.
  const zoom = viewZoom(canvasW, canvasH);
  ctx.save();
  ctx.translate(canvasW / 2, canvasH / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.x, -camera.y);

  ctx.fillStyle = level.palette.grass;
  ctx.fillRect(0, 0, level.width, level.height);

  // Subtle themed ground texture over the flat grass (one cached pattern fill).
  const texture = texturePattern(ctx, level);
  if (texture) {
    ctx.fillStyle = texture;
    ctx.fillRect(0, 0, level.width, level.height);
  }

  strokeRoad(ctx, level);
  // Visible world rect, used to cull both obstacles and scenery to what's on
  // screen (weekly maps have hundreds of each).
  const halfW = canvasW / 2 / zoom;
  const halfH = canvasH / 2 / zoom;
  const viewBounds: Bounds = {
    minX: camera.x - halfW,
    maxX: camera.x + halfW,
    minY: camera.y - halfH,
    maxY: camera.y + halfH,
  };
  drawObstacles(ctx, level, viewBounds);
  drawHouses(ctx, level);
  // Scenery sits on the grass (placed off-road), drawn under the warehouses so
  // gameplay markers stay on top.
  drawScenery(ctx, level, viewBounds);
  drawWarehouses(ctx, level, visited);

  for (const ghost of ghosts) {
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    drawCargoChain(ctx, ghost.cargoBoxes);
    drawTruck(ctx, ghost.truck);
    ctx.restore();
    drawNameLabel(ctx, ghost.truck.pos, ghost.label);
  }

  drawCargoChain(ctx, cargoBoxes);
  drawTruck(ctx, truck);
  drawNameLabel(ctx, truck.pos, "you");

  // The big weekly map is easy to get lost on, so guide the player to the next
  // objective.
  if (level.kind === "weekly") drawGuidanceArrow(ctx, truck, level, visited);

  ctx.restore();
}

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  level: Level,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const scale = Math.min(w / level.width, h / level.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x + (w - level.width * scale) / 2, y + (h - level.height * scale) / 2);
  ctx.scale(scale, scale);

  ctx.fillStyle = level.palette.grass;
  ctx.fillRect(0, 0, level.width, level.height);

  for (const road of level.roads) {
    ctx.beginPath();
    ctx.moveTo(road.p0.x, road.p0.y);
    ctx.bezierCurveTo(road.p1.x, road.p1.y, road.p2.x, road.p2.y, road.p3.x, road.p3.y);
    ctx.strokeStyle = level.palette.road;
    ctx.lineWidth = road.width * 0.8;
    ctx.stroke();
  }

  for (const rock of level.rocks) {
    ctx.beginPath();
    ctx.arc(rock.pos.x, rock.pos.y, rock.radius, 0, Math.PI * 2);
    ctx.fillStyle = level.palette.rock;
    ctx.fill();
  }
  for (const mud of level.muds) {
    ctx.beginPath();
    mud.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = level.palette.mud;
    ctx.fill();
  }

  if (level.houses.length > 0) {
    ctx.fillStyle = level.palette.house;
    const hs = 8 / scale;
    for (const house of level.houses) {
      ctx.fillRect(house.pos.x - hs / 2, house.pos.y - hs / 2, hs, hs);
    }
  }

  for (const wh of level.warehouses) {
    ctx.fillStyle = level.palette[WAREHOUSE_COLOR[wh.kind]!];
    const s = Math.max(wh.width, 14 / scale);
    ctx.fillRect(wh.pos.x - s / 2, wh.pos.y - s / 2, s, s);
  }

  ctx.restore();
}

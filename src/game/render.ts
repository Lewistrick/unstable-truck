import { distance } from "../util/vec2.js";
import { mulberry32, randRange, seedFromString, type Rng } from "../util/rng.js";
import { getTheme, type TextureStyle } from "../level/themes.js";
import type { CargoState } from "../physics/cargo.js";
import type { TruckState } from "../physics/truck.js";
import type { Level, Warehouse } from "../level/types.js";

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

function drawObstacles(ctx: CanvasRenderingContext2D, level: Level): void {
  for (const mud of level.muds) {
    ctx.beginPath();
    mud.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = level.palette.mud;
    ctx.globalAlpha = 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const rock of level.rocks) {
    ctx.beginPath();
    ctx.arc(rock.pos.x, rock.pos.y, rock.radius, 0, Math.PI * 2);
    ctx.fillStyle = level.palette.rock;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
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

const VISITED_OPACITY = 0.4;

function drawWarehouses(
  ctx: CanvasRenderingContext2D,
  level: Level,
  visited: ReadonlySet<Warehouse>,
): void {
  for (const wh of level.warehouses) {
    const isVisited = wh.kind === "pickup" && visited.has(wh);

    ctx.save();
    ctx.globalAlpha = isVisited ? VISITED_OPACITY : 1;
    ctx.translate(wh.pos.x, wh.pos.y);
    ctx.rotate(wh.angle);
    ctx.fillStyle = level.palette[WAREHOUSE_COLOR[wh.kind]!];
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 2;
    ctx.fillRect(-wh.width / 2, -wh.height / 2, wh.width, wh.height);
    ctx.strokeRect(-wh.width / 2, -wh.height / 2, wh.width, wh.height);
    ctx.restore();

    const label = isVisited ? "✓" : WAREHOUSE_LABEL[wh.kind];
    if (label) {
      ctx.save();
      ctx.globalAlpha = isVisited ? VISITED_OPACITY : 1;
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
      // Wavy horizontal ripples; two full sine cycles across the width keeps
      // them seamless left-to-right, even spacing keeps them seamless top-to-
      // bottom.
      ctx.strokeStyle = LIGHT;
      ctx.lineWidth = 1.5;
      for (let y0 = 0; y0 < TILE; y0 += 16) {
        ctx.beginPath();
        for (let x = 0; x <= TILE; x++) {
          const yy = y0 + Math.sin((x / TILE) * Math.PI * 4) * 3;
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
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
  drawObstacles(ctx, level);
  drawHouses(ctx, level);
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

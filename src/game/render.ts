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

/** Rounded-rect path helper (fill/stroke is the caller's job). */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Filled triangle with apex at (cx, apexY) and a base `height` below it. */
function triangle(ctx: CanvasRenderingContext2D, cx: number, apexY: number, halfW: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, apexY);
  ctx.lineTo(cx - halfW, apexY + height);
  ctx.lineTo(cx + halfW, apexY + height);
  ctx.closePath();
  ctx.fill();
}

const SHRUB_FLOWERS = ["#e85d75", "#f2c14e", "#6fb1e0", "#f4f1ea"];
const MUSHROOM_CAPS = ["#d64545", "#e0873c", "#b0553a", "#c94f8a"];
const CAR_COLORS = ["#c0392b", "#2980b9", "#f1c40f", "#7f8c8d"];
const CANDY_COLORS = ["#e8503a", "#f2c14e", "#6fb1e0", "#e88bb0"];
const EGG_COLORS = ["#e88bb0", "#6fb1e0", "#f2c14e", "#8fd18f"];
const FESTIVE_COLORS = ["#f2c14e", "#e8503a", "#6fb1e0", "#8fd18f"];

/** Draws one prop in local space (already translated/scaled by the caller). */
function drawProp(ctx: CanvasRenderingContext2D, kind: string, variant: number): void {
  switch (kind) {
    case "cow": {
      ctx.fillStyle = "#4a423d";
      ctx.fillRect(-6, 4, 2.5, 5);
      ctx.fillRect(3.5, 4, 2.5, 5);
      ctx.fillStyle = "#f4f1ea";
      roundedRect(ctx, -8, -5, 16, 10, 5);
      ctx.fill();
      ctx.fillStyle = "#4a423d";
      ctx.beginPath();
      ctx.ellipse(-2, 0, 3, 2.6, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4, -2, 2, 1.8, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#f4f1ea";
      roundedRect(ctx, 6, -4, 7, 7, 3);
      ctx.fill();
      ctx.fillStyle = "#caa0a0";
      roundedRect(ctx, 9.5, -1, 4, 3.5, 1.5);
      ctx.fill();
      break;
    }
    case "shrub": {
      ctx.fillStyle = "#4b7a3a";
      ctx.beginPath();
      ctx.arc(-3, 3, 5, 0, TAU);
      ctx.arc(3, 3, 5, 0, TAU);
      ctx.arc(0, -1, 5.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = SHRUB_FLOWERS[variant % SHRUB_FLOWERS.length]!;
      ctx.beginPath();
      ctx.arc(-2, -1, 1.4, 0, TAU);
      ctx.arc(2, 1, 1.4, 0, TAU);
      ctx.arc(0, 3, 1.4, 0, TAU);
      ctx.fill();
      break;
    }
    case "cactus": {
      // Every cactus has at least one arm; arms bend outward then up (saguaro).
      const hasLeft = variant !== 2;
      const hasRight = variant !== 1;
      ctx.fillStyle = "#3f8f4e";
      roundedRect(ctx, -2.5, -9, 5, 18, 2.5); // trunk
      ctx.fill();
      if (hasLeft) {
        roundedRect(ctx, -7, 1, 5.5, 2.5, 1.2); // elbow out to the left
        ctx.fill();
        roundedRect(ctx, -7, -5, 3, 8, 1.5); // then up
        ctx.fill();
      }
      if (hasRight) {
        roundedRect(ctx, 1.5, 3, 5.5, 2.5, 1.2); // elbow out to the right
        ctx.fill();
        roundedRect(ctx, 4, -3, 3, 8, 1.5); // then up
        ctx.fill();
      }
      break;
    }
    case "deadbush": {
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
      break;
    }
    case "penguin": {
      ctx.fillStyle = "#2b2b30";
      roundedRect(ctx, -5, -8, 10, 17, 5);
      ctx.fill();
      ctx.fillStyle = "#f4f1ea";
      roundedRect(ctx, -3.5, -3, 7, 11, 3.5);
      ctx.fill();
      ctx.fillStyle = "#2b2b30";
      ctx.beginPath();
      ctx.arc(-1.8, -4, 0.9, 0, TAU);
      ctx.arc(1.8, -4, 0.9, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#e8912f";
      ctx.beginPath();
      ctx.moveTo(-1.5, -2);
      ctx.lineTo(1.5, -2);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-3, 8, 2.5, 1.8);
      ctx.fillRect(0.6, 8, 2.5, 1.8);
      break;
    }
    case "pine":
    case "snowpine": {
      // Trunk starts above the foliage base (y = 3) so it connects, not floats.
      ctx.fillStyle = "#6b4a2f";
      ctx.fillRect(-1.5, 2, 3, 7);
      ctx.fillStyle = kind === "snowpine" ? "#2f6d43" : "#2e6b3f";
      triangle(ctx, 0, -9, 6, 7);
      triangle(ctx, 0, -4, 8, 7);
      if (kind === "snowpine") {
        ctx.fillStyle = "#eef4f7";
        triangle(ctx, 0, -9, 3.4, 3);
        triangle(ctx, 0, -4, 4.5, 3);
      }
      break;
    }
    case "mushroom": {
      ctx.fillStyle = "#efe6d2";
      roundedRect(ctx, -2, -1, 4, 9, 2);
      ctx.fill();
      ctx.fillStyle = MUSHROOM_CAPS[variant % MUSHROOM_CAPS.length]!;
      ctx.beginPath();
      ctx.moveTo(-7, -1);
      ctx.quadraticCurveTo(0, -11, 7, -1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#f4efe0";
      ctx.beginPath();
      ctx.arc(-2.5, -4, 1, 0, TAU);
      ctx.arc(2.5, -3, 1, 0, TAU);
      ctx.arc(0, -6, 1, 0, TAU);
      ctx.fill();
      break;
    }
    case "tree": {
      ctx.fillStyle = "#6b4a2f";
      ctx.fillRect(-1.5, 2, 3, 7);
      ctx.fillStyle = "#3f8f4e";
      ctx.beginPath();
      ctx.arc(0, -3, 7, 0, TAU);
      ctx.arc(-4, 0, 5, 0, TAU);
      ctx.arc(4, 0, 5, 0, TAU);
      ctx.fill();
      break;
    }
    case "cyclist": {
      ctx.strokeStyle = "#33373d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(-4, 6, 3, 0, TAU);
      ctx.moveTo(7, 6);
      ctx.arc(4, 6, 3, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, 6);
      ctx.lineTo(0, 6);
      ctx.lineTo(-1, 1);
      ctx.lineTo(-4, 6);
      ctx.moveTo(0, 6);
      ctx.lineTo(3, 2);
      ctx.stroke();
      ctx.strokeStyle = "#c23b3b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-1, 1);
      ctx.lineTo(1, -2);
      ctx.lineTo(3, 2);
      ctx.stroke();
      ctx.fillStyle = "#e0b48c";
      ctx.beginPath();
      ctx.arc(1, -4, 1.6, 0, TAU);
      ctx.fill();
      break;
    }
    case "car": {
      ctx.fillStyle = CAR_COLORS[variant % CAR_COLORS.length]!;
      roundedRect(ctx, -8, -1, 16, 6, 2);
      ctx.fill();
      roundedRect(ctx, -4.5, -5, 9, 5, 2);
      ctx.fill();
      ctx.fillStyle = "#bcd7e6";
      roundedRect(ctx, -3, -4, 6, 3, 1);
      ctx.fill();
      ctx.fillStyle = "#26292e";
      ctx.beginPath();
      ctx.arc(-4.5, 5, 2, 0, TAU);
      ctx.arc(4.5, 5, 2, 0, TAU);
      ctx.fill();
      break;
    }
    case "building": {
      const height = 14 + (variant % 3) * 5;
      const top = 9 - height;
      ctx.fillStyle = "#7a8494";
      ctx.fillRect(-6, top, 12, height);
      ctx.fillStyle = "#5f6875";
      ctx.fillRect(-6, top, 12, 2);
      ctx.fillStyle = "rgba(255, 236, 180, 0.85)";
      for (let wy = top + 3; wy < 7; wy += 4) {
        for (let wx = -4; wx <= 3; wx += 3.5) {
          if ((wx + wy) % 2 < 1.2) ctx.fillRect(wx, wy, 1.8, 2);
        }
      }
      break;
    }
    case "astronaut": {
      ctx.fillStyle = "#eef1f4";
      roundedRect(ctx, -4, -4, 8, 12, 3);
      ctx.fill();
      ctx.fillRect(-3.5, 8, 2.5, 2);
      ctx.fillRect(1, 8, 2.5, 2);
      ctx.beginPath();
      ctx.arc(0, -6, 4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#3a4a63";
      ctx.beginPath();
      ctx.arc(0, -6, 2.6, 0, TAU);
      ctx.fill();
      break;
    }
    case "flag": {
      ctx.strokeStyle = "#c9ccd2";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -9);
      ctx.stroke();
      ctx.fillStyle = "#c0392b";
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(8, -7);
      ctx.lineTo(0, -4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "palm": {
      ctx.strokeStyle = "#8a6a44";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.quadraticCurveTo(-2, 0, 1, -6);
      ctx.stroke();
      ctx.strokeStyle = "#3f9e57";
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i - 2) * 0.7;
        ctx.beginPath();
        ctx.moveTo(1, -6);
        ctx.quadraticCurveTo(1 + Math.cos(ang) * 5, -6 + Math.sin(ang) * 5, 1 + Math.cos(ang) * 10, -4 + Math.sin(ang) * 10);
        ctx.stroke();
      }
      ctx.fillStyle = "#5a3a24";
      ctx.beginPath();
      ctx.arc(1, -5, 1.3, 0, TAU);
      ctx.arc(-1.4, -5, 1.3, 0, TAU);
      ctx.fill();
      break;
    }
    case "umbrella": {
      ctx.strokeStyle = "#8a8a8a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -4);
      ctx.stroke();
      ctx.fillStyle = "#e8503a";
      ctx.beginPath();
      ctx.moveTo(-8, -4);
      ctx.quadraticCurveTo(0, -13, 8, -4);
      ctx.quadraticCurveTo(4, -2, 2, -4);
      ctx.quadraticCurveTo(0, -2, -2, -4);
      ctx.quadraticCurveTo(-4, -2, -8, -4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.beginPath();
      ctx.moveTo(-4, -5.5);
      ctx.quadraticCurveTo(-2, -9, 0, -10.5);
      ctx.quadraticCurveTo(-1, -6.5, -1.5, -4.3);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "haybale": {
      ctx.fillStyle = "#d8b45a";
      roundedRect(ctx, -8, -2, 16, 11, 5);
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 90, 30, 0.5)";
      ctx.lineWidth = 0.8;
      for (const rx of [8, 5, 2.4]) {
        ctx.beginPath();
        ctx.ellipse(0, 3.5, rx, 6, 0, 0, TAU);
        ctx.stroke();
      }
      break;
    }
    case "scarecrow": {
      ctx.strokeStyle = "#8a6a44";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -6);
      ctx.moveTo(-6, -1);
      ctx.lineTo(6, -1);
      ctx.stroke();
      ctx.fillStyle = "#7ea04a";
      roundedRect(ctx, -4, -4, 8, 8, 2);
      ctx.fill();
      ctx.fillStyle = "#d9b46a";
      ctx.beginPath();
      ctx.arc(0, -7, 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#8a5a2a";
      ctx.beginPath();
      ctx.moveTo(-4, -8);
      ctx.lineTo(4, -8);
      ctx.lineTo(2, -12);
      ctx.lineTo(-2, -12);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "pumpkin": {
      ctx.fillStyle = "#e07b28";
      ctx.beginPath();
      ctx.ellipse(0, 4, 7, 5.5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(150, 80, 20, 0.4)";
      ctx.beginPath();
      ctx.ellipse(0, 4, 2.5, 5.3, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "#5a7a2a";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, -1);
      ctx.lineTo(0, -4);
      ctx.stroke();
      break;
    }
    case "grasstuft": {
      ctx.strokeStyle = "#7ea04a";
      ctx.lineWidth = 1.2;
      ctx.lineCap = "round";
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 1.2, 9);
        ctx.quadraticCurveTo(i * 1.6, 3, i * 2.2, -2 + Math.abs(i));
        ctx.stroke();
      }
      break;
    }
    case "smokevent": {
      ctx.fillStyle = "#4a423f";
      ctx.beginPath();
      ctx.moveTo(-5, 9);
      ctx.lineTo(5, 9);
      ctx.lineTo(2, 2);
      ctx.lineTo(-2, 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(230, 90, 40, 0.6)";
      ctx.beginPath();
      ctx.ellipse(0, 2.2, 2, 1, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(160, 160, 165, 0.45)";
      ctx.beginPath();
      ctx.arc(0, -1, 3, 0, TAU);
      ctx.arc(2, -5, 2.4, 0, TAU);
      ctx.arc(-1, -8, 2, 0, TAU);
      ctx.fill();
      break;
    }
    case "reeds": {
      const stalks: Array<[number, number]> = [
        [-3, 0],
        [0, 1],
        [3, 0.5],
      ];
      for (const [x, ph] of stalks) {
        ctx.strokeStyle = "#5f7d3a";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, 9);
        ctx.lineTo(x, -6 + ph);
        ctx.stroke();
        ctx.fillStyle = "#7a5230";
        roundedRect(ctx, x - 1, -9 + ph, 2, 4, 1);
        ctx.fill();
      }
      break;
    }
    case "lilypad": {
      ctx.fillStyle = "#3f8f4e";
      ctx.beginPath();
      ctx.arc(0, 7, 6, 0.5, TAU - 0.5);
      ctx.lineTo(0, 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#e88bb0";
      ctx.beginPath();
      ctx.arc(-1, 6, 1.6, 0, TAU);
      ctx.fill();
      break;
    }
    case "lollipop": {
      ctx.strokeStyle = "#e8e2d6";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -2);
      ctx.stroke();
      ctx.fillStyle = CANDY_COLORS[variant % CANDY_COLORS.length]!;
      ctx.beginPath();
      ctx.arc(0, -5, 4.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let a = 0; a < TAU * 2; a += 0.3) {
        const r = (a / (TAU * 2)) * 4.2;
        const x = Math.cos(a) * r;
        const y = -5 + Math.sin(a) * r;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case "candycane": {
      ctx.lineCap = "round";
      ctx.strokeStyle = "#e8503a";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(2, 9);
      ctx.lineTo(2, -4);
      ctx.quadraticCurveTo(2, -9, -2, -8);
      ctx.stroke();
      ctx.strokeStyle = "#f4f1ea";
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(2, 9);
      ctx.lineTo(2, -4);
      ctx.quadraticCurveTo(2, -9, -2, -8);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case "egg": {
      ctx.fillStyle = EGG_COLORS[variant % EGG_COLORS.length]!;
      ctx.beginPath();
      ctx.ellipse(0, 3, 4.5, 6, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "#f4f1ea";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4.2, 2);
      ctx.lineTo(-2, 4);
      ctx.lineTo(0, 2);
      ctx.lineTo(2, 4);
      ctx.lineTo(4.2, 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      ctx.beginPath();
      ctx.arc(-1, -1, 0.8, 0, TAU);
      ctx.arc(2, 0, 0.8, 0, TAU);
      ctx.fill();
      break;
    }
    case "bunny": {
      ctx.fillStyle = "#f0ece4";
      ctx.beginPath();
      ctx.ellipse(0, 4, 4.5, 5, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -2, 3.2, 0, TAU);
      ctx.fill();
      roundedRect(ctx, -2.6, -11, 1.8, 7, 0.9);
      ctx.fill();
      roundedRect(ctx, 0.8, -11, 1.8, 7, 0.9);
      ctx.fill();
      ctx.fillStyle = "#e8b3c0";
      roundedRect(ctx, -2.1, -10, 0.8, 5, 0.4);
      ctx.fill();
      roundedRect(ctx, 1.3, -10, 0.8, 5, 0.4);
      ctx.fill();
      ctx.fillStyle = "#4a423d";
      ctx.beginPath();
      ctx.arc(-1, -2, 0.6, 0, TAU);
      ctx.arc(1, -2, 0.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#e8879c";
      ctx.beginPath();
      ctx.arc(0, -0.5, 0.7, 0, TAU);
      ctx.fill();
      break;
    }
    case "firework": {
      const color = FESTIVE_COLORS[variant % FESTIVE_COLORS.length]!;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 2, -6 + Math.sin(a) * 2);
        ctx.lineTo(Math.cos(a) * 7, -6 + Math.sin(a) * 7);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 7.5, -6 + Math.sin(a) * 7.5, 0.9, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "balloon": {
      ctx.fillStyle = FESTIVE_COLORS[variant % FESTIVE_COLORS.length]!;
      ctx.beginPath();
      ctx.ellipse(0, -4, 4, 5, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-1, 1);
      ctx.lineTo(1, 1);
      ctx.lineTo(0, 2.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 120, 120, 0.7)";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, 2.5);
      ctx.quadraticCurveTo(2, 6, 0, 9);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.beginPath();
      ctx.ellipse(-1.3, -6, 1, 1.6, 0, 0, TAU);
      ctx.fill();
      break;
    }
    case "baretree": {
      ctx.strokeStyle = "#6b4a2f";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -2);
      ctx.moveTo(0, 0);
      ctx.lineTo(-4, -5);
      ctx.moveTo(0, -2);
      ctx.lineTo(4, -6);
      ctx.moveTo(0, 2);
      ctx.lineTo(-5, -1);
      ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-4, -5);
      ctx.lineTo(-6, -8);
      ctx.moveTo(4, -6);
      ctx.lineTo(6, -9);
      ctx.moveTo(0, -2);
      ctx.lineTo(1, -8);
      ctx.stroke();
      ctx.fillStyle = "#d9822b";
      for (const [x, y] of [[-6, -8], [6, -9], [1, -8], [-5, -1]] as Array<[number, number]>) {
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "acacia": {
      ctx.fillStyle = "#6b4a2f";
      ctx.fillRect(-1.3, -1, 2.6, 10);
      ctx.strokeStyle = "#6b4a2f";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -1);
      ctx.lineTo(-5, -4);
      ctx.moveTo(0, -1);
      ctx.lineTo(5, -4);
      ctx.stroke();
      ctx.fillStyle = "#5a8f3c";
      ctx.beginPath();
      ctx.ellipse(0, -6, 10, 3.5, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -8, 7, 2.5, 0, 0, TAU);
      ctx.fill();
      break;
    }
    case "charredtree": {
      ctx.strokeStyle = "#2e2724";
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(0, -4);
      ctx.moveTo(0, -1);
      ctx.lineTo(-4, -6);
      ctx.moveTo(0, -3);
      ctx.lineTo(4, -7);
      ctx.stroke();
      ctx.fillStyle = "rgba(230, 90, 40, 0.5)";
      ctx.beginPath();
      ctx.arc(0, 8, 3, 0, TAU);
      ctx.fill();
      break;
    }
  }
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

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
    ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
    ctx.beginPath();
    ctx.ellipse(0, 9, 8, 2.6, 0, 0, TAU);
    ctx.fill();
    drawProp(ctx, prop.kind, prop.variant);
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
  drawObstacles(ctx, level);
  drawHouses(ctx, level);
  // Scenery sits on the grass (placed off-road), drawn under the warehouses so
  // gameplay markers stay on top. Cull to the visible world rect.
  const halfW = canvasW / 2 / zoom;
  const halfH = canvasH / 2 / zoom;
  drawScenery(ctx, level, {
    minX: camera.x - halfW,
    maxX: camera.x + halfW,
    minY: camera.y - halfH,
    maxY: camera.y + halfH,
  });
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

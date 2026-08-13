import { getTheme, type TextureStyle } from "../level/themes.js";
import type { Level, MudObstacle, RockObstacle, Warehouse } from "../level/types.js";
import { beyondFill, drawBoundary } from "./boundary.js";
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

/** Mud as a rounded puddle: a smooth curved silhouette (rounding the physics
 * polygon's corners), a paler dried rim, a soft darker pool for depth, and a
 * watery surface of several just-off-concentric ripple-ring groups. */
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

  // The watery texture: several groups of just-off-concentric ripple rings, as
  // if from drips landing on the surface. Group centers, ring counts and the
  // per-ring wobble all come from this patch's RNG, so every puddle's ripples
  // are unique but always read as concentric ring groups. Each ring is a bright
  // crest over a faint dark halo so it glints like water.
  ctx.lineCap = "round";
  const groups = 1 + Math.floor(rng() * 2);
  for (let g = 0; g < groups; g++) {
    const gx = cx + (rng() - 0.5) * r * 1.3;
    const gy = cy + (rng() - 0.5) * r * 1.3;
    const rings = 7 + Math.floor(rng() * 4);
    const gap = r * (0.09 + rng() * 0.06);
    const rot = rng() * TAU;
    const squash = 0.8 + rng() * 0.2;
    for (let i = 1; i <= rings; i++) {
      const rad = gap * i;
      // "Just off": nudge each ring's center a touch so they aren't perfectly
      // nested, like real ripples.
      const jx = gx + (rng() - 0.5) * rad * 0.16;
      const jy = gy + (rng() - 0.5) * rad * 0.16;
      const fade = 1 - (i - 1) / (rings + 0.5); // inner rings brightest
      ctx.beginPath();
      ctx.ellipse(jx, jy, rad + 1, (rad + 1) * squash, rot, 0, TAU);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `rgba(0, 0, 0, ${(0.09 * fade).toFixed(3)})`;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(jx, jy, rad, rad * squash, rot, 0, TAU);
      ctx.lineWidth = Math.max(0.9, r * 0.02);
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.3 * fade).toFixed(3)})`;
      ctx.stroke();
    }
  }

  ctx.restore();
}

// Every rock is lit from the same direction, so the light/dark terminator sits
// at a constant angle on all of them - keeping the shading illusion consistent
// across the map. Only its position (and the stone/facet shapes) vary per rock.
// This unit vector points from the lit side toward the shadow side.
const ROCK_SHADE_ANGLE = Math.PI * 0.25; // shadow toward lower-right (light from upper-left)
const ROCK_SHADE_DIR = { x: Math.cos(ROCK_SHADE_ANGLE), y: Math.sin(ROCK_SHADE_ANGLE) };

/** Rock with a random bumpy silhouette, a lit/shadow split whose terminator is
 * at the shared global angle (only its offset varies per stone), a random inner
 * facet, and standout accent veins/grit that read even when the base rock color
 * matches the surrounding ground. */
function drawRock(ctx: CanvasRenderingContext2D, rock: RockObstacle, rockColor: string): void {
  const base = parseHsl(rockColor);
  const rng = obstacleRng(rock.pos);
  const { x: cx, y: cy } = rock.pos;
  const r = rock.radius;

  // Random bumpy outline (varied vertex count and per-vertex radius so stones
  // differ), centered on the circular hitbox so it still lines up with the
  // (unchanged) circle collision.
  const verts: Vec2[] = [];
  const n = 8 + Math.floor(rng() * 5); // 8-12 corners
  const start = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * TAU;
    const rad = r * (0.82 + rng() * 0.28); // 0.82-1.10
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

  // Light/dark split: the terminator line is perpendicular to ROCK_SHADE_DIR
  // (same angle on every rock), through a point offset from center along that
  // direction. Only the offset varies per rock, so some stones catch more light
  // than others while the light appears to come from one place everywhere.
  const dir = ROCK_SHADE_DIR;
  const perp = { x: -dir.y, y: dir.x };
  const offset = (rng() - 0.5) * r * 0.8; // -0.4r..0.4r along the light axis
  const sx = cx + dir.x * offset;
  const sy = cy + dir.y * offset;
  const BIG = r * 2.4;
  // Fill the half-plane on `side` (+1 = shadow side, -1 = lit side) of the line.
  const halfPlane = (side: number): void => {
    ctx.beginPath();
    ctx.moveTo(sx + perp.x * BIG, sy + perp.y * BIG);
    ctx.lineTo(sx - perp.x * BIG, sy - perp.y * BIG);
    ctx.lineTo(sx - perp.x * BIG + dir.x * side * BIG, sy - perp.y * BIG + dir.y * side * BIG);
    ctx.lineTo(sx + perp.x * BIG + dir.x * side * BIG, sy + perp.y * BIG + dir.y * side * BIG);
    ctx.closePath();
  };
  halfPlane(1);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = shadow;
  ctx.fill();
  halfPlane(-1);
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = lit;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Inner facet ("the square"): a brighter angular plane on the lit side, with a
  // random shape, size, and position per rock.
  const fx = cx - dir.x * r * (0.15 + rng() * 0.28) + perp.x * (rng() - 0.5) * r * 0.5;
  const fy = cy - dir.y * r * (0.15 + rng() * 0.28) + perp.y * (rng() - 0.5) * r * 0.5;
  const fSize = r * (0.28 + rng() * 0.28);
  const fRot = rng() * TAU;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = fRot + k * (TAU / 4) + (rng() - 0.5) * 0.5; // jittered quad corners
    const rr = fSize * (0.7 + rng() * 0.6);
    const x = fx + Math.cos(a) * rr;
    const y = fy + Math.sin(a) * rr;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.globalAlpha = 0.5;
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

// --- Edge arrows -----------------------------------------------------------
// Screen-space wedges pinned to the viewport borders, each pointing at an
// off-screen objective. Big weekly maps (and even daily ones on a phone) show
// only a slice of the world, so these keep the next objective findable without
// cluttering the middle of the play area.

// How far inside the viewport the arrow's tip sits, so the whole wedge stays
// visible instead of poking off the edge. Also the band, measured from each
// border, within which an objective counts as "on screen" (no arrow).
const EDGE_ARROW_MARGIN = 16;
// Wedge geometry at scale 1: apex-to-base length and half the base width.
const EDGE_ARROW_LEN = 24;
const EDGE_ARROW_HALF = 12;
// Size scales inversely with distance: an objective right off-screen gets the
// max scale; one at least this fraction of the map's diagonal away gets the min.
const EDGE_ARROW_MAX_SCALE = 1.35;
const EDGE_ARROW_MIN_SCALE = 0.325;
const EDGE_ARROW_FAR_FRACTION = 0.6;

const PICKUP_ARROW_COLOR = "#ef3b2a";
const DROPOFF_ARROW_COLOR = "#22c55e";

// Once the last pickup is collected, the single drop-off arrow launches from the
// truck out to its border spot over this many milliseconds, to call attention to
// where to finish. Purely a UI flourish (wall-clock driven), so it never touches
// gameplay or deterministic replay.
const DROPOFF_SHOOT_MS = 1000;
// Set to the launch timestamp on the frame the last pickup is collected, then
// used to ease the arrow outward; `dropoffWasDone` detects that transition and
// resets when a fresh run leaves everything uncollected again.
let dropoffShootStart: number | null = null;
let dropoffWasDone = false;

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/** Arrow scale for a target `dist` world-units away on a map whose diagonal is
 * `diag`. Nearer targets read bolder (max scale); anything past
 * EDGE_ARROW_FAR_FRACTION of the diagonal is clamped to the min scale. Exported
 * for the edge-arrow geometry test. */
export function edgeArrowScale(dist: number, diag: number): number {
  const t = Math.min(1, dist / (diag * EDGE_ARROW_FAR_FRACTION || 1));
  return EDGE_ARROW_MAX_SCALE - (EDGE_ARROW_MAX_SCALE - EDGE_ARROW_MIN_SCALE) * t;
}

/** Where the ray from (ox,oy) toward (tx,ty) first crosses the viewport border
 * inset by `margin`, or null if it never does within the segment. Used to pin an
 * off-screen objective's arrow to the edge in that objective's direction.
 * Exported for the edge-arrow geometry test. */
export function intersectBorder(
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  margin: number,
  canvasW: number,
  canvasH: number,
): Vec2 | null {
  const dx = tx - ox;
  const dy = ty - oy;
  const left = margin;
  const right = canvasW - margin;
  const top = margin;
  const bottom = canvasH - margin;
  let best = Infinity;
  let hit: Vec2 | null = null;
  const consider = (t: number, x: number, y: number): void => {
    // A tiny tolerance keeps a crossing exactly at a corner from being rejected
    // by floating-point rounding on the perpendicular axis.
    if (t >= 0 && t <= 1 && t < best && x >= left - 0.5 && x <= right + 0.5 && y >= top - 0.5 && y <= bottom + 0.5) {
      best = t;
      hit = { x, y };
    }
  };
  if (dx !== 0) {
    const tl = (left - ox) / dx;
    consider(tl, left, oy + tl * dy);
    const tr = (right - ox) / dx;
    consider(tr, right, oy + tr * dy);
  }
  if (dy !== 0) {
    const tt = (top - oy) / dy;
    consider(tt, ox + tt * dx, top);
    const tb = (bottom - oy) / dy;
    consider(tb, ox + tb * dx, bottom);
  }
  return hit;
}

/** One filled wedge pinned to the border at (x,y), apex at that point pointing
 * along `angle` (the on-screen direction to its objective), body trailing back
 * inward, scaled by `scale`. */
function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  scale: number,
  color: string,
): void {
  const len = EDGE_ARROW_LEN * scale;
  const half = EDGE_ARROW_HALF * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-len, -half);
  ctx.lineTo(-len, half);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/** Draws a border arrow for every off-screen objective. While any pickups
 * remain, each uncollected pickup that's off-screen gets a red arrow; once all
 * pickups are collected, a single green arrow points to the drop-off (and only
 * while it too is off-screen). On-screen objectives get no arrow. Drawn in
 * screen space, so it must run after the world transform is restored. Used on
 * both daily and weekly maps. */
function drawEdgeArrows(
  ctx: CanvasRenderingContext2D,
  truck: TruckState,
  level: Level,
  visited: ReadonlySet<Warehouse>,
  camera: Camera,
  zoom: number,
  canvasW: number,
  canvasH: number,
): void {
  const unvisited = level.warehouses.filter((w) => w.kind === "pickup" && !visited.has(w));
  const done = unvisited.length === 0;

  // Launch the drop-off arrow on the exact frame the last pickup is collected;
  // reset once a fresh run has pickups outstanding again.
  const now = nowMs();
  if (done && !dropoffWasDone) dropoffShootStart = now;
  dropoffWasDone = done;

  let targets: Warehouse[];
  let color: string;
  if (!done) {
    targets = unvisited;
    color = PICKUP_ARROW_COLOR;
  } else {
    // All pickups collected: guide to the drop-off (and nothing else).
    const dest = level.warehouses.find((w) => w.kind === "destination");
    targets = dest ? [dest] : [];
    color = DROPOFF_ARROW_COLOR;
  }
  if (targets.length === 0) return;

  const toScreenX = (wx: number): number => (wx - camera.x) * zoom + canvasW / 2;
  const toScreenY = (wy: number): number => (wy - camera.y) * zoom + canvasH / 2;
  const ox = toScreenX(truck.pos.x);
  const oy = toScreenY(truck.pos.y);
  const margin = EDGE_ARROW_MARGIN;
  const diag = Math.hypot(level.width, level.height);

  // Eased 0->1 progress of the drop-off launch (fast start, settling at the
  // border). 1 (no animation) whenever we're still collecting pickups.
  let shoot = 1;
  if (done && dropoffShootStart != null) {
    const p = Math.min(1, (now - dropoffShootStart) / DROPOFF_SHOOT_MS);
    shoot = 1 - (1 - p) ** 3;
  }

  for (const target of targets) {
    const sx = toScreenX(target.pos.x);
    const sy = toScreenY(target.pos.y);
    // Objective already comfortably on screen: no arrow needed.
    if (sx >= margin && sx <= canvasW - margin && sy >= margin && sy <= canvasH - margin) continue;

    const hit = intersectBorder(ox, oy, sx, sy, margin, canvasW, canvasH);
    if (!hit) continue;

    const scale = edgeArrowScale(distance(truck.pos, target.pos), diag);
    // While shooting (shoot < 1) the drop-off arrow rides out from the truck to
    // its border spot; pickups and the settled drop-off arrow just sit there.
    const x = ox + (hit.x - ox) * shoot;
    const y = oy + (hit.y - oy) * shoot;
    drawEdgeArrow(ctx, x, y, Math.atan2(sy - oy, sx - ox), scale, color);
  }
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
/** Half-length of the truck along its heading - the point behind its centre
 * where the first cargo box hitches on. Mirrors TRUCK_HITCH_HALF_LENGTH in the
 * session so the drawn tow bar lines up with the trailing distance. */
const TRUCK_HITCH_HALF_LENGTH = 16;

/** A wooden crate (design C): rounded body whose longitudinal planks and end
 * corner-brackets *stretch* with the box length rather than tiling, so a full
 * four-unit box just looks like a longer crate. Fill still encodes stability
 * (brown -> orange -> red), same as before. */
function drawCargo(ctx: CanvasRenderingContext2D, cargo: CargoState): void {
  ctx.save();
  ctx.translate(cargo.pos.x, cargo.pos.y);
  ctx.rotate(cargo.heading);
  // Length (along travel) grows as the box fills; width is fixed.
  const len = cargo.length;
  const wid = CARGO_RENDER_WIDTH;
  const halfLen = len / 2;
  const halfWid = wid / 2;
  const stabilityColor = cargo.stability > 50 ? "#8a5a34" : cargo.stability > 25 ? "#b0632f" : "#c23b2a";

  ctx.beginPath();
  ctx.roundRect(-halfLen, -halfWid, len, wid, 2);
  ctx.fillStyle = stabilityColor;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Two planks running the length of the box - span the whole crate, so they
  // simply lengthen with it.
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-halfLen, -3);
  ctx.lineTo(halfLen, -3);
  ctx.moveTo(-halfLen, 3);
  ctx.lineTo(halfLen, 3);
  ctx.stroke();

  // A top-edge highlight and fixed-size corner brackets pinned to each end -
  // they hug the ends, so a longer box just spreads them apart.
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.beginPath();
  ctx.roundRect(-halfLen + 2, -halfWid + 1.5, len - 4, 2.5, 1);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-halfLen + 1.5, -halfWid + 1.5, 2.5, wid - 3);
  ctx.strokeRect(halfLen - 4, -halfWid + 1.5, 2.5, wid - 3);
  ctx.restore();
}

/** Draws a chain of trailing cargo boxes back-to-front (the box farthest
 * from the truck first) so nearer boxes correctly overlap farther ones
 * during tight turns. */
function drawCargoChain(ctx: CanvasRenderingContext2D, cargoBoxes: readonly CargoState[]): void {
  for (let i = cargoBoxes.length - 1; i >= 0; i--) drawCargo(ctx, cargoBoxes[i]!);
}

/** The point `half` units ahead of (`sign` = +1) or behind (`sign` = -1) a
 * centre, along its heading - i.e. a box's front/rear hitch point. */
function hitchPoint(pos: Vec2, heading: number, half: number, sign: number): Vec2 {
  return { x: pos.x + Math.cos(heading) * half * sign, y: pos.y + Math.sin(heading) * half * sign };
}

/** A short tow bar between two hitch points, with a small coupling knob at each
 * end. Drawn in world space (before the boxes) so the boxes sit on top of it. */
function drawConnector(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2): void {
  ctx.strokeStyle = "#20272f";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.fillStyle = "#3a4653";
  ctx.beginPath();
  ctx.arc(a.x, a.y, 2, 0, Math.PI * 2);
  ctx.arc(b.x, b.y, 2, 0, Math.PI * 2);
  ctx.fill();
}

/** Draws the tow bars linking the truck to the first box and each box to the
 * next, following the same rear -> front hitch chain the physics uses. */
function drawConnectors(ctx: CanvasRenderingContext2D, truck: TruckState, cargoBoxes: readonly CargoState[]): void {
  let leaderPos = truck.pos;
  let leaderHeading = truck.heading;
  let leaderHalf = TRUCK_HITCH_HALF_LENGTH;
  for (const box of cargoBoxes) {
    const rear = hitchPoint(leaderPos, leaderHeading, leaderHalf, -1);
    const front = hitchPoint(box.pos, box.heading, box.length / 2, 1);
    drawConnector(ctx, rear, front);
    leaderPos = box.pos;
    leaderHeading = box.heading;
    leaderHalf = box.length / 2;
  }
}

function drawTruck(ctx: CanvasRenderingContext2D, truck: TruckState): void {
  ctx.save();
  ctx.translate(truck.pos.x, truck.pos.y);
  ctx.rotate(truck.heading);

  // Wheels (drawn first so the body overlaps them), poking out at the corners.
  ctx.fillStyle = "#20272f";
  for (const [x, y] of [
    [-12, -12.5],
    [12, -12.5],
    [-12, 7.5],
    [12, 7.5],
  ] as const) {
    ctx.beginPath();
    ctx.roundRect(x - 3.5, y, 7, 5, 2);
    ctx.fill();
  }

  // Side mirrors on the cab.
  ctx.beginPath();
  ctx.roundRect(6, -13.5, 3, 2.5, 1);
  ctx.roundRect(6, 11, 3, 2.5, 1);
  ctx.fill();

  // Flatbed rear, then the cab up front (two-tone body).
  ctx.fillStyle = "#3a4653";
  ctx.beginPath();
  ctx.roundRect(-16, -10, 20, 20, 4);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#2b3440";
  ctx.beginPath();
  ctx.roundRect(3, -11, 13, 22, 5);
  ctx.fill();

  // Windshield.
  ctx.fillStyle = "#7fbced";
  ctx.beginPath();
  ctx.roundRect(4, -8, 7, 16, 3);
  ctx.fill();

  // Chrome grille bar and headlights at the nose.
  ctx.fillStyle = "#c9ccd1";
  ctx.beginPath();
  ctx.roundRect(14, -7, 2, 14, 1);
  ctx.fill();
  ctx.fillStyle = "#ffe9a8";
  ctx.beginPath();
  ctx.arc(15.5, -8, 1.6, 0, Math.PI * 2);
  ctx.arc(15.5, 8, 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Draws a complete rig - hitch connectors, the trailing cargo chain, then the
 * truck on top - so every place that shows a truck (you, ghosts, replay racers)
 * stays consistent. */
function drawTruckRig(ctx: CanvasRenderingContext2D, truck: TruckState, cargoBoxes: readonly CargoState[]): void {
  drawConnectors(ctx, truck, cargoBoxes);
  drawCargoChain(ctx, cargoBoxes);
  drawTruck(ctx, truck);
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

/** Paints the static world (ground, texture, roads, obstacles, houses, scenery,
 * warehouses) with the camera + zoom transform applied, and leaves that
 * transform in place so the caller can draw the moving actors on top and then
 * call ctx.restore(). Shared by the normal render and the replay render, which
 * differ only in the actors (and how the camera/zoom are chosen). */
function paintWorld(
  ctx: CanvasRenderingContext2D,
  level: Level,
  visited: ReadonlySet<Warehouse>,
  camera: Camera,
  zoom: number,
  canvasW: number,
  canvasH: number,
): void {
  // Area beyond the level bounds (visible near the world's edges) is the biome's
  // out-of-bounds material: sea for beaches, space for the moon, a chasm for
  // cliffs, and the ordinary grass color everywhere else.
  ctx.fillStyle = beyondFill(level);
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Center the camera on screen, then scale about that center so the truck
  // stays put while more of the world comes into view on small screens.
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
  // Decorative biome boundary around the map edges (never occludes the
  // objectives, which are drawn next, or the truck, drawn after paintWorld).
  drawBoundary(ctx, level, viewBounds);
  drawWarehouses(ctx, level, visited);
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
  const zoom = viewZoom(canvasW, canvasH);
  paintWorld(ctx, level, visited, camera, zoom, canvasW, canvasH);

  for (const ghost of ghosts) {
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    drawTruckRig(ctx, ghost.truck, ghost.cargoBoxes);
    ctx.restore();
    drawNameLabel(ctx, ghost.truck.pos, ghost.label);
  }

  drawTruckRig(ctx, truck, cargoBoxes);
  drawNameLabel(ctx, truck.pos, "you");

  ctx.restore();

  // Border arrows to any off-screen objective, drawn in screen space (after the
  // world transform is restored) so they pin to the viewport edges. Both maps.
  drawEdgeArrows(ctx, truck, level, visited, camera, zoom, canvasW, canvasH);
}

const REPLAY_NO_VISITED: ReadonlySet<Warehouse> = new Set();

/** One racer in a replay: an opaque, colour-tagged truck + cargo. */
export interface ReplayRacerView {
  truck: TruckState;
  cargoBoxes: readonly CargoState[];
  label: string;
  color: string;
}

/** A coloured name pill so each racer in a replay is tellable apart (drawn
 * outside the truck's rotation so the tag stays upright). */
function drawRacerTag(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, text: string, color: string): void {
  ctx.save();
  // Coloured name pill with dark text above the truck.
  ctx.font = "700 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = 7;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 16;
  const cx = pos.x;
  const cy = pos.y - 30;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 5);
  ctx.fill();
  ctx.fillStyle = "#12161c";
  ctx.fillText(text, cx, cy + 0.5);
  ctx.restore();
}

/** Renders a non-interactive replay: several racers on one level, all opaque
 * and colour-tagged (no "you" truck, no ghost transparency). The camera and
 * zoom are chosen by the caller (fit-all), so `zoom` is passed in rather than
 * derived from the canvas size. */
export function renderReplayWorld(
  ctx: CanvasRenderingContext2D,
  level: Level,
  racers: readonly ReplayRacerView[],
  camera: Camera,
  zoom: number,
  canvasW: number,
  canvasH: number,
): void {
  paintWorld(ctx, level, REPLAY_NO_VISITED, camera, zoom, canvasW, canvasH);
  for (const r of racers) {
    drawTruckRig(ctx, r.truck, r.cargoBoxes);
    drawRacerTag(ctx, r.truck.pos, r.label, r.color);
  }
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

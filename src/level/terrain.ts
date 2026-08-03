import { distance, type Vec2 } from "../util/vec2.js";
import type { Level, MudObstacle, RoughZone } from "./types.js";

export interface TerrainSample {
  onRoad: boolean;
  inMud: boolean;
  inRough: boolean;
  mud: MudObstacle | null;
  rough: RoughZone | null;
}

function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function isOnRoad(pos: Vec2, level: Level): boolean {
  for (const road of level.roads) {
    for (const sample of road.samples) {
      if (distance(pos, sample) <= road.width / 2) return true;
    }
  }
  return false;
}

export function sampleTerrain(pos: Vec2, level: Level): TerrainSample {
  const onRoad = isOnRoad(pos, level);

  let inMud = false;
  let mud: MudObstacle | null = null;
  for (const m of level.muds) {
    if (distance(pos, m.pos) > m.radius * 1.3) continue;
    if (pointInPolygon(pos, m.points)) {
      inMud = true;
      mud = m;
      break;
    }
  }

  let inRough = false;
  let rough: RoughZone | null = null;
  for (const r of level.roughZones) {
    if (distance(pos, r.pos) <= r.radius) {
      inRough = true;
      rough = r;
      break;
    }
  }

  return { onRoad, inMud, inRough, mud, rough };
}

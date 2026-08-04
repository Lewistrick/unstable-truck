import type { Vec2 } from "../util/vec2.js";

export interface Hub {
  id: number;
  pos: Vec2;
}

/** A single smooth road piece, plus a pre-sampled polyline used for fast distance queries. */
export interface RoadSegment {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  width: number;
  isBranch: boolean;
  samples: Vec2[];
}

export type WarehouseKind = "base" | "pickup" | "destination";

export interface Warehouse {
  kind: WarehouseKind;
  pos: Vec2;
  width: number;
  height: number;
  angle: number;
}

/** Purely decorative building: no gameplay value and no collision, just
 * scenery that makes the road network read like it connects real places
 * (used on the larger weekly maps). */
export interface House {
  pos: Vec2;
  width: number;
  height: number;
  angle: number;
}

export interface RockObstacle {
  pos: Vec2;
  radius: number;
}

/** Irregular blob approximated as a noise-perturbed polygon. */
export interface MudObstacle {
  pos: Vec2;
  radius: number;
  points: Vec2[];
}

export interface Palette {
  grass: string;
  grassAlt: string;
  road: string;
  roadLine: string;
  warehouseBase: string;
  warehousePickup: string;
  warehouseDestination: string;
  rock: string;
  mud: string;
  house: string;
}

export type LevelKind = "daily" | "weekly";

export interface Level {
  seed: string;
  /** "daily" is the standard small map; "weekly" is the larger map with
   * decorative houses and the on-screen guidance arrow. */
  kind: LevelKind;
  width: number;
  height: number;
  hubs: Hub[];
  roads: RoadSegment[];
  warehouses: Warehouse[];
  houses: House[];
  rocks: RockObstacle[];
  muds: MudObstacle[];
  palette: Palette;
}

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

export type WarehouseKind = "base" | "pickup" | "destination" | "decorative";

export interface Warehouse {
  kind: WarehouseKind;
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

export interface RoughZone {
  pos: Vec2;
  radius: number;
}

export interface Palette {
  hueOffset: number;
  grass: string;
  grassAlt: string;
  road: string;
  roadLine: string;
  warehouseBase: string;
  warehousePickup: string;
  warehouseDestination: string;
  warehouseDecorative: string;
  rock: string;
  mud: string;
  rough: string;
}

export interface Level {
  seed: string;
  width: number;
  height: number;
  hubs: Hub[];
  roads: RoadSegment[];
  warehouses: Warehouse[];
  rocks: RockObstacle[];
  muds: MudObstacle[];
  roughZones: RoughZone[];
  palette: Palette;
}

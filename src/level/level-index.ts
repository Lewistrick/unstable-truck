import type { Level } from "./types.js";
import type { Vec2 } from "../util/vec2.js";

/** A uniform-grid spatial index over a level's road samples, used to answer the
 * exact same "is this point on a road?" question as {@link isOnRoad} in
 * terrain.ts but in roughly O(1) instead of scanning every sample of every road.
 *
 * The headless solver (game/solver.ts) steps the physics millions of times, and
 * the off-road branch of the live `isOnRoad` scans *all* road samples before it
 * can answer "no". That linear scan dominates the solver's runtime, so this
 * index buckets each road sample into every grid cell its coverage disc
 * (radius = road.width / 2) touches. A query then only tests the samples in the
 * point's own cell. The result is bit-for-bit identical to `isOnRoad`, which is
 * essential: the solver's simulation must match live play exactly or a solved
 * input log wouldn't reproduce when replayed. */
export class LevelIndex {
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Per grid cell, the indices into the flat sample arrays that cover it. */
  private readonly buckets: number[][];
  private readonly sx: Float64Array;
  private readonly sy: Float64Array;
  /** (width/2)^2 for each sample, so the query compares squared distances. */
  private readonly sr2: Float64Array;

  constructor(level: Level, cellSize = 40) {
    this.cell = cellSize;
    this.cols = Math.max(1, Math.ceil(level.width / cellSize));
    this.rows = Math.max(1, Math.ceil(level.height / cellSize));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [] as number[]);

    let total = 0;
    for (const road of level.roads) total += road.samples.length;
    this.sx = new Float64Array(total);
    this.sy = new Float64Array(total);
    this.sr2 = new Float64Array(total);

    let i = 0;
    for (const road of level.roads) {
      const half = road.width / 2;
      for (const s of road.samples) {
        this.sx[i] = s.x;
        this.sy[i] = s.y;
        this.sr2[i] = half * half;
        // Insert this sample into every cell its coverage disc overlaps. Flooring
        // the min and flooring the max (inclusive) can only ever over-cover, so a
        // point within `half` of the sample is guaranteed to share a bucket with
        // it - no false negatives.
        const c0 = this.clampCol(Math.floor((s.x - half) / cellSize));
        const c1 = this.clampCol(Math.floor((s.x + half) / cellSize));
        const r0 = this.clampRow(Math.floor((s.y - half) / cellSize));
        const r1 = this.clampRow(Math.floor((s.y + half) / cellSize));
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) this.buckets[r * this.cols + c]!.push(i);
        }
        i++;
      }
    }
  }

  private clampCol(c: number): number {
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }
  private clampRow(r: number): number {
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  /** True when `pos` lies within some road's half-width of one of its samples -
   * identical to terrain.ts's `isOnRoad`, just accelerated by the grid. */
  isOnRoad(pos: Vec2): boolean {
    const c = this.clampCol(Math.floor(pos.x / this.cell));
    const r = this.clampRow(Math.floor(pos.y / this.cell));
    const bucket = this.buckets[r * this.cols + c]!;
    for (const idx of bucket) {
      const dx = pos.x - this.sx[idx]!;
      const dy = pos.y - this.sy[idx]!;
      if (dx * dx + dy * dy <= this.sr2[idx]!) return true;
    }
    return false;
  }
}

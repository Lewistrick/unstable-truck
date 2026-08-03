export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.y + b.y);
export const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.y - b.y);
export const scale = (a: Vec2, s: number): Vec2 => v(a.x * s, a.y * s);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));

export const normalize = (a: Vec2): Vec2 => {
  const len = length(a);
  return len < 1e-6 ? v(0, 0) : scale(a, 1 / len);
};

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 =>
  v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

export const clamp = (x: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, x));

/** Cubic Bezier point at t in [0,1]. */
export const bezierPoint = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return v(
    a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  );
};

/** Shortest signed angle difference from a to b, in radians. */
export const angleDiff = (a: number, b: number): number => {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
};

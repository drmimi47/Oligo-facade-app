/**
 * core/geometry.ts
 *
 * Pure geometry + data-model layer. No DOM, no React, no canvas.
 * Everything here works in MODEL coordinates (e.g. metres), never pixels.
 * This is the single source of truth for the perimeter shape.
 */

/** A point in model space (model units, e.g. metres). */
export interface Point {
  x: number;
  y: number;
}

/**
 * A perimeter vertex (anchor point).
 *
 * A vertex is a {@link Point} plus optional cubic-Bézier tangent handles that
 * make the adjacent segments CURVE instead of running straight. Handles are
 * stored as OFFSETS from the anchor (model units), so a handle automatically
 * follows its anchor when the vertex is moved.
 *
 *   - `handleOut` is the control point governing the segment LEAVING this vertex
 *     toward the NEXT vertex.
 *   - `handleIn` is the control point governing the segment ARRIVING from the
 *     PREVIOUS vertex.
 *
 * A segment a→b is a straight line when `a.handleOut` and `b.handleIn` are both
 * absent/zero; otherwise it is a cubic Bézier with control points
 * `a + a.handleOut` and `b + b.handleIn`. A vertex whose two handles are exact
 * negatives of each other is a SMOOTH point (continuous tangent); independent
 * handles make a CUSP. A vertex with no handles is a CORNER.
 *
 * Why Bézier rather than true circular arcs: the requested interaction is
 * "pull out the control handles", which is inherently a tangent-handle (pen
 * tool) model. Cubic handles give precise, directly-manipulable, non-destructive
 * control and still approximate circular arcs closely for curved walls.
 */
export interface Vertex extends Point {
  handleIn?: Point;
  handleOut?: Point;
}

/**
 * The perimeter data model.
 *
 * `vertices` is the ordered list of anchor points (with optional curve handles).
 * `closed` indicates whether the last vertex connects back to the first (a
 * closed building perimeter) or the polyline is still open / in progress.
 *
 * We intentionally keep this as a plain serializable object so it can later be
 * persisted, undone/redone, or fed into downstream facade logic.
 */
export interface Perimeter {
  vertices: Vertex[];
  closed: boolean;
}

export const emptyPerimeter = (): Perimeter => ({ vertices: [], closed: false });

/** Euclidean distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Angle of the segment a->b, in degrees, measured counter-clockwise from the
 * +X axis. Range (-180, 180]. We negate dy because in model space we treat +Y
 * as "up" (north), matching CAD convention, while screen Y grows downward —
 * the renderer handles the flip, so here we work in true model orientation.
 */
export function angleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// CUBIC-BÉZIER CURVE SUPPORT
//
// These helpers let a segment be either a straight line or a cubic Bézier,
// driven by the vertices' handle offsets. Lengths and areas are computed by
// FLATTENING curves into short line segments so readouts stay accurate.
// ---------------------------------------------------------------------------

/** How finely a curved segment is sampled for length/area/hit-testing. */
const CURVE_STEPS = 24;

function hasHandle(h: Point | undefined): h is Point {
  return !!h && (h.x !== 0 || h.y !== 0);
}

/** Is the segment a→b curved (i.e. does either adjacent handle exist)? */
export function isCurved(a: Vertex, b: Vertex): boolean {
  return hasHandle(a.handleOut) || hasHandle(b.handleIn);
}

/**
 * Absolute cubic control points [p0, c1, c2, p3] for the segment a→b. A missing
 * handle collapses its control point onto the anchor (a degenerate cubic that
 * still curves toward the present handle).
 */
export function segmentCubic(a: Vertex, b: Vertex): [Point, Point, Point, Point] {
  const c1 = a.handleOut ? { x: a.x + a.handleOut.x, y: a.y + a.handleOut.y } : { x: a.x, y: a.y };
  const c2 = b.handleIn ? { x: b.x + b.handleIn.x, y: b.y + b.handleIn.y } : { x: b.x, y: b.y };
  return [{ x: a.x, y: a.y }, c1, c2, { x: b.x, y: b.y }];
}

/** Evaluate a cubic Bézier at parameter t ∈ [0,1]. */
export function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Absolute screen-independent position of a vertex's handle, or null. */
export function handlePoint(v: Vertex, which: "in" | "out"): Point | null {
  const h = which === "in" ? v.handleIn : v.handleOut;
  if (!hasHandle(h)) return null;
  return { x: v.x + h.x, y: v.y + h.y };
}

/**
 * Split a cubic at parameter t into two cubics (De Casteljau). Used to insert a
 * vertex on a curved segment WITHOUT changing the curve's shape.
 */
export function splitCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): { left: [Point, Point, Point, Point]; right: [Point, Point, Point, Point] } {
  const lerp = (a: Point, b: Point, u: number): Point => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return { left: [p0, p01, p012, p0123], right: [p0123, p123, p23, p3] };
}

/**
 * Default handles that turn a straight segment a→b into a gentle, symmetric arc
 * bowing to the LEFT of the chord. Control points sit at 1/3 and 2/3 along the
 * chord, offset perpendicular by ~0.224·chord (a good circular-arc approximation
 * for a ~90° feel). Returns the handle offsets to store on a (out) and b (in).
 */
export function defaultArcHandles(a: Point, b: Point): { outOffset: Point; inOffset: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len; // unit along chord
  const px = -uy;
  const py = ux; // unit perpendicular (left of chord)
  const bow = len * 0.2236;
  const third = len / 3;
  return {
    outOffset: { x: ux * third + px * bow, y: uy * third + py * bow },
    inOffset: { x: -ux * third + px * bow, y: -uy * third + py * bow },
  };
}

/**
 * Flatten a single segment a→b into the list of points AFTER a (so segments can
 * be chained). Straight segments return just [b]; curves return CURVE_STEPS
 * samples ending at b.
 */
export function flattenSegment(a: Vertex, b: Vertex, steps: number = CURVE_STEPS): Point[] {
  if (!isCurved(a, b)) return [{ x: b.x, y: b.y }];
  const [p0, p1, p2, p3] = segmentCubic(a, b);
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) pts.push(cubicAt(p0, p1, p2, p3, i / steps));
  return pts;
}

/**
 * Flatten the whole perimeter into a dense polyline (model space). For a closed
 * perimeter the final point equals the first (the loop is explicitly closed).
 */
export function flattenPerimeter(p: Perimeter, steps: number = CURVE_STEPS): Point[] {
  const v = p.vertices;
  if (v.length === 0) return [];
  const out: Point[] = [{ x: v[0].x, y: v[0].y }];
  for (let i = 0; i < v.length - 1; i++) out.push(...flattenSegment(v[i], v[i + 1], steps));
  if (p.closed && v.length >= 3) out.push(...flattenSegment(v[v.length - 1], v[0], steps));
  return out;
}

/** Total length of all segments (curve-accurate). Includes the closing segment if `closed`. */
export function perimeterLength(p: Perimeter): number {
  const pts = flattenPerimeter(p);
  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += distance(pts[i], pts[i + 1]);
  return total;
}

/**
 * Enclosed area via the shoelace formula on the FLATTENED outline (curve-accurate).
 * Only meaningful for a closed perimeter with >= 3 vertices. Returns the ABSOLUTE
 * area (orientation-independent) so the user always sees a positive value.
 */
export function enclosedArea(p: Perimeter): number {
  if (!p.closed || p.vertices.length < 3) return 0;
  const pts = flattenPerimeter(p);
  // pts ends with a duplicate of pts[0] (closed loop); iterate the unique n points.
  const n = pts.length - 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Snap a model-space value to the nearest multiple of `spacing`. */
export function snapValue(value: number, spacing: number): number {
  if (spacing <= 0) return value;
  return Math.round(value / spacing) * spacing;
}

/** Snap a model-space point to the grid. */
export function snapPoint(p: Point, spacing: number): Point {
  return { x: snapValue(p.x, spacing), y: snapValue(p.y, spacing) };
}

/**
 * Constrain point `to` relative to anchor `from` onto the nearest line at a
 * multiple of `stepDeg` degrees (e.g. 45 -> 0/45/90/135...). Used for the
 * Shift orthogonal/angle constraint while drawing. Preserves the projected
 * distance along the chosen direction.
 */
export function constrainAngle(from: Point, to: Point, stepDeg: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...to };
  const raw = Math.atan2(dy, dx);
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(raw / step) * step;
  return { x: from.x + Math.cos(snapped) * len, y: from.y + Math.sin(snapped) * len };
}

/**
 * Produce a point a given `length` and `angleDeg` away from `from`.
 * Used for direct numeric entry of the next segment.
 */
export function pointFromPolar(from: Point, length: number, angleDegrees: number): Point {
  const a = (angleDegrees * Math.PI) / 180;
  return { x: from.x + Math.cos(a) * length, y: from.y + Math.sin(a) * length };
}

/** Distance from point `p` to segment `a`-`b`, plus the closest point on it. */
export function pointToSegment(p: Point, a: Point, b: Point): { dist: number; closest: Point; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const closest = { x: a.x + abx * t, y: a.y + aby * t };
  return { dist: distance(p, closest), closest, t };
}

/**
 * Hit-test vertices. Returns the index of the nearest vertex within
 * `toleranceModel` model units, or -1. Nearest wins on ties.
 */
export function hitVertex(p: Perimeter, target: Point, toleranceModel: number): number {
  let best = -1;
  let bestDist = toleranceModel;
  for (let i = 0; i < p.vertices.length; i++) {
    const d = distance(p.vertices[i], target);
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Hit-test segments for inserting a vertex. Returns the index `i` such that the
 * new vertex should be inserted between vertex i and i+1, the projected point on
 * that segment, and the parameter `t ∈ [0,1]` ALONG that segment (used to split a
 * curve cleanly). Returns null if nothing is within tolerance. Curved segments
 * are sampled so curves are clickable too.
 */
export function hitSegment(
  p: Perimeter,
  target: Point,
  toleranceModel: number,
): { index: number; point: Point; t: number } | null {
  const v = p.vertices;
  if (v.length < 2) return null;
  let best: { index: number; point: Point; t: number } | null = null;
  let bestDist = toleranceModel;
  const segCount = p.closed ? v.length : v.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    if (!isCurved(a, b)) {
      const { dist, closest, t } = pointToSegment(target, a, b);
      if (dist <= bestDist) {
        bestDist = dist;
        best = { index: i, point: closest, t };
      }
    } else {
      // Walk the flattened cubic; map the closest sub-segment back to a global t.
      const [p0, p1, p2, p3] = segmentCubic(a, b);
      const N = 32;
      let prev = p0;
      for (let s = 1; s <= N; s++) {
        const cur = cubicAt(p0, p1, p2, p3, s / N);
        const { dist, closest, t } = pointToSegment(target, prev, cur);
        if (dist <= bestDist) {
          bestDist = dist;
          best = { index: i, point: closest, t: (s - 1 + t) / N };
        }
        prev = cur;
      }
    }
  }
  return best;
}

/**
 * Hit-test the two handle knobs of vertex `index`. Returns which handle was hit
 * ("in" or "out") within `toleranceModel`, or null. Only the given vertex's
 * handles are tested (handles are shown for the selected/active vertex only).
 */
export function hitHandle(
  p: Perimeter,
  index: number,
  target: Point,
  toleranceModel: number,
): "in" | "out" | null {
  if (index < 0 || index >= p.vertices.length) return null;
  const v = p.vertices[index];
  let best: "in" | "out" | null = null;
  let bestDist = toleranceModel;
  const hi = handlePoint(v, "in");
  if (hi) {
    const d = distance(hi, target);
    if (d <= bestDist) {
      bestDist = d;
      best = "in";
    }
  }
  const ho = handlePoint(v, "out");
  if (ho) {
    const d = distance(ho, target);
    if (d <= bestDist) {
      bestDist = d;
      best = "out";
    }
  }
  return best;
}

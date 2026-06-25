/**
 * core/perimeterOps.ts
 *
 * Non-destructive operations on the Perimeter data model. Every function
 * returns a NEW Perimeter (immutable updates), so the model stays the single
 * source of truth and history/undo can be layered on later.
 *
 * Curve handles are stored on vertices as offsets (see core/geometry.ts). These
 * ops add/clear/edit those handles so segments can be straight lines or cubic
 * Bézier curves without ever mutating shared state.
 */

import type { Perimeter, Point, Vertex } from "./geometry";
import { defaultArcHandles, segmentCubic, splitCubic, isCurved } from "./geometry";

export function addVertex(p: Perimeter, pt: Point): Perimeter {
  if (p.closed) return p;
  // Strip any incoming handle data — a freshly placed vertex starts as a corner.
  return { ...p, vertices: [...p.vertices, { x: pt.x, y: pt.y }] };
}

export function close(p: Perimeter): Perimeter {
  if (p.closed || p.vertices.length < 3) return p;
  return { ...p, closed: true };
}

/** Move a vertex to a new position, PRESERVING its curve handles (offsets). */
export function moveVertex(p: Perimeter, index: number, pt: Point): Perimeter {
  if (index < 0 || index >= p.vertices.length) return p;
  const vertices = p.vertices.slice();
  vertices[index] = { ...vertices[index], x: pt.x, y: pt.y };
  return { ...p, vertices };
}

/**
 * Delete a vertex. If deletion would drop a closed polygon below 3 vertices,
 * we also reopen it (a polygon needs >=3 points to be valid).
 */
export function deleteVertex(p: Perimeter, index: number): Perimeter {
  if (index < 0 || index >= p.vertices.length) return p;
  const vertices = p.vertices.slice();
  vertices.splice(index, 1);
  const closed = p.closed && vertices.length >= 3;
  return { vertices, closed };
}

/** Remove the last vertex (used during drawing to undo the last click). */
export function popVertex(p: Perimeter): Perimeter {
  if (p.closed || p.vertices.length === 0) return p;
  return { ...p, vertices: p.vertices.slice(0, -1) };
}

// ---------------------------------------------------------------------------
// CURVE / HANDLE OPERATIONS
// ---------------------------------------------------------------------------

/**
 * Set one of a vertex's handle offsets. When `mirror` is true the opposite
 * handle is set to the exact negative, producing a SMOOTH point with a
 * continuous tangent (the default when pulling handles); when false the handles
 * are independent, producing a CUSP (e.g. Alt-drag to break the tangent).
 */
export function setHandle(
  p: Perimeter,
  index: number,
  which: "in" | "out",
  offset: Point,
  mirror: boolean,
): Perimeter {
  if (index < 0 || index >= p.vertices.length) return p;
  const vertices = p.vertices.slice();
  const v: Vertex = { ...vertices[index] };
  const opposite: Point = { x: -offset.x, y: -offset.y };
  if (which === "out") {
    v.handleOut = { ...offset };
    if (mirror) v.handleIn = opposite;
  } else {
    v.handleIn = { ...offset };
    if (mirror) v.handleOut = opposite;
  }
  vertices[index] = v;
  return { ...p, vertices };
}

/** Remove both handles from a vertex, turning it back into a sharp corner. */
export function clearVertexHandles(p: Perimeter, index: number): Perimeter {
  if (index < 0 || index >= p.vertices.length) return p;
  const vertices = p.vertices.slice();
  const v: Vertex = { ...vertices[index] };
  delete v.handleIn;
  delete v.handleOut;
  vertices[index] = v;
  return { ...p, vertices };
}

/** Valid segment count: closed perimeters have one more (the closing segment). */
function segmentCount(p: Perimeter): number {
  return p.closed ? p.vertices.length : p.vertices.length - 1;
}

/**
 * Turn segment `index` (between vertex index and index+1, wrapping when closed)
 * into a gentle arc by giving its endpoints default Bézier handles.
 */
export function makeSegmentArc(p: Perimeter, index: number): Perimeter {
  const n = p.vertices.length;
  if (index < 0 || index >= segmentCount(p)) return p;
  const ai = index;
  const bi = (index + 1) % n;
  const { outOffset, inOffset } = defaultArcHandles(p.vertices[ai], p.vertices[bi]);
  const vertices = p.vertices.slice();
  vertices[ai] = { ...vertices[ai], handleOut: { ...outOffset } };
  vertices[bi] = { ...vertices[bi], handleIn: { ...inOffset } };
  return { ...p, vertices };
}

/** Turn segment `index` back into a straight line by clearing its two handles. */
export function makeSegmentLine(p: Perimeter, index: number): Perimeter {
  const n = p.vertices.length;
  if (index < 0 || index >= segmentCount(p)) return p;
  const ai = index;
  const bi = (index + 1) % n;
  const vertices = p.vertices.slice();
  const a: Vertex = { ...vertices[ai] };
  delete a.handleOut;
  const b: Vertex = { ...vertices[bi] };
  delete b.handleIn;
  vertices[ai] = a;
  vertices[bi] = b;
  return { ...p, vertices };
}

/**
 * Insert a vertex on segment `index` at parameter `t`. For a straight segment
 * the `fallback` point (already projected onto the segment) is used. For a curve
 * the cubic is split with De Casteljau so the shape is preserved exactly, and
 * the surrounding handles are rewritten to match the two new sub-curves.
 *
 * Returns the updated perimeter and the index of the newly inserted vertex.
 */
export function insertVertexOnSegment(
  p: Perimeter,
  index: number,
  t: number,
  fallback: Point,
): { perimeter: Perimeter; newIndex: number } {
  const n = p.vertices.length;
  if (index < 0 || index >= segmentCount(p)) return { perimeter: p, newIndex: -1 };
  const ai = index;
  const bi = (index + 1) % n;
  const a = p.vertices[ai];
  const b = p.vertices[bi];
  const vertices = p.vertices.slice();

  if (!isCurved(a, b)) {
    vertices.splice(ai + 1, 0, { x: fallback.x, y: fallback.y });
    return { perimeter: { ...p, vertices }, newIndex: ai + 1 };
  }

  const [p0, p1, p2, p3] = segmentCubic(a, b);
  const { left, right } = splitCubic(p0, p1, p2, p3, t);
  const mid = left[3]; // == right[0], the new anchor

  vertices[ai] = { ...a, handleOut: { x: left[1].x - a.x, y: left[1].y - a.y } };
  vertices[bi] = { ...b, handleIn: { x: right[2].x - b.x, y: right[2].y - b.y } };
  const newVertex: Vertex = {
    x: mid.x,
    y: mid.y,
    handleIn: { x: left[2].x - mid.x, y: left[2].y - mid.y },
    handleOut: { x: right[1].x - mid.x, y: right[1].y - mid.y },
  };
  vertices.splice(ai + 1, 0, newVertex);
  return { perimeter: { ...p, vertices }, newIndex: ai + 1 };
}

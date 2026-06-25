/**
 * core/unravel.ts
 *
 * Pure geometry for "unravelling" (unwrapping) a perimeter: take the closed
 * shape's edges in CLOCKWISE order and lay each one out as a horizontal segment
 * along the baseline (model y = 0), left to right, with a fixed gap between them.
 *
 * This is the facade/elevation use-case: a building footprint's walls unrolled
 * flat. The defining requirement is that **each unravelled segment keeps the
 * exact length of the original edge** — straight edges use their chord length,
 * curved (Bézier) edges use their true ARC length (so a curved wall unrolls to a
 * straight strip of the same running length).
 *
 * No DOM/React/canvas here — this only produces model-space data; the renderer
 * draws it and the input layer toggles it.
 */

import type { Perimeter, Point, Vertex } from "./geometry";
import { distance, isCurved, flattenSegment, flattenPerimeter } from "./geometry";

/** One edge of the perimeter, laid out horizontally on the baseline (y = 0). */
export interface UnravelSegment {
  /** Index of the originating edge in the source perimeter. */
  index: number;
  /** Preserved length of the edge (chord for lines, arc length for curves). */
  length: number;
  /** Model-space start x on the baseline. */
  x0: number;
  /** Model-space end x on the baseline (x0 + length). */
  x1: number;
  /** True if the source edge was a curve (rendered distinctly when unrolled). */
  curved: boolean;
}

export interface UnravelResult {
  segments: UnravelSegment[];
  /** Sum of all segment lengths (the total running length of the walls). */
  totalLength: number;
  /** Full horizontal extent occupied, including the gaps between segments. */
  totalWidth: number;
  /** Whether the source was traversed clockwise (always true for closed shapes). */
  clockwise: boolean;
}

/** True length of edge a→b: chord for a line, arc length for a curve. */
function edgeLength(a: Vertex, b: Vertex): number {
  if (!isCurved(a, b)) return distance(a, b);
  // flattenSegment returns the sampled points AFTER a; walk from a through them.
  let len = 0;
  let prev: Point = a;
  for (const pt of flattenSegment(a, b)) {
    len += distance(prev, pt);
    prev = pt;
  }
  return len;
}

/**
 * Signed area of the (flattened) closed outline. With model +Y pointing up, a
 * POSITIVE signed area means the vertices wind counter-clockwise. Used to decide
 * whether to reverse edge order so the unravel proceeds clockwise.
 */
function isCounterClockwise(p: Perimeter): boolean {
  const pts = flattenPerimeter(p);
  const n = pts.length - 1; // last point duplicates the first on a closed loop
  if (n < 3) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum > 0;
}

/**
 * Unravel `p` into horizontal baseline segments in clockwise order, separated by
 * `gap` (model units). The strip is centred on the origin so it fits naturally.
 *
 * For a closed perimeter every edge (including the closing edge) is included and
 * ordered clockwise. For an open polyline there is no winding, so edges are taken
 * in draw order. Returns an empty result for fewer than 2 vertices.
 */
export function unravelPerimeter(p: Perimeter, gap: number): UnravelResult {
  const v = p.vertices;
  const n = v.length;
  const empty: UnravelResult = { segments: [], totalLength: 0, totalWidth: 0, clockwise: false };
  if (n < 2) return empty;

  const edgeCount = p.closed ? n : n - 1;
  const edges: { index: number; length: number; curved: boolean }[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = v[i];
    const b = v[(i + 1) % n];
    edges.push({ index: i, length: edgeLength(a, b), curved: isCurved(a, b) });
  }

  // Order clockwise. Reversing the edge list flips a CCW winding to CW; lengths
  // are orientation-independent, so only the order changes.
  const clockwise = p.closed && n >= 3;
  if (clockwise && isCounterClockwise(p)) edges.reverse();

  const g = Math.max(0, gap);
  let cursor = 0;
  const segments: UnravelSegment[] = edges.map((e) => {
    const seg: UnravelSegment = { index: e.index, length: e.length, curved: e.curved, x0: cursor, x1: cursor + e.length };
    cursor += e.length + g;
    return seg;
  });

  const totalWidth = segments.length ? cursor - g : 0;
  const totalLength = edges.reduce((s, e) => s + e.length, 0);

  // Centre the strip on the origin so a fit-to-bounds viewport frames it nicely.
  const shift = totalWidth / 2;
  for (const s of segments) {
    s.x0 -= shift;
    s.x1 -= shift;
  }

  return { segments, totalLength, totalWidth, clockwise };
}

/**
 * Build a throwaway open Perimeter from an unravel layout's RECTANGLE corners, so
 * the existing `fitViewport` can frame the whole strip without duplicating bounds
 * math. Each edge is a rectangle from the baseline (y = 0) up to its OWN height,
 * so we include both the baseline endpoints AND the rectangle tops; this guarantees
 * the full vertical extent (the TALLEST panel) is framed and nothing is clipped.
 *
 * Heights are PER-PANEL: pass `heightOf(seg)` returning each segment's effective
 * height. A single number is also accepted as a convenience (uniform height).
 */
export function unravelBoundsPerimeter(
  segments: UnravelSegment[],
  height: number | ((seg: UnravelSegment) => number) = 0,
): Perimeter {
  const heightOf = typeof height === "function" ? height : () => height;
  const vertices: Vertex[] = [];
  for (const s of segments) {
    const top = Math.max(heightOf(s), 0);
    vertices.push({ x: s.x0, y: 0 });
    vertices.push({ x: s.x1, y: 0 });
    vertices.push({ x: s.x1, y: top });
    vertices.push({ x: s.x0, y: top });
  }
  return { vertices, closed: false };
}

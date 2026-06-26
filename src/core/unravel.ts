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

/** Most equal columns a single Subtractive recommendation will divide a panel into
 *  (caps the line count for absurdly thin desired widths near the panel border). */
const MAX_EQUAL_COLUMNS = 200;

/**
 * Build the x-positions (MODEL units) of the vertical DIVISION lines that split an
 * unravel panel into N EQUAL-WIDTH columns, where N is the iteration whose equal
 * column width best matches the cursor's position. This drives the Subtractive
 * tool's recommendations: hovering a panel suggests an even subdivision (2, 3, 4 …
 * equal columns) rather than grid-snapped lines.
 *
 * Mapping: the desired column width is the cursor's distance from the panel's LEFT
 * border (`cursorX - x0`); N is the nearest whole count that divides the panel
 * evenly into columns of that width (`round(panelWidth / desired)`), clamped to
 * `[2, MAX_EQUAL_COLUMNS]`. The returned lines are `x0 + i·(panelWidth/N)` for
 * `i = 1 … N-1`, so all N columns are exactly equal. Pure: used by the live
 * hover/drag preview AND the commit, so they always agree.
 *
 * Returns MODEL x positions ascending, strictly within (x0, x1). A cursor at or
 * left of the left border yields no recommendation (`[]`).
 */
export function buildEqualColumns(cursorX: number, x0: number, x1: number): number[] {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const width = hi - lo;
  const EPS = 1e-9;
  if (width <= EPS) return [];

  // Desired column width = cursor's distance from the left border.
  const desired = cursorX - lo;
  if (desired <= EPS) return [];

  // Nearest equal-column COUNT matching that desired width (≥ 2 so it's a real split).
  const n = Math.max(2, Math.min(MAX_EQUAL_COLUMNS, Math.round(width / desired)));
  const step = width / n;
  const xs: number[] = [];
  for (let i = 1; i < n; i++) xs.push(lo + i * step);
  return xs;
}

/**
 * Build the y-positions (MODEL units) of the horizontal DIVISION lines that split an
 * unravel panel into EQUAL-HEIGHT rows — the HORIZONTAL mirror of
 * {@link buildEqualColumns}. This drives the Subtractive tool's recommendation when
 * Shift is held: hovering a panel suggests an even subdivision (2, 3, 4 … equal rows)
 * stacked from the baseline up, rather than equal columns.
 *
 * FLOOR-PLATE GUIDES. `guides` carries the floor-plate elevations (MODEL y, same space
 * as the panel baseline `y0 = 0`). Any guide that falls strictly INSIDE the panel is a
 * hard boundary the array must align to: the panel is split into bands at the baseline,
 * each interior floor plate, and the top, and EACH band is independently subdivided into
 * equal rows whose height best matches the cursor's desired height. The guide elevations
 * themselves are emitted as division lines, so an array line always lands exactly ON
 * every floor plate present (the user's requirement). With no interior guide this falls
 * back to a single even split across the whole panel.
 *
 * Mapping: the desired row HEIGHT is the cursor's distance from the panel's BASELINE
 * (`cursorY - y0`). For each band of height `bandH` the row count is
 * `round(bandH / desired)`, clamped (≥ 1 per band; ≥ 2 overall for the no-guide case),
 * so every band's rows are as close to the desired height as an even fit allows. Pure:
 * used by BOTH the live hover/drag preview AND the commit, so they always agree.
 *
 * Returns MODEL y positions ascending, strictly within (y0, y1). A cursor at or below
 * the baseline yields no recommendation (`[]`).
 */
export function buildEqualRows(
  cursorY: number,
  y0: number,
  y1: number,
  guides: number[] = [],
): number[] {
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  const height = hi - lo;
  const EPS = 1e-9;
  if (height <= EPS) return [];

  // Desired row height = cursor's distance from the baseline (bottom) border.
  const desired = cursorY - lo;
  if (desired <= EPS) return [];

  // Floor-plate guides strictly inside the panel become hard band boundaries. The
  // tolerance (1e-6) drops guides sitting on the baseline/top so they don't create a
  // zero-height band; Set de-dups coincident plates.
  const inner = Array.from(
    new Set(guides.filter((g) => g > lo + 1e-6 && g < hi - 1e-6)),
  ).sort((a, b) => a - b);

  if (inner.length === 0) {
    // No guides: even rows across the whole panel (original behaviour).
    const n = Math.max(2, Math.min(MAX_EQUAL_COLUMNS, Math.round(height / desired)));
    const step = height / n;
    const ys: number[] = [];
    for (let i = 1; i < n; i++) ys.push(lo + i * step);
    return ys;
  }

  // Guides present: subdivide each band [baseline, guides…, top] independently and
  // emit each interior guide so an array line lands on every floor plate.
  const bounds = [lo, ...inner, hi];
  const out: number[] = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const a = bounds[b];
    const c = bounds[b + 1];
    const bandH = c - a;
    if (bandH <= EPS) continue;
    // ≥ 1 row per band (a band may be too short for the desired height → no interior
    // line, just its bounding floor plates).
    const n = Math.max(1, Math.min(MAX_EQUAL_COLUMNS, Math.round(bandH / desired)));
    const step = bandH / n;
    for (let i = 1; i < n; i++) out.push(a + i * step);
    // Emit the upper boundary when it's an interior guide (not the panel top), so the
    // floor plate itself is a division line. Each interior guide is the upper bound of
    // exactly one band, so it's added once.
    if (b < bounds.length - 2) out.push(c);
  }
  return out.sort((x, y) => x - y);
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

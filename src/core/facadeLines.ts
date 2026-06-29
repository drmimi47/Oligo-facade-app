/**
 * core/facadeLines.ts
 *
 * Pure, DOM-free builder that turns a facade's per-wall CENTERLINES and FRAMING
 * (the overlay the elevation/unravel view draws on each panel) into polylines ready
 * for {@link core/exporters} to serialise — in BOTH the 3D and 2D export layouts.
 *
 * WHY this exists: the editor stores centerlines / framing in PANEL space — offsets
 * measured along each unrolled wall strip (u, "arc length from the wall's start
 * vertex") and heights (z, above the baseline). We capture that overlay ONCE as
 * wall-local EDGE SEGMENTS (each a constant-u vertical or constant-z horizontal line)
 * and then map it two ways:
 *
 *   • {@link buildFacadeLines} (3D): map (u, z) back onto the real wall plane — a point
 *     at arc-offset `u` is found by walking the wall's flattened ground polyline (so
 *     CURVED walls map faithfully, not as a chord), then lifted to height `z`.
 *   • {@link buildFacadeLines2D} (2D): lay each wall out FLAT in the unravel strip,
 *     exactly like the elevations view — the panel sits at its strip x-position with
 *     (u, z) placed at (x0 + u, z) on the ground plane (Z = 0).
 *
 * The wall-local capture is independent of the strip layout (every stored offset is
 * wall-LOCAL: divisions are offsets from the wall start, the equal-cell grid is
 * `length·k/N`), so the 3D path needs only each wall's own length; the 2D path adds
 * the strip x-position from {@link unravelPerimeter}. Either way the builder is a pure
 * function of the perimeter + saved records.
 *
 * Output groups two line sets per wall — `centerlines` and `framing` — matching the
 * two export sub-layers. A wall with neither yields empty arrays, so the exporter
 * creates a sub-layer only when it carries geometry.
 */

import type { Perimeter, Point } from "./geometry";
import { distance, flattenSegment } from "./geometry";
import type { CellInsets } from "./savedPerimeters";
import { unravelPerimeter } from "./unravel";

/** A point in 3D model space (X east, Y north, Z up) — feet, like the rest of the model. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The per-wall facade records the builder reads. Each map is keyed by the ORIGINAL
 * perimeter edge index (the same key the editor and {@link buildMassing} use), so a
 * wall's lines line up with its `WALL_<edge>` massing. All absent entries default to
 * "nothing" (no cells beyond 1, no divisions, no mullion width, no cell framing).
 */
export interface FacadeRecords {
  /** Per-edge equal-cell split COUNT (N → N−1 evenly spaced vertical centerlines). */
  cells: Record<number, number>;
  /** Per-edge vertical DIVISION offsets (u: arc length from the wall start). */
  divisions: Record<number, number[]>;
  /** Per-edge HORIZONTAL divider offsets (z: height above the baseline). */
  dividersH: Record<number, number[]>;
  /** Per-edge VERTICAL mullion half-width (Stick): faces sit at each grid line ± this. */
  mullionsV: Record<number, number>;
  /** Per-edge HORIZONTAL mullion half-width (Stick). */
  mullionsH: Record<number, number>;
  /** Per-edge UNITIZED cell framing: cell index (cellsForEdge order) → four-edge insets. */
  cellFraming: Record<number, Record<number, CellInsets>>;
}

/** 3D centerline + framing polylines for one wall, split by export sub-layer. */
export interface FacadeEdgeLines {
  /** Originating perimeter edge index (matches the `WALL_<edge>` massing layer). */
  edge: number;
  /** Centerline polylines (cell splits, vertical divisions, horizontal dividers). */
  centerlines: Vec3[][];
  /** Framing polylines (Stick mullion faces, Unitized cell-frame faces). */
  framing: Vec3[][];
}

/** A wall's flattened ground polyline + cumulative arc length, for u→point lookup. */
interface EdgePolyline {
  pts: Point[];
  /** cum[i] = arc length from pts[0] to pts[i]; cum[last] = total length. */
  cum: number[];
  length: number;
}

/** Build the ground polyline (curves sampled) for edge `edge`, start vertex → end. */
function edgePolyline(p: Perimeter, edge: number): EdgePolyline {
  const v = p.vertices;
  const n = v.length;
  const a = v[edge];
  const b = v[(edge + 1) % n];
  // flattenSegment returns the points AFTER `a` (just [b] for a straight edge), so the
  // full polyline is `a` followed by those — chord for lines, sampled arc for curves.
  const pts: Point[] = [{ x: a.x, y: a.y }, ...flattenSegment(a, b)];
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

/** Ground point at arc-offset `u` along the polyline (clamped to its ends). */
function pointAtArc(poly: EdgePolyline, u: number): Point {
  const { pts, cum, length } = poly;
  if (u <= 0) return pts[0];
  if (u >= length) return pts[pts.length - 1];
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < u) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 1e-9 ? (u - cum[i]) / segLen : 0;
  return {
    x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
    y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
  };
}

/** A VERTICAL wall line at arc-offset `u`, rising from `z0` to `z1` (a 2-point line). */
function verticalLine(poly: EdgePolyline, u: number, z0: number, z1: number): Vec3[] {
  const p = pointAtArc(poly, u);
  return [{ x: p.x, y: p.y, z: z0 }, { x: p.x, y: p.y, z: z1 }];
}

/**
 * A HORIZONTAL wall line at height `z`, spanning arc `u0`→`u1`. Follows the wall's
 * curve by threading every flattened vertex strictly between the endpoints, so a
 * horizontal line on a curved wall bends with it instead of cutting the chord.
 */
function horizontalLine(poly: EdgePolyline, u0: number, u1: number, z: number): Vec3[] {
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  const out: Vec3[] = [];
  const start = pointAtArc(poly, lo);
  out.push({ x: start.x, y: start.y, z });
  for (let i = 0; i < poly.pts.length; i++) {
    if (poly.cum[i] > lo + 1e-9 && poly.cum[i] < hi - 1e-9) {
      out.push({ x: poly.pts[i].x, y: poly.pts[i].y, z });
    }
  }
  const end = pointAtArc(poly, hi);
  out.push({ x: end.x, y: end.y, z });
  return out;
}

/** Clamp `v` to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Sort ascending and drop near-duplicates (within `eps`). */
function dedupe(arr: number[], eps = 1e-6): number[] {
  const sorted = [...arr].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || Math.abs(v - out[out.length - 1]) > eps) out.push(v);
  return out;
}

/**
 * The wall's cell grid in WALL-LOCAL coordinates (u along the wall, z height), in the
 * SAME index order as the editor's `cellsForEdge` (outer loop over u-bounds, inner over
 * z-bounds). Computing it in arc space — rather than unravel-layout space — drops the
 * dependency on the strip's x positions while keeping cell INDICES identical, so the
 * per-cell framing insets (keyed by that index) line up.
 */
function cellGrid(length: number, height: number, nCells: number, divisions: number[], dividersH: number[]) {
  const us = [0, length];
  for (let k = 1; k < nCells; k++) us.push((length * k) / nCells);
  for (const off of divisions) us.push(off);
  const zs = [0, height];
  for (const off of dividersH) if (off > 0 && off < height) zs.push(off);
  const vu = dedupe(us);
  const vz = dedupe(zs);
  const cells: { u0: number; u1: number; z0: number; z1: number }[] = [];
  for (let i = 0; i < vu.length - 1; i++)
    for (let j = 0; j < vz.length - 1; j++)
      cells.push({ u0: vu[i], u1: vu[i + 1], z0: vz[j], z1: vz[j + 1] });
  return cells;
}

/**
 * One wall-local facade line: a VERTICAL line at constant arc-offset `u` (z spanning
 * `z0`→`z1`) or a HORIZONTAL line at constant height `z` (u spanning `u0`→`u1`). This
 * is the layout-independent capture both the 3D and 2D mappers consume.
 */
type EdgeSeg =
  | { kind: "v"; u: number; z0: number; z1: number }
  | { kind: "h"; z: number; u0: number; u1: number };

/** A wall's captured facade overlay in wall-local (u, z) space, split by sub-layer. */
interface EdgeSegs {
  edge: number;
  /** Wall length (u extent) and height (z extent). */
  length: number;
  height: number;
  centerlines: EdgeSeg[];
  framing: EdgeSeg[];
}

/**
 * Capture each selected wall's centerlines + framing as wall-local {@link EdgeSeg}s —
 * the single source both export layouts map from. Mirrors exactly what the elevation
 * renderer draws: equal-cell splits + user divisions as vertical centerlines, user
 * dividers as horizontal centerlines, Stick mullion FACES at each grid line ± the
 * half-width, and Unitized cell-frame inset faces.
 */
function buildEdgeSegs(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  records: FacadeRecords,
): EdgeSegs[] {
  const v = perimeter.vertices;
  const n = v.length;
  if (n < 2) return [];

  const result: EdgeSegs[] = [];
  // Stable order so the export is deterministic regardless of Set iteration order.
  const sorted = [...edges].sort((a, b) => a - b);

  for (const edge of sorted) {
    if (edge < 0 || edge >= n) continue;
    const length = edgePolyline(perimeter, edge).length;
    if (length <= 1e-9) continue;
    const h = heightOf(edge);

    const nCells = Math.max(1, Math.round(records.cells[edge] ?? 1));
    const divisions = records.divisions[edge] ?? [];
    const dividersH = (records.dividersH[edge] ?? []).filter((z) => z > 0 && z < h);
    const mv = records.mullionsV[edge] ?? 0;
    const mh = records.mullionsH[edge] ?? 0;
    const framingByCell = records.cellFraming[edge];

    const centerlines: EdgeSeg[] = [];
    const framing: EdgeSeg[] = [];

    // Vertical grid lines (u): equal-cell splits + user divisions. These ARE the
    // vertical centerlines, and the lines the Stick vertical mullions wrap.
    const gridU: number[] = [];
    for (let k = 1; k < nCells; k++) gridU.push((length * k) / nCells);
    for (const off of divisions) if (off > 0 && off < length) gridU.push(off);
    for (const u of gridU) centerlines.push({ kind: "v", u, z0: 0, z1: h });

    // Horizontal grid lines (z): user dividers. Horizontal centerlines + the lines the
    // Stick horizontal mullions wrap.
    for (const z of dividersH) centerlines.push({ kind: "h", z, u0: 0, u1: length });

    // Stick VERTICAL mullion faces: a pair of lines offset ± the half-width to either
    // side of every vertical grid line (clamped inside the wall), matching the renderer.
    if (mv > 0) {
      for (const cx of gridU) {
        for (const side of [-mv, mv]) {
          framing.push({ kind: "v", u: clamp(cx + side, 0, length), z0: 0, z1: h });
        }
      }
    }
    // Stick HORIZONTAL mullion faces: a pair of lines ± the half-width around each
    // horizontal grid line (clamped to the wall's height).
    if (mh > 0) {
      for (const cy of dividersH) {
        for (const side of [-mh, mh]) {
          framing.push({ kind: "h", z: clamp(cy + side, 0, h), u0: 0, u1: length });
        }
      }
    }

    // Unitized per-cell FRAMING: the inward inset FACE on each framed cell edge (the
    // actual frame member). Cell rects come from the wall-local grid, indexed exactly
    // like the editor's cellsForEdge, so the stored per-cell insets map correctly.
    if (framingByCell && Object.keys(framingByCell).length > 0) {
      const cells = cellGrid(length, h, nCells, divisions, dividersH);
      for (const key of Object.keys(framingByCell)) {
        const ci = Number(key);
        const fc = cells[ci];
        const ins = framingByCell[ci];
        if (!fc || !ins) continue;
        // top / bottom = horizontal inset faces; left / right = vertical inset faces.
        if (ins.top > 0) framing.push({ kind: "h", z: fc.z1 - ins.top, u0: fc.u0, u1: fc.u1 });
        if (ins.bottom > 0) framing.push({ kind: "h", z: fc.z0 + ins.bottom, u0: fc.u0, u1: fc.u1 });
        if (ins.left > 0) framing.push({ kind: "v", u: fc.u0 + ins.left, z0: fc.z0, z1: fc.z1 });
        if (ins.right > 0) framing.push({ kind: "v", u: fc.u1 - ins.right, z0: fc.z0, z1: fc.z1 });
      }
    }

    result.push({ edge, length, height: h, centerlines, framing });
  }

  return result;
}

/** Map a wall-local segment onto the real 3D wall plane (curves followed for h lines). */
function segTo3D(s: EdgeSeg, poly: EdgePolyline): Vec3[] {
  return s.kind === "v"
    ? verticalLine(poly, s.u, s.z0, s.z1)
    : horizontalLine(poly, s.u0, s.u1, s.z);
}

/** Map a wall-local segment FLAT into the unravel strip at panel x-origin `x0` (Z = 0). */
function segTo2D(s: EdgeSeg, x0: number): Vec3[] {
  return s.kind === "v"
    ? [{ x: x0 + s.u, y: s.z0, z: 0 }, { x: x0 + s.u, y: s.z1, z: 0 }]
    : [{ x: x0 + s.u0, y: s.z, z: 0 }, { x: x0 + s.u1, y: s.z, z: 0 }];
}

/**
 * Build the 3D centerline + framing polylines for each selected wall, mapped onto the
 * real wall planes. Walls with no facade overlay yield empty line sets, so the exporter
 * omits their sub-layers.
 */
export function buildFacadeLines(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  records: FacadeRecords,
): FacadeEdgeLines[] {
  return buildEdgeSegs(perimeter, edges, heightOf, records).map((es) => {
    const poly = edgePolyline(perimeter, es.edge);
    return {
      edge: es.edge,
      centerlines: es.centerlines.map((s) => segTo3D(s, poly)),
      framing: es.framing.map((s) => segTo3D(s, poly)),
    };
  });
}

/**
 * Build the 2D (unrolled-elevation) centerline + framing polylines for each selected
 * wall: each wall laid FLAT in the unravel strip (gap `gap` between panels) at Z = 0,
 * with (u, z) placed at (x0 + u, z) — exactly how the elevations view positions them.
 * Walls absent from the strip (or with no overlay) yield empty sets.
 */
export function buildFacadeLines2D(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  records: FacadeRecords,
  gap: number,
): FacadeEdgeLines[] {
  const x0Of = new Map<number, number>();
  for (const seg of unravelPerimeter(perimeter, gap).segments) x0Of.set(seg.index, seg.x0);
  const out: FacadeEdgeLines[] = [];
  for (const es of buildEdgeSegs(perimeter, edges, heightOf, records)) {
    const x0 = x0Of.get(es.edge);
    if (x0 === undefined) continue;
    out.push({
      edge: es.edge,
      centerlines: es.centerlines.map((s) => segTo2D(s, x0)),
      framing: es.framing.map((s) => segTo2D(s, x0)),
    });
  }
  return out;
}

/**
 * The flat wall-border PANELS for the 2D export: each selected wall as a rectangle in
 * the unravel strip — corners (x0,0), (x1,0), (x1,h), (x0,h) at Z = 0 — returned as a
 * 4-point ring per edge. The exporter emits each as a flat `3DFACE` on `WALL_<edge>`,
 * mirroring how the 3D export puts each extruded wall on that same layer.
 */
export function buildFlatPanels(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  gap: number,
): { edge: number; pts: Vec3[] }[] {
  const out: { edge: number; pts: Vec3[] }[] = [];
  for (const seg of unravelPerimeter(perimeter, gap).segments) {
    if (!edges.has(seg.index)) continue;
    const h = heightOf(seg.index);
    if (h <= 0) continue;
    out.push({
      edge: seg.index,
      pts: [
        { x: seg.x0, y: 0, z: 0 },
        { x: seg.x1, y: 0, z: 0 },
        { x: seg.x1, y: h, z: 0 },
        { x: seg.x0, y: h, z: 0 },
      ],
    });
  }
  return out;
}

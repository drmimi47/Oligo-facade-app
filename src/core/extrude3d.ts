/**
 * core/extrude3d.ts
 *
 * Hand-written, dependency-free 3D massing for the mini-window thumbnails.
 *
 * WHY hand-written (per the working agreement): the codebase is deliberately
 * dependency-free — geometry and the 2D-canvas renderer are all written by hand.
 * A full 3D library (three.js, WebGL) would dwarf this app for what is needed:
 * a small, static, slightly-from-above massing preview of an extruded footprint.
 * So this module builds the extruded geometry, projects it with a simple fixed
 * isometric-style camera, and draws filled/stroked polygons to the SAME 2D canvas
 * the rest of the app uses, with painter's-algorithm depth sorting. This keeps the
 * tool small, controllable, and consistent with `renderer.ts`.
 *
 * Like `renderer.ts`, ALL visual values (colours) are read from CSS custom
 * properties on the canvas element so styling stays single-source (styles.css).
 *
 * Pipeline:
 *   Perimeter (model 2D, +Y up)
 *     -> flattenPerimeter()                 dense outline (curves sampled)
 *     -> buildMassing()                     vertical wall planes only (no caps)
 *     -> project each vertex with a Camera  (model 3D -> 2D screen-ish coords)
 *     -> fitProjected()                     scale/centre to the thumbnail box
 *     -> render3d()                         depth-sort faces back-to-front, fill + stroke
 *
 * Coordinate convention: model (x, y) maps to ground-plane (X, Y); extrusion is
 * UP along +Z. We reuse the geometry layer's +Y-up convention from `geometry.ts`.
 */

import type { Perimeter } from "./geometry";
import { flattenPerimeter, flattenSegment } from "./geometry";

// ---------------------------------------------------------------------------
// UNIT / HEIGHT ASSUMPTION
//
// The app's units are abstract ("u"). For the 3D massing we adopt the simplest
// mapping: 1 model unit = 1 foot. So the default wall height of ~10 feet is
// simply 10 model units. Change this single constant to retune the height.
// ---------------------------------------------------------------------------

/** Default wall extrusion height in feet (== model units, under 1u = 1ft). */
export const DEFAULT_WALL_HEIGHT_FT = 10;

/** A point in 3D model space (X east, Y north, Z up). */
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A 2D projected point plus a depth value (for painter's sorting). */
interface Projected {
  x: number;
  y: number;
  depth: number;
}

/**
 * One vertical wall plane of the massing, in 3D model space. The model is drawn
 * as thin (thickless) extruded planes ONLY — no floor/roof caps — so it reads as
 * an open shell. Each wall carries the source EDGE index so a hovered unravel
 * strip can highlight the right wall.
 */
interface Face {
  /** Ring of 3D vertices defining the wall quad. */
  pts: Vec3[];
  /** The original perimeter edge index this wall came from. */
  edge: number;
}

/** The extruded massing: a set of vertical wall planes (no caps). */
export interface Massing {
  faces: Face[];
  /** Whether the source perimeter is closed (informational). */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// GEOMETRY: build the extruded massing from a Perimeter.
// ---------------------------------------------------------------------------

/**
 * Build the extruded massing from a perimeter.
 *
 * Curves are honoured by extruding the FLATTENED outline: each flattened edge
 * becomes a vertical wall quad, so a curved wall extrudes as a smooth strip of
 * quads. Wall quads inherit the ORIGINAL (anchor) edge index they belong to so
 * the highlight link survives — flattened sub-segments of edge `i` all map back
 * to edge `i`.
 *
 * Degenerate inputs are handled: < 2 vertices yields an empty massing.
 *
 * The wall height is resolved PER WALL via `heightOf(edgeIndex)`, called with each
 * quad's ORIGINAL perimeter edge index. The caller decides the policy (uniform vs
 * per-edge overrides); this function stays height-policy-agnostic. `height` (or
 * the default constant) is the convenient uniform default — passing a number is
 * equivalent to a resolver that ignores the edge index. Non-finite or ≤ 0
 * resolved heights are floored to {@link DEFAULT_WALL_HEIGHT_FT} so a wall always
 * has positive extent.
 */
export function buildMassing(
  p: Perimeter,
  height: number | ((edgeIndex: number) => number) = DEFAULT_WALL_HEIGHT_FT,
): Massing {
  const faces: Face[] = [];
  const v = p.vertices;
  if (v.length < 2) return { faces, closed: p.closed };

  // Normalize the height argument into a resolver. A plain number means a uniform
  // height for every wall; a function lets the caller supply per-edge heights.
  const resolve = typeof height === "function" ? height : () => height;
  const heightFor = (edgeIndex: number): number => {
    const h = resolve(edgeIndex);
    // Guard degenerate heights (NaN, ±Infinity, ≤ 0) so walls never collapse.
    return Number.isFinite(h) && h > 0 ? h : DEFAULT_WALL_HEIGHT_FT;
  };

  // Dense outline (curves sampled). For a closed shape the last point repeats
  // the first; we keep that so the closing wall is generated naturally.
  const outline = flattenPerimeter(p);
  if (outline.length < 2) return { faces, closed: p.closed };

  // Map each flattened outline point back to the ORIGINAL edge index it lies on,
  // so wall quads can carry the source edge for the hover-highlight link AND so
  // each quad's height is resolved from its source edge.
  const edgeOfPoint = buildEdgeMap(p, outline.length);

  // Walls: one vertical quad per flattened edge (point i -> point i+1). No
  // floor/roof caps are generated — the massing is wall planes only.
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i];
    const b = outline[i + 1];
    const edge = edgeOfPoint[i];
    // Top Z comes from THIS wall's source edge, so per-panel heights map directly
    // onto the matching wall(s) — every flattened sub-quad of a curved edge rises
    // to that edge's height.
    const z = heightFor(edge);
    // Quad ordered base-a, base-b, top-b, top-a (a consistent ring).
    faces.push({
      edge,
      pts: [
        { x: a.x, y: a.y, z: 0 },
        { x: b.x, y: b.y, z: 0 },
        { x: b.x, y: b.y, z },
        { x: a.x, y: a.y, z },
      ],
    });
  }

  return { faces, closed: p.closed };
}

/**
 * For each point in the flattened outline, which ORIGINAL perimeter edge does the
 * segment STARTING at that point belong to? `flattenPerimeter` emits, per edge,
 * one point for a straight segment and CURVE_STEPS points for a curve; here we
 * reconstruct that grouping by re-flattening each edge and counting its output.
 *
 * Returns an array of length `outlineLen`; index `outlineLen-1` (the final point)
 * is unused for walls but filled defensively with the last edge index.
 */
function buildEdgeMap(p: Perimeter, outlineLen: number): number[] {
  const v = p.vertices;
  const map: number[] = new Array(outlineLen).fill(0);
  // The first outline point is the start of edge 0.
  let cursor = 0;
  const edgeCount = p.closed ? v.length : v.length - 1;
  for (let e = 0; e < edgeCount; e++) {
    const a = v[e];
    const b = v[(e + 1) % v.length];
    // Number of flattened points this edge contributes (excludes its start point,
    // matching flattenSegment which returns the points AFTER `a`). We reuse the
    // exact geometry-layer flattening so the count never drifts from the outline.
    const span = flattenSegment(a, b).length;
    for (let k = 0; k < span && cursor < outlineLen; k++) {
      map[cursor] = e;
      cursor++;
    }
  }
  // Any leftover (the final shared point) maps to the last edge.
  for (; cursor < outlineLen; cursor++) map[cursor] = Math.max(0, edgeCount - 1);
  return map;
}

// ---------------------------------------------------------------------------
// CAMERA / PROJECTION
//
// A simple fixed camera that views the massing from slightly above and to the
// side (an isometric-ish look). We rotate the 3D point about Z (azimuth) then
// tilt about X (elevation), then take the rotated X (right) and a combination of
// the rotated Y/Z (screen up) as the 2D coordinates. Depth is the rotated Y so
// nearer faces sort in front. This is an orthographic projection — predictable
// and parallel-edged, which reads well for a small massing diagram (no perspective
// distortion at thumbnail scale). Cheap, no matrices/libraries needed.
// ---------------------------------------------------------------------------

export interface Camera {
  /** Rotation about the vertical (Z) axis, radians. Spins the model. */
  azimuth: number;
  /** Tilt from horizontal, radians (0 = side-on, PI/2 = top-down). */
  elevation: number;
}

/** A pleasant default 3/4 view: rotated ~35° and looking down ~30°. */
export const DEFAULT_CAMERA: Camera = {
  azimuth: -Math.PI / 5, // ~-36°
  elevation: Math.PI / 6, // 30° down-tilt
};

/**
 * Project a 3D model point to 2D (pre-fit) coordinates with a depth value.
 * Orthographic: no divide-by-z, so no degenerate behaviour for any input.
 */
function project(pt: Vec3, cam: Camera): Projected {
  const ca = Math.cos(cam.azimuth);
  const sa = Math.sin(cam.azimuth);
  // Rotate about Z (azimuth): spins the ground plane.
  const rx = pt.x * ca - pt.y * sa;
  const ry = pt.x * sa + pt.y * ca;
  const rz = pt.z;
  // Tilt about X (elevation): fold the ground toward the viewer and lift Z.
  const ce = Math.cos(cam.elevation);
  const se = Math.sin(cam.elevation);
  // Screen X = rotated right axis. Screen Y (up) = lifted Z minus folded depth.
  // Depth = how far "into" the screen (used only for back-to-front sorting).
  const screenX = rx;
  const screenUp = rz * ce - ry * se;
  const depth = ry * ce + rz * se;
  return { x: screenX, y: screenUp, depth };
}

// ---------------------------------------------------------------------------
// FIT: frame the whole massing (footprint + height) in the thumbnail box.
// ---------------------------------------------------------------------------

interface FitTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Compute a uniform scale + offset that frames ALL projected face vertices inside
 * a `width`×`height` box with `marginPx` padding, centred. Because projection is
 * orthographic and includes the extruded top, this naturally accounts for both
 * the footprint AND the height. Screen-up (+Y) is flipped to canvas-down here.
 *
 * Degenerate (zero-size) projections are floored to an epsilon so scale is finite.
 */
function fitProjected(
  pts: Projected[],
  width: number,
  height: number,
  marginPx: number,
): FitTransform {
  if (pts.length === 0) {
    return { scale: 1, offsetX: width / 2, offsetY: height / 2 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const q of pts) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  const EPS = 1e-6;
  const spanX = Math.max(maxX - minX, EPS);
  const spanY = Math.max(maxY - minY, EPS);
  const availW = Math.max(width - marginPx * 2, 1);
  const availH = Math.max(height - marginPx * 2, 1);
  const scale = Math.min(availW / spanX, availH / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return {
    scale,
    offsetX: width / 2 - midX * scale,
    // Flip screen-up to canvas-down by negating the scaled Y.
    offsetY: height / 2 + midY * scale,
  };
}

/** Apply a fit transform to a projected point, yielding canvas pixel coords. */
function toCanvas(q: Projected, t: FitTransform): { x: number; y: number } {
  return { x: q.x * t.scale + t.offsetX, y: -q.y * t.scale + t.offsetY };
}

// ---------------------------------------------------------------------------
// RENDER: depth-sorted painter's-algorithm draw of the massing.
// ---------------------------------------------------------------------------

/** Read a CSS custom property from an element, with a fallback. (Mirror renderer.ts.) */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

function cssNum(el: HTMLElement, name: string, fallback: number): number {
  const value = parseFloat(cssVar(el, name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

/** Options for {@link render3d}. */
export interface Render3dOptions {
  /** Padding (canvas px) around the massing inside the thumbnail. */
  marginPx: number;
  /**
   * Uniform/default wall extrusion height (model units), used for any wall whose
   * edge has no entry in {@link Render3dOptions.heights}. Defaults to
   * {@link DEFAULT_WALL_HEIGHT_FT}.
   */
  height?: number;
  /**
   * Per-ORIGINAL-edge-index height overrides (model units). A wall's height is
   * `heights[edge] ?? height ?? DEFAULT_WALL_HEIGHT_FT`. Keys are the same edge
   * indices the wall quads carry (`Face.edge`), so a per-panel height map lines up
   * directly with the walls. Used for the active thumbnail only by the caller.
   */
  heights?: Record<number, number>;
  /** Camera orientation. Defaults to {@link DEFAULT_CAMERA}. */
  camera?: Camera;
  /**
   * Original perimeter edge index to highlight (the wall panel lit when the user
   * hovers the matching unravel strip), or -1/undefined for none.
   */
  highlightEdge?: number;
}

/**
 * Draw the perimeter as an extruded 3D massing onto a 2D canvas. Mirrors the
 * signature/style of `renderer.ts#render`: clears in device pixels, resolves all
 * colours from CSS tokens on the canvas element, then paints.
 *
 * Drawing: faces are sorted back-to-front by mean depth (painter's algorithm) and
 * each is filled (wall/roof/floor token) and stroked (edge token). The highlighted
 * wall is filled + stroked in the highlight token so the hover-link is preserved
 * in 3D. Degenerate perimeters simply draw nothing (no crash, no divide-by-zero).
 */
export function render3d(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  perimeter: Perimeter,
  options: Render3dOptions,
): void {
  // Resolve tokens once. Fallbacks mirror the LIGHT defaults in styles.css.
  const tk = {
    bg: cssVar(canvas, "--mini-thumb-bg", "#ffffff"),
    wallFill: cssVar(canvas, "--m3d-wall-fill", "#cfd8e0"),
    wallStroke: cssVar(canvas, "--m3d-wall-stroke", "#7e8a96"),
    highlightFill: cssVar(canvas, "--m3d-highlight-fill", "rgba(210,49,84,0.35)"),
    highlightStroke: cssVar(canvas, "--m3d-highlight-stroke", "#d23154"),
    edgeW: cssNum(canvas, "--m3d-edge-width", 1),
    highlightW: cssNum(canvas, "--m3d-highlight-width", 2),
  };

  // Reset transform and clear in device pixels (same contract as render()).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = tk.bg;
  ctx.fillRect(0, 0, width, height);

  const wallHeight = options.height ?? DEFAULT_WALL_HEIGHT_FT;
  const heights = options.heights;
  const cam = options.camera ?? DEFAULT_CAMERA;
  const highlightEdge = options.highlightEdge ?? -1;

  // Resolve each wall's height from its source edge: per-edge override first, then
  // the uniform default. (buildMassing guards non-finite/≤0 values.)
  const massing = buildMassing(perimeter, (edge) => heights?.[edge] ?? wallHeight);
  if (massing.faces.length === 0) return;

  // Project every face's vertices and gather all projected points for the fit.
  const projectedFaces = massing.faces.map((f) => ({
    face: f,
    proj: f.pts.map((p) => project(p, cam)),
  }));
  const allPts: Projected[] = [];
  for (const pf of projectedFaces) allPts.push(...pf.proj);

  const fit = fitProjected(allPts, width, height, options.marginPx);

  // Painter's algorithm: draw FARTHEST faces first so nearer walls paint over
  // them (opaque fills => correct occlusion). `depth` increases INTO the screen,
  // so we sort DESCENDING (largest/farthest depth first). This is the key to not
  // letting background walls show in front of foreground walls as the model spins.
  const ordered = projectedFaces
    .map((pf) => ({
      ...pf,
      meanDepth: pf.proj.reduce((s, q) => s + q.depth, 0) / pf.proj.length,
    }))
    .sort((a, b) => b.meanDepth - a.meanDepth);

  for (const pf of ordered) {
    const isHighlight = highlightEdge >= 0 && pf.face.edge === highlightEdge;

    let fillStyle: string;
    let strokeStyle: string;
    let lineWidth: number;
    if (isHighlight) {
      fillStyle = tk.highlightFill;
      strokeStyle = tk.highlightStroke;
      lineWidth = tk.highlightW;
    } else {
      fillStyle = tk.wallFill;
      strokeStyle = tk.wallStroke;
      lineWidth = tk.edgeW;
    }

    ctx.beginPath();
    pf.proj.forEach((q, i) => {
      const c = toCanvas(q, fit);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

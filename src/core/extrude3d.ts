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
import { buildSunPathGeometry, type SolarSettings, type SunPathGeometry, type V3 } from "./solar";

// ---------------------------------------------------------------------------
// UNIT / HEIGHT ASSUMPTION
//
// The app's unit system is defined in core/units.ts: 1 model unit = 1 FOOT
// (real-world, not abstract). So the default wall height of 13 feet is simply
// 13 model units. Change this single constant to retune the height.
// ---------------------------------------------------------------------------

/** Default wall extrusion height in feet (== model units, under 1u = 1ft). */
export const DEFAULT_WALL_HEIGHT_FT = 13;

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
 *
 * When `edges` is supplied, ONLY walls whose ORIGINAL perimeter edge index is in
 * the set are built — a SUB-MASSING of just those edges (e.g. an export selection
 * or a 3D preview of selected walls). Every flattened sub-quad of a curved edge
 * shares that edge's index, so a selected curved wall is kept whole. Omit `edges`
 * (the default) to build the entire footprint.
 */
export function buildMassing(
  p: Perimeter,
  height: number | ((edgeIndex: number) => number) = DEFAULT_WALL_HEIGHT_FT,
  edges?: ReadonlySet<number>,
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
    // Selection filter: skip walls whose source edge is not in the requested set
    // (builds a sub-massing of just the selected edges). No set => keep every wall.
    if (edges && !edges.has(edge)) continue;
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
// tilt the camera up and over by elevation so it looks DOWN, taking the rotated X
// (right) and a sign-consistent combination of the rotated Y/Z as the 2D screen
// coordinates. Depth combines the same Y/Z (forward adds, height subtracts) so
// nearer faces sort in front. This is an orthographic projection — predictable
// and parallel-edged, which reads well for a small massing diagram (no perspective
// distortion at thumbnail scale). Cheap, no matrices/libraries needed.
// ---------------------------------------------------------------------------

export interface Camera {
  /** Rotation about the vertical (Z) axis, radians. Spins the model. */
  azimuth: number;
  /**
   * Tilt of the camera above the horizon, radians. Positive tilts the camera UP
   * and over the model so it looks DOWN onto it: 0 = side-on (eye level), and
   * +PI/2 = straight-down top-down (plan). Negative would look UP from below.
   */
  elevation: number;
}

/** A pleasant default 3/4 view: rotated ~-36° and looking DOWN ~30° from above. */
export const DEFAULT_CAMERA: Camera = {
  azimuth: -Math.PI / 5, // ~-36°
  elevation: Math.PI / 6, // 30° above horizon -> looks down onto the massing
};

/**
 * Exact top-down / aerial (plan) camera: elevation = PI/2 looks straight down
 * (collapsing the massing into its flat footprint), azimuth = 0 gives a clean
 * north-up plan regardless of any prior spin. Used by the double-click "aerial
 * view" toggle in both the mini-window thumbnail and the Solar Study popup.
 */
export const PLAN_CAMERA: Camera = { azimuth: 0, elevation: Math.PI / 2 };

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
  // Tilt the camera UP and over the model by `elevation` so it looks DOWN onto it.
  const ce = Math.cos(cam.elevation);
  const se = Math.sin(cam.elevation);
  // Screen X = rotated right axis (unaffected by the tilt).
  //
  // Screen-up combines the lifted Z with the folded forward (north) axis with the
  // SAME sign, so that as the camera tilts down (elevation -> +PI/2) BOTH wall tops
  // AND points farther from the camera (larger ry, "north") rise on screen — the
  // from-above read where the footprint tilts toward the viewer. At elevation 0 it
  // is pure Z (side-on); at +PI/2 it is pure ry (north-up plan).
  //
  // Depth = distance INTO the screen for back-to-front sorting. Forward (ry) adds
  // depth while height (rz) SUBTRACTS it, so when looking down the roof/top is
  // NEARER than the base — correct occlusion for a view from above.
  const screenX = rx;
  const screenUp = rz * ce + ry * se;
  const depth = ry * ce - rz * se;
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

/** An RGBA colour, channels 0–255, alpha 0–1. (Internal to the fog blend.) */
interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parse a CSS colour STRING into {r,g,b,a}. Dependency-free, mirroring the
 * cssVar/cssNum helper style: we only need the formats the tokens in this codebase
 * actually use — `#rgb`, `#rrggbb`, and `rgb()/rgba()`. Anything unrecognised falls
 * back to opaque black so a bad token degrades visibly rather than throwing.
 */
function parseColor(str: string): RGBA {
  const s = str.trim();
  // Hex: #rgb or #rrggbb.
  if (s[0] === "#") {
    const hex = s.slice(1);
    if (hex.length === 3) {
      // Shorthand #rgb -> each nibble doubled (e.g. f -> ff).
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b, a: 1 };
    }
  }
  // Functional rgb()/rgba(): pull the comma/space-separated channel numbers.
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).map((p) => parseFloat(p)).filter((n) => Number.isFinite(n));
    if (parts.length >= 3) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
    }
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Linearly interpolate colour `a` toward colour `b` by `t` (0 = all a, 1 = all b),
 * blending in RGB (and alpha), and return a CSS `rgba(...)` string. Used for the
 * atmospheric fog: blending the parsed wall colour toward the parsed fog colour by
 * a small depth-driven amount. Kept tiny and allocation-light — the three fixed
 * colours are parsed ONCE by the caller, so this only does arithmetic per face.
 */
function mixColor(a: RGBA, b: RGBA, t: number): string {
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  const al = a.a + (b.a - a.a) * t;
  return `rgba(${r}, ${g}, ${bl}, ${al})`;
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
   * Original perimeter edge index to highlight (lit when the user hovers the
   * matching unravel strip or footprint edge), or -1/undefined for none.
   */
  highlightEdge?: number;
  /**
   * How to render {@link Render3dOptions.highlightEdge}:
   *  - `false`/undefined (default) — fill the matching wall PANEL in the highlight
   *    token (the unravel-strip hover behaviour).
   *  - `true` — leave walls normal and instead overlay the matching footprint EDGE
   *    as a highlighted LINE along the base of that edge's wall(s) (perimeter/edit-
   *    mode hover). Drawn last so it sits on top of the massing.
   */
  highlightAsLine?: boolean;
  /**
   * Optional SOLAR STUDY overlay: when present, a 3D sun-path dome is drawn AROUND
   * the massing in the same camera/projection — a horizon compass rose (N/E/S/W),
   * the summer / equinox / winter reference sun-path arcs plus the currently-selected
   * day's arc, integer-hour tick marks, and the sun for the set day + solar time.
   * All values come from REAL solar geometry (see core/solar.ts) driven by the
   * settings' latitude, day of year, hour, and the sketch's `northOffset`. The dome
   * is centred on the footprint and sized to frame the building. Used by the Solar
   * Study popup only; thumbnails omit it (so their rendering is unchanged).
   */
  sunPath?: { settings: SolarSettings };
  /**
   * When set, extrude ONLY the walls whose ORIGINAL perimeter edge index is in the
   * set — a preview of just the SELECTED walls (e.g. the export selection), framed
   * on their own. The whole footprint is built when omitted. Forwarded straight to
   * {@link buildMassing}; each wall keeps its real per-edge height.
   */
  edges?: ReadonlySet<number>;
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
    // ATMOSPHERIC FOG (depth cue): the colour distant faces fade toward and how far
    // they fade at the very back. Fog colour defaults to the canvas background so
    // far geometry dissolves into it (the atmospheric-perspective look).
    fogColor: cssVar(canvas, "--m3d-fog-color", "#ffffff"),
    fogStrength: cssNum(canvas, "--m3d-fog-strength", 0.35),
    // SUN-PATH overlay tokens (only used when options.sunPath is set).
    sunGround: cssVar(canvas, "--solar-ground-ring", "#b9c2cc"),
    sunGroundW: cssNum(canvas, "--solar-ground-width", 1),
    sunCardinalLine: cssVar(canvas, "--solar-cardinal-line", "#cdd5dd"),
    sunCardinalText: cssVar(canvas, "--solar-cardinal-text", "#5b6672"),
    sunArc: cssVar(canvas, "--solar-arc", "#c9b683"),
    sunArcW: cssNum(canvas, "--solar-arc-width", 1),
    sunArcActive: cssVar(canvas, "--solar-arc-active", "#e0a619"),
    sunArcActiveW: cssNum(canvas, "--solar-arc-active-width", 2),
    sunHourTick: cssVar(canvas, "--solar-hour-tick", "#b0894a"),
    sunHourTickR: cssNum(canvas, "--solar-hour-tick-radius", 1.6),
    sunFill: cssVar(canvas, "--solar-sun-fill", "#ffcf33"),
    sunStroke: cssVar(canvas, "--solar-sun-stroke", "#e0a619"),
    sunDiskR: cssNum(canvas, "--solar-sun-radius", 6),
    sunRay: cssVar(canvas, "--solar-sun-ray", "rgba(224,166,25,0.55)"),
    sunRayW: cssNum(canvas, "--solar-sun-ray-width", 1.5),
    sunLabelGap: cssNum(canvas, "--solar-label-gap", 8),
    sunLabelFont: cssVar(canvas, "--label-font", "12px ui-monospace, monospace"),
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
  const highlightAsLine = options.highlightAsLine ?? false;

  // Resolve each wall's height from its source edge: per-edge override first, then
  // the uniform default. (buildMassing guards non-finite/≤0 values.) `options.edges`,
  // when present, restricts the massing to just those selected walls.
  const massing = buildMassing(perimeter, (edge) => heights?.[edge] ?? wallHeight, options.edges);
  if (massing.faces.length === 0) return;

  // Project every face's vertices and gather all projected points for the fit.
  const projectedFaces = massing.faces.map((f) => ({
    face: f,
    proj: f.pts.map((p) => project(p, cam)),
  }));
  const allPts: Projected[] = [];
  for (const pf of projectedFaces) allPts.push(...pf.proj);

  // SUN-PATH overlay geometry (model space). Built around the footprint centre and
  // folded into the fit BELOW so the whole dome — not just the building — frames in
  // the canvas (the diagram is meant to dominate, with the massing inside it).
  let sunGeom: SunPathGeometry | null = null;
  if (options.sunPath) {
    sunGeom = buildSunGeometryForMassing(massing, options.sunPath.settings);
    for (const v of sunFitPoints(sunGeom)) allPts.push(project(v, cam));
  }

  const fit = fitProjected(allPts, width, height, options.marginPx);

  // Project a model point straight to canvas pixels (used by the sun-path overlay).
  const pc = (v: V3): { x: number; y: number } => toCanvas(project(v, cam), fit);

  // GROUND-level sun-path elements (horizon ring + cardinal spokes) are drawn FIRST,
  // so the massing paints on top and reads as standing on the compass rose.
  if (sunGeom) drawSunGround(ctx, sunGeom, pc, tk);

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

  // ATMOSPHERIC PERSPECTIVE (subtle depth fog). We blend each wall's fill/stroke
  // toward the background-coloured fog by an amount proportional to how FAR that
  // face is from the camera, so distant surfaces lose contrast and recede while the
  // foreground stays crisp — the depth separation seen in massing studies.
  //
  // WHY depth-NORMALIZED (t over the model's own min/max mean depth) rather than an
  // absolute distance: the camera/scale and the model size both vary per thumbnail,
  // so a fixed distance scale would fog tiny models away entirely and barely touch
  // large ones. Normalizing means the effect is always "front of THIS model = clear,
  // back of THIS model = up to fogStrength faded", reading consistently at any size.
  //
  // WHY subtle (default strength 0.35, capped at the very back): this is a depth CUE,
  // not a style filter — over-fogging would erase the geometry and hurt legibility at
  // thumbnail scale, violating function-before-aesthetic.
  const fogStrength = tk.fogStrength;
  // Parse the three FIXED colours ONCE (not per face) so the loop stays cheap arithmetic.
  const fogActive = fogStrength > 0;
  const fillRGBA = fogActive ? parseColor(tk.wallFill) : null;
  const strokeRGBA = fogActive ? parseColor(tk.wallStroke) : null;
  const fogRGBA = fogActive ? parseColor(tk.fogColor) : null;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const pf of ordered) {
    if (pf.meanDepth < minDepth) minDepth = pf.meanDepth;
    if (pf.meanDepth > maxDepth) maxDepth = pf.meanDepth;
  }
  const depthSpan = maxDepth - minDepth;
  // Guard the degenerate case (single face / perfectly flat in depth): no range means
  // no meaningful front/back, so fog factor is 0 (treated below via depthSpan check).
  const canFog = fogActive && depthSpan > 0;

  for (const pf of ordered) {
    // In LINE mode the highlighted edge is drawn as an overlaid base line below, so
    // its wall keeps the normal fill here; only PANEL mode lights the wall face.
    const isHighlight = !highlightAsLine && highlightEdge >= 0 && pf.face.edge === highlightEdge;

    let fillStyle: string;
    let strokeStyle: string;
    let lineWidth: number;
    if (isHighlight) {
      // Highlighted faces are EXEMPT from fog: the hover-highlight must stay clearly
      // readable as a link to the unravel strip/footprint edge, and fading it toward
      // the background would defeat that signal. (It also draws atop nearer walls.)
      fillStyle = tk.highlightFill;
      strokeStyle = tk.highlightStroke;
      lineWidth = tk.highlightW;
    } else {
      fillStyle = tk.wallFill;
      strokeStyle = tk.wallStroke;
      lineWidth = tk.edgeW;
      if (canFog && fillRGBA && strokeRGBA && fogRGBA) {
        // Normalized depth: 0 = nearest face, 1 = farthest. mix scales it by strength
        // so only the very back reaches the full (still subtle) blend.
        const t = (pf.meanDepth - minDepth) / depthSpan;
        const mix = t * fogStrength;
        fillStyle = mixColor(fillRGBA, fogRGBA, mix);
        // Blend the STROKE a touch LESS (0.85×) than the fill so face edges keep some
        // definition at the back and the massing's silhouette/wireframe stays legible.
        strokeStyle = mixColor(strokeRGBA, fogRGBA, mix * 0.85);
      }
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

  // SKY-level sun-path elements (the season + active arcs, hour ticks/labels, the
  // cardinal letters, and the current sun) are drawn AFTER the massing as a legible
  // diagram overlay on top — the standard way architectural sun studies read.
  if (sunGeom) drawSunSky(ctx, sunGeom, pc, tk);

  // LINE-mode highlight: overlay the hovered footprint EDGE as a highlighted line
  // tracing the BASE (z = 0) of that edge's wall(s). A curved edge spans several
  // flattened sub-quads, so we stroke every base segment whose face carries the
  // edge index — giving the full edge (curve included). Drawn LAST so it reads on
  // top of the massing rather than being occluded by nearer walls.
  if (highlightAsLine && highlightEdge >= 0) {
    ctx.beginPath();
    for (const pf of ordered) {
      if (pf.face.edge !== highlightEdge) continue;
      // Quad point order is base-a, base-b, top-b, top-a — so [0] and [1] are the
      // two base (footprint) corners of this sub-quad.
      const a = toCanvas(pf.proj[0], fit);
      const b = toCanvas(pf.proj[1], fit);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.strokeStyle = tk.highlightStroke;
    // A touch heavier than the panel highlight so the single line reads clearly.
    ctx.lineWidth = tk.highlightW + 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// SUN-PATH OVERLAY (Solar Study only) — build + draw the 3D sun dome.
//
// The geometry is REAL solar math (core/solar.ts); here we only size the dome to
// the massing, fold its extent into the fit, and paint it in the SAME camera so it
// rotates with the building. Colours come from CSS tokens (resolved into `tk`).
// ---------------------------------------------------------------------------

/** The subset of resolved render tokens the sun-path overlay draws with. */
type SunTokens = {
  sunGround: string;
  sunGroundW: number;
  sunCardinalLine: string;
  sunCardinalText: string;
  sunArc: string;
  sunArcW: number;
  sunArcActive: string;
  sunArcActiveW: number;
  sunHourTick: string;
  sunHourTickR: number;
  sunFill: string;
  sunStroke: string;
  sunDiskR: number;
  sunRay: string;
  sunRayW: number;
  sunLabelGap: number;
  sunLabelFont: string;
};

/**
 * Size + centre the sun dome to the massing: centred on the footprint, with a radius
 * that comfortably encloses both the footprint half-diagonal and the building height
 * so every sun-path arc clears the roof.
 */
function buildSunGeometryForMassing(m: Massing, settings: SolarSettings): SunPathGeometry {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxZ = 0;
  for (const f of m.faces) {
    for (const p of f.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfDiag = 0.5 * Math.hypot(maxX - minX, maxY - minY);
  // 1.6× the footprint half-diagonal frames the building inside the dome; the height
  // terms keep the dome above a tall/narrow massing. Floored to 1 so it's never zero.
  const radius = Math.max(halfDiag * 1.6, maxZ * 1.5, 1);
  return buildSunPathGeometry({ x: cx, y: cy, z: 0 }, radius, settings);
}

/** Model points whose projected extent should be included in the canvas fit. */
function sunFitPoints(g: SunPathGeometry): V3[] {
  const pts: V3[] = [...g.groundRing];
  for (const arc of g.arcs) pts.push(...arc.points);
  if (g.sun.visible) pts.push(g.sun.point);
  // Cardinal letters sit just outside the ring; include their spots so they don't clip.
  for (const c of g.cardinals) {
    pts.push({ x: g.center.x + c.dir.x * g.radius * 1.12, y: g.center.y + c.dir.y * g.radius * 1.12, z: g.center.z });
  }
  return pts;
}

/** Draw the ground-level dome elements (horizon ring + cardinal spokes). */
function drawSunGround(
  ctx: CanvasRenderingContext2D,
  g: SunPathGeometry,
  pc: (v: V3) => { x: number; y: number },
  tk: SunTokens,
): void {
  ctx.setLineDash([]);
  // Horizon ring.
  ctx.beginPath();
  g.groundRing.forEach((v, i) => {
    const c = pc(v);
    if (i === 0) ctx.moveTo(c.x, c.y);
    else ctx.lineTo(c.x, c.y);
  });
  ctx.strokeStyle = tk.sunGround;
  ctx.lineWidth = tk.sunGroundW;
  ctx.stroke();
  // Cardinal spokes from centre to ring.
  const centre = pc(g.center);
  for (const card of g.cardinals) {
    const tip = pc({ x: g.center.x + card.dir.x * g.radius, y: g.center.y + card.dir.y * g.radius, z: g.center.z });
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = tk.sunCardinalLine;
    ctx.lineWidth = tk.sunGroundW;
    ctx.stroke();
  }
}

/** Draw the sky-level dome elements (arcs, hour marks/labels, cardinal letters, sun). */
function drawSunSky(
  ctx: CanvasRenderingContext2D,
  g: SunPathGeometry,
  pc: (v: V3) => { x: number; y: number },
  tk: SunTokens,
): void {
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Season + active sun-path arcs. The selected day's arc ("active") is brighter and
  // heavier so it stands out from the three faint season guides.
  for (const arc of g.arcs) {
    if (arc.points.length < 2) continue;
    const active = arc.key === "active";
    ctx.beginPath();
    arc.points.forEach((v, i) => {
      const c = pc(v);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.strokeStyle = active ? tk.sunArcActive : tk.sunArc;
    ctx.lineWidth = active ? tk.sunArcActiveW : tk.sunArcW;
    ctx.stroke();
  }

  // Integer-hour dots.
  ctx.fillStyle = tk.sunHourTick;
  for (const m of g.hourMarks) {
    const c = pc(m.point);
    ctx.beginPath();
    ctx.arc(c.x, c.y, tk.sunHourTickR, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Sparse hour labels + cardinal letters share the label font.
  ctx.font = tk.sunLabelFont;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tk.sunCardinalText;
  for (const m of g.hourMarks) {
    if (!m.label) continue;
    const c = pc(m.point);
    ctx.fillText(String(m.hour), c.x, c.y - tk.sunLabelGap);
  }
  for (const card of g.cardinals) {
    const c = pc({ x: g.center.x + card.dir.x * g.radius * 1.12, y: g.center.y + card.dir.y * g.radius * 1.12, z: g.center.z });
    ctx.fillText(card.label, c.x, c.y);
  }

  // The current sun: a faint ray from the dome centre to the sun, then the sun disk.
  if (g.sun.visible) {
    const centre = pc(g.center);
    const sun = pc(g.sun.point);
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y);
    ctx.lineTo(sun.x, sun.y);
    ctx.strokeStyle = tk.sunRay;
    ctx.lineWidth = tk.sunRayW;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, tk.sunDiskR, 0, 2 * Math.PI);
    ctx.fillStyle = tk.sunFill;
    ctx.fill();
    ctx.strokeStyle = tk.sunStroke;
    ctx.lineWidth = tk.sunRayW;
    ctx.stroke();
  }

  // Restore canvas text defaults so later drawing isn't affected.
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

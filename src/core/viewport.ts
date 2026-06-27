/**
 * core/viewport.ts
 *
 * The mapping between MODEL space (units, +Y up) and SCREEN space (CSS pixels,
 * +Y down). Keeping this isolated means the data model never deals in pixels
 * and the renderer/input layers have one well-defined conversion to rely on.
 */

import type { Point, Perimeter } from "./geometry";
import { flattenPerimeter } from "./geometry";

export interface Viewport {
  /** Pixels per model unit (zoom). */
  scale: number;
  /**
   * Screen pixel position (within the canvas) of the model origin (0,0).
   * Panning changes this. With +Y-up model space, increasing model y moves
   * a point UP on screen, so we subtract in the y conversion.
   */
  originX: number;
  originY: number;
}

export const defaultViewport = (width: number, height: number): Viewport => ({
  // 10 px/ft is the default working scale on load and new project.
  scale: 10,
  // Place model origin near the centre of the canvas.
  originX: width / 2,
  originY: height / 2,
});

/** Model -> screen (CSS pixels). */
export function toScreen(vp: Viewport, p: Point): Point {
  return {
    x: vp.originX + p.x * vp.scale,
    y: vp.originY - p.y * vp.scale, // flip Y: model up = screen up
  };
}

/** Screen (CSS pixels) -> model. */
export function toModel(vp: Viewport, sx: number, sy: number): Point {
  return {
    x: (sx - vp.originX) / vp.scale,
    y: (vp.originY - sy) / vp.scale, // inverse Y flip
  };
}

/** Convert a screen-pixel distance/tolerance into model units. */
export function pixelsToModel(vp: Viewport, px: number): number {
  return px / vp.scale;
}

/**
 * Zoom around a fixed screen anchor (typically the cursor) so the model point
 * under the cursor stays put. Returns a new viewport.
 */
export function zoomAt(vp: Viewport, anchorX: number, anchorY: number, factor: number): Viewport {
  const newScale = clampScale(vp.scale * factor);
  const applied = newScale / vp.scale;
  return {
    scale: newScale,
    // Keep the anchor point stationary: shift origin toward/away from anchor.
    originX: anchorX + (vp.originX - anchorX) * applied,
    originY: anchorY + (vp.originY - anchorY) * applied,
  };
}

export function pan(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...vp, originX: vp.originX + dxScreen, originY: vp.originY + dyScreen };
}

// Interactive zoom limits. Min 1 px/ft is the farthest the user can zoom out;
// max 2000 px/ft caps zoom-in. These bound the MAIN canvas's pan/zoom and the default fit.
const MIN_SCALE = 1;
const MAX_SCALE = 2000;
function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

/** Cubic ease-in-out (slow start, slow stop) for smooth viewport animations. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Cubic ease-OUT (fast start, gentle settle). Used for the viewport zoom/pan tween:
 * a double-click / nav-button zoom is a DIRECT action, so the view should start
 * moving immediately and decelerate into place — ease-in-out's slow first half
 * reads as lag ("I clicked and nothing happened, then it lurched"). This is the
 * standard "decelerate" motion for entering/settling UI.
 */
export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Normalize an angle delta `to - from` into [-π, π] so an animated rotation takes
 * the SHORTEST path rather than spinning the long way. Shared by the 3D massing
 * camera tweens (mini-window thumbnail + Solar Study popup).
 */
export function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Interpolate between two viewports for a clean zoom/pan animation, at parameter
 * `t` in [0,1]. The motion is anchored to the VIEWPORT CENTRE:
 *   - the screen-centre's MODEL point moves LINEARLY from the `from` centre to the
 *     `to` centre — so the focal point of the motion is always dead-centre and the
 *     view glides straight toward its destination;
 *   - the scale moves GEOMETRICALLY (log-space), which reads as a constant-rate
 *     zoom rather than the rushed-then-crawl of a linear scale lerp.
 *
 * Centring the motion is what keeps the zoom feeling clean: no single off-centre
 * anchor can swing across (or fly in from off) the screen mid-animation, which is
 * the artefact a fixed-anchor interpolation produces when `from` and `to` frame
 * different regions (e.g. double-clicking an off-centre panel/cell to zoom in).
 *
 * `w`,`h` are the canvas CSS pixel size (needed to locate each viewport's centre).
 * Pass `t` already eased (e.g. via easeInOut) for slow-in/slow-out. Endpoints are
 * exact: t=0 returns `from`, t=1 returns `to`.
 */
export function lerpViewport(
  from: Viewport,
  to: Viewport,
  t: number,
  w: number,
  h: number,
): Viewport {
  const scale = from.scale * Math.pow(to.scale / from.scale, t);
  const cFrom = toModel(from, w / 2, h / 2);
  const cTo = toModel(to, w / 2, h / 2);
  const cx = cFrom.x + (cTo.x - cFrom.x) * t;
  const cy = cFrom.y + (cTo.y - cFrom.y) * t;
  // Solve the origin so model (cx,cy) sits at the screen centre at this scale
  // (toScreen: w/2 = originX + cx·scale; h/2 = originY − cy·scale).
  return { scale, originX: w / 2 - cx * scale, originY: h / 2 + cy * scale };
}

/**
 * Compute a viewport that FITS a perimeter's bounds into a `width`×`height`
 * canvas, leaving `marginPx` of padding on every side, and centres it.
 *
 * `minScale` is the lowest px/unit the fit may zoom OUT to; it defaults to the
 * interactive MIN_SCALE (0.25) so the main canvas's fits behave as before. The
 * OverviewMap passes a far smaller floor so a large model extent (e.g. a wide
 * many-panel unravel strip) shrinks enough to frame fully in its small box.
 *
 * Used by the mini-window thumbnails: each saved perimeter gets its own
 * fit-to-bounds viewport so the whole shape is visible regardless of its model
 * size or position. Bounds are taken from the FLATTENED outline so curves are
 * accounted for (a bulging curve extends past its anchors).
 *
 * Degenerate cases are handled so the math never divides by zero:
 *   - no vertices            -> a neutral centred viewport at the default scale.
 *   - a single point / a
 *     zero-width or
 *     zero-height bounds      -> we floor the span to a small epsilon so the
 *                               shape sits centred at a sane scale rather than
 *                               producing an infinite/NaN scale.
 */
export function fitViewport(
  p: Perimeter,
  width: number,
  height: number,
  marginPx: number,
  minScale: number = MIN_SCALE,
): Viewport {
  const pts = flattenPerimeter(p);
  if (pts.length === 0) {
    return { scale: 30, originX: width / 2, originY: height / 2 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  // Guard against zero-size bounds (single point, perfectly horizontal/vertical
  // line) which would make the span 0 and the scale Infinity.
  const EPS = 1e-6;
  const spanX = Math.max(maxX - minX, EPS);
  const spanY = Math.max(maxY - minY, EPS);

  // Usable drawing area after margins (kept positive even for tiny windows).
  const availW = Math.max(width - marginPx * 2, 1);
  const availH = Math.max(height - marginPx * 2, 1);

  // Fit: choose the scale that lets BOTH spans fit, then clamp. `minScale`
  // defaults to the interactive MIN_SCALE (so the MAIN canvas's fits are
  // unchanged); callers framing a LARGE extent into a TINY box (the OverviewMap)
  // pass a lower floor so a wide many-panel strip / huge footprint can shrink
  // enough to frame in full instead of overflowing the box at the 0.25 floor.
  const scale = Math.max(minScale, Math.min(MAX_SCALE, Math.min(availW / spanX, availH / spanY)));

  // Centre the bounds' midpoint in the canvas. Model +Y is up, so the screen
  // origin Y must account for the flip via toScreen's subtraction.
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return {
    scale,
    originX: width / 2 - midX * scale,
    originY: height / 2 + midY * scale,
  };
}

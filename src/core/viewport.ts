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
  // ~30px per unit gives a comfortable default working scale.
  scale: 30,
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

function clampScale(s: number): number {
  return Math.max(2, Math.min(2000, s));
}

/** Cubic ease-in-out (slow start, slow stop) for smooth viewport animations. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Interpolate between two viewports for an animated zoom, at parameter `t` in
 * [0,1], keeping a model ANCHOR point's motion natural:
 *   - scale moves GEOMETRICALLY (log-space), which reads as a constant-rate
 *     zoom rather than the rushed-then-crawl of a linear scale lerp;
 *   - the anchor's ON-SCREEN position eases linearly from where it starts to
 *     where the target places it, so the focal point doesn't drift/swim.
 * Pass `t` already eased (e.g. via easeInOut) for slow-in/slow-out.
 */
export function lerpViewportFocal(
  from: Viewport,
  to: Viewport,
  anchor: Point,
  t: number,
): Viewport {
  const scale = from.scale * Math.pow(to.scale / from.scale, t);
  const s0 = toScreen(from, anchor);
  const s1 = toScreen(to, anchor);
  const sx = s0.x + (s1.x - s0.x) * t;
  const sy = s0.y + (s1.y - s0.y) * t;
  // Solve origin so toScreen(vp, anchor) === (sx, sy) at this scale.
  return { scale, originX: sx - anchor.x * scale, originY: sy + anchor.y * scale };
}

/**
 * Compute a viewport that FITS a perimeter's bounds into a `width`×`height`
 * canvas, leaving `marginPx` of padding on every side, and centres it.
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

  // Fit: choose the scale that lets BOTH spans fit, then clamp.
  const scale = clampScale(Math.min(availW / spanX, availH / spanY));

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

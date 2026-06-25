/**
 * core/renderer.ts
 *
 * Rendering layer. Pure-ish: takes the data model + viewport + transient UI
 * state and paints to a 2D canvas. It reads but never mutates the model.
 *
 * All visual VALUES (colours, sizes) are read from CSS custom properties on the
 * canvas element, honouring the project's "single CSS source of truth" rule —
 * the renderer asks the stylesheet for tokens rather than hardcoding them.
 */

import type { Perimeter, Point, Vertex } from "./geometry";
import { distance, angleDeg, isCurved, segmentCubic, handlePoint } from "./geometry";
import type { Viewport } from "./viewport";
import { toScreen } from "./viewport";
import type { UnravelSegment } from "./unravel";

/**
 * An unravel segment paired with the RESOLVED height to draw it at. Heights are
 * PER-PANEL: the input layer resolves each panel's effective height (per-edge
 * override, else the global default) and passes it here, so the renderer stays
 * height-policy-agnostic and just draws each rectangle at its own height.
 */
export interface UnravelDraw {
  seg: UnravelSegment;
  /** Effective height (model units) for THIS panel's rectangle (y = 0 → height). */
  height: number;
  /** Number of equal-width vertical cells to split this panel into (>= 1). */
  cells: number;
}

/** Transient interaction state the renderer needs to draw feedback. */
export interface RenderState {
  perimeter: Perimeter;
  viewport: Viewport;
  /** Live cursor position in MODEL space (already snapped/constrained). */
  cursorModel: Point | null;
  /** True while actively placing vertices (controls the first-vertex affordance). */
  drawing: boolean;
  /** Whether to draw the cursor-following rubber-band segment. */
  rubberBand: boolean;
  /** Index of selected vertex, or -1. */
  selectedVertex: number;
  /** Index of hovered vertex, or -1. */
  hoveredVertex: number;
  /** Vertex whose Bézier handles should be drawn (selected/active), or -1. */
  handleVertex: number;
  /** Candidate point on a segment for vertex insertion (edit mode), or null. */
  insertPreview: Point | null;
  /** Grid spacing in model units; <= 0 hides grid. */
  gridSpacing: number;
  showGrid: boolean;
  /**
   * When set (non-empty), the tool is in UNRAVEL view: the perimeter shape is
   * hidden and these unrolled edge rectangles are drawn instead. Each entry pairs
   * an {@link UnravelSegment} with its PER-PANEL resolved height (model units).
   */
  unravel?: UnravelDraw[] | null;
  /**
   * UNRAVEL view only: original edge index of the unravel strip the cursor is
   * hovering, or -1/undefined for none. The matching rectangle is drawn highlighted.
   */
  hoveredUnravelEdge?: number;
  /**
   * UNRAVEL view only: original edge index whose rectangle TOP edge is hovered for
   * a height-resize, or -1/undefined for none. Its top edge is drawn emphasised to
   * advertise the drag affordance (the canvas also switches to an ns-resize cursor).
   */
  hoveredUnravelTop?: number;
  /**
   * NORMAL (shape) branch only: edge index to draw highlighted on top of the
   * normal stroke (used by mini-window thumbnails to show the edge linked to a
   * hovered unravel strip). -1/undefined or out-of-range = no highlight.
   */
  highlightEdge?: number;
  /**
   * Placed floor-plate elevations (model Y). Each is drawn as a dotted horizontal
   * line spanning the full canvas width at that elevation. Shown in BOTH the
   * normal and unravel views (a level reference that pans/zooms with the scene).
   */
  floorPlates?: number[] | null;
  /**
   * Floor-plate placement preview: the cursor's current elevation (model Y) while
   * the floor-plate tool is armed, drawn as a fainter "ghost" dotted line; null
   * when the tool is off or the cursor is outside the canvas.
   */
  floorPlatePreview?: number | null;
}

/** Read a CSS custom property from an element, with a fallback. */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function cssNum(el: HTMLElement, name: string, fallback: number): number {
  const v = parseFloat(cssVar(el, name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

export function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  state: RenderState,
): void {
  // Resolve tokens once per frame. Fallbacks mirror the LIGHT defaults in
  // styles.css; the live values still come from CSS so styling stays single-source.
  const tk = {
    bg: cssVar(canvas, "--canvas-bg", "#ffffff"),
    gridMinor: cssVar(canvas, "--grid-minor", "#e3e8ed"),
    gridMajor: cssVar(canvas, "--grid-major", "#c3ccd5"),
    segment: cssVar(canvas, "--segment-color", "#1f6feb"),
    segmentClosed: cssVar(canvas, "--segment-closed-color", "#1f9d6b"),
    rubber: cssVar(canvas, "--rubberband-color", "#c2700a"),
    fill: cssVar(canvas, "--polygon-fill", "rgba(31,157,107,0.10)"),
    vertex: cssVar(canvas, "--vertex-color", "#3a4754"),
    vertexHover: cssVar(canvas, "--vertex-hover-color", "#c2700a"),
    vertexSelected: cssVar(canvas, "--vertex-selected-color", "#d23154"),
    vertexFirst: cssVar(canvas, "--vertex-first-color", "#1f9d6b"),
    insert: cssVar(canvas, "--insert-preview-color", "#c2700a"),
    handleLine: cssVar(canvas, "--handle-line-color", "#8492a0"),
    handleKnob: cssVar(canvas, "--handle-knob-color", "#1f6feb"),
    unravelLine: cssVar(canvas, "--unravel-line-color", "#1f6feb"),
    unravelCurve: cssVar(canvas, "--unravel-curve-color", "#c2700a"),
    unravelCell: cssVar(canvas, "--unravel-cell-color", "#8492a0"),
    unravelRectFill: cssVar(canvas, "--unravel-rect-fill", "rgba(31,111,235,0.10)"),
    unravelHighlightFill: cssVar(canvas, "--unravel-highlight-fill", "rgba(210,49,84,0.18)"),
    highlight: cssVar(canvas, "--unravel-highlight-color", "#d23154"),
    vertexR: cssNum(canvas, "--vertex-radius", 4),
    handleR: cssNum(canvas, "--handle-radius", 3.5),
    segmentW: cssNum(canvas, "--segment-width", 1.5),
    highlightW: cssNum(canvas, "--highlight-width", 3),
    unravelTopW: cssNum(canvas, "--unravel-top-width", 4),
    gridW: cssNum(canvas, "--grid-width", 1),
    // Shared gap (px) between a panel border and its dimension label. Read from
    // the same token the HEIGHT field's CSS transform uses, so the WIDTH label
    // (above each panel) and the HEIGHT field (left of each panel) sit the SAME
    // distance outside their borders. cssNum parses the leading number from "4px".
    unravelLabelGap: cssNum(canvas, "--unravel-label-gap", 4),
    // Floor-plate level lines: placed (solid colour) + ghosted placement preview.
    floorPlate: cssVar(canvas, "--floorplate-color", "#7a8694"),
    floorPlateGhost: cssVar(canvas, "--floorplate-ghost-color", "rgba(122,134,148,0.45)"),
    floorPlateW: cssNum(canvas, "--floorplate-width", 1),
    floorPlateDash: cssNum(canvas, "--floorplate-dash", 6),
    floorPlateGap: cssNum(canvas, "--floorplate-dash-gap", 5),
    // Gap (px) between the unravel strip's left edge and a floor-plate height
    // label parked to its left (UNRAVEL view only — see drawFloorPlates).
    floorPlateLabelGap: cssNum(canvas, "--floorplate-label-gap", 8),
  };

  // Reset transform and clear in device pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = tk.bg;
  ctx.fillRect(0, 0, width, height);

  if (state.showGrid && state.gridSpacing > 0) {
    drawGrid(ctx, width, height, state.viewport, state.gridSpacing, tk);
  }

  // UNRAVEL VIEW: draw the unrolled edge rectangles instead of the shape.
  if (state.unravel && state.unravel.length > 0) {
    drawUnravel(
      ctx,
      canvas,
      state.viewport,
      state.unravel,
      state.hoveredUnravelEdge ?? -1,
      state.hoveredUnravelTop ?? -1,
      tk,
    );
    // Floor-plate level lines sit on top of the unravel rectangles. In the
    // UNRAVEL view they are also LABELLED with their height (elevation above the
    // panel baseline at model y = 0, which is the ground floor = height 0). The
    // labels are parked just LEFT of the strip, so we pass the leftmost panel
    // edge in model-x (min over all draws of min(seg.x0, seg.x1)); drawFloorPlates
    // converts it to screen and right-aligns each marker just left of the strip.
    let leftModelX = Infinity;
    for (const { seg } of state.unravel) {
      leftModelX = Math.min(leftModelX, seg.x0, seg.x1);
    }
    drawFloorPlates(
      ctx,
      canvas,
      width,
      state.viewport,
      state.floorPlates ?? null,
      state.floorPlatePreview ?? null,
      tk,
      Number.isFinite(leftModelX) ? leftModelX : null,
    );
    return;
  }

  const v = state.perimeter.vertices;

  // Filled polygon when closed (curve-aware path).
  if (state.perimeter.closed && v.length >= 3) {
    ctx.beginPath();
    tracePerimeterPath(ctx, state.viewport, state.perimeter, true);
    ctx.fillStyle = tk.fill;
    ctx.fill();
  }

  // Committed segments (lines and Bézier curves).
  if (v.length >= 2) {
    ctx.beginPath();
    tracePerimeterPath(ctx, state.viewport, state.perimeter, state.perimeter.closed);
    ctx.strokeStyle = state.perimeter.closed ? tk.segmentClosed : tk.segment;
    ctx.lineWidth = tk.segmentW;
    ctx.stroke();
  }

  // Single-edge highlight (mini-window hover-link): re-draw one edge on top of
  // the normal stroke in the highlight colour/width. Reuses the same line/curve
  // tracing as the perimeter path so curves are honoured.
  if (state.highlightEdge !== undefined && state.highlightEdge >= 0) {
    drawHighlightEdge(ctx, state.viewport, state.perimeter, state.highlightEdge, tk);
  }

  // Bézier handles for the selected/active vertex (lines + knobs).
  if (state.handleVertex >= 0 && state.handleVertex < v.length) {
    drawHandles(ctx, state.viewport, v[state.handleVertex], tk);
  }

  // Rubber-band: last vertex -> cursor, with live length/angle label.
  if (state.rubberBand && state.cursorModel && v.length >= 1) {
    const last = v[v.length - 1];
    const a = toScreen(state.viewport, last);
    const b = toScreen(state.viewport, state.cursorModel);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = tk.rubber;
    ctx.lineWidth = tk.segmentW;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    drawSegmentLabel(ctx, canvas, a, b, distance(last, state.cursorModel), angleDeg(last, state.cursorModel));
  }

  // Insertion preview marker (edit mode).
  if (state.insertPreview) {
    const s = toScreen(state.viewport, state.insertPreview);
    ctx.beginPath();
    ctx.arc(s.x, s.y, tk.vertexR + 1, 0, Math.PI * 2);
    ctx.strokeStyle = tk.insert;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    drawPlus(ctx, s.x, s.y, tk.vertexR, tk.insert);
  }

  // Vertices on top.
  v.forEach((pt, i) => {
    const s = toScreen(state.viewport, pt);
    let color = tk.vertex;
    if (i === 0 && !state.perimeter.closed && state.drawing) color = tk.vertexFirst;
    if (i === state.hoveredVertex) color = tk.vertexHover;
    if (i === state.selectedVertex) color = tk.vertexSelected;
    ctx.beginPath();
    ctx.arc(s.x, s.y, tk.vertexR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // First vertex gets a ring while drawing to advertise "click to close".
    if (i === 0 && !state.perimeter.closed && state.drawing && v.length >= 3) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, tk.vertexR + 4, 0, Math.PI * 2);
      ctx.strokeStyle = tk.vertexFirst;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });

  // Floor-plate level lines on top of the shape. NORMAL view: lines only, no
  // height labels (there's no meaningful ground datum here) — omit the leftmost
  // edge so drawFloorPlates draws lines without elevation markers.
  drawFloorPlates(ctx, canvas, width, state.viewport, state.floorPlates ?? null, state.floorPlatePreview ?? null, tk);
}

/**
 * Draw horizontal floor-plate level lines: each placed elevation (and the live
 * placement preview, fainter) becomes a dotted line spanning the full canvas
 * width at its model-Y, converted to a screen Y through the viewport (so the
 * lines pan/zoom with the scene). Placed lines use the solid floor-plate colour;
 * the preview uses the ghost colour. No-ops when there's nothing to draw.
 *
 * HEIGHT LABELS (UNRAVEL view only): when `leftModelX` is provided (the leftmost
 * unravelled panel edge in model-x), each plate is ALSO labelled with its height
 * — its elevation above the panel baseline at model y = 0, the ground floor. Since
 * the baseline is y = 0, that height is simply the plate's model-Y value. The
 * marker is drawn just LEFT of the strip (right-aligned to sit neatly outside it,
 * `--floorplate-label-gap` px clear of the leftmost panel edge), vertically centred
 * on its line, so it never clashes with the panels or their dimension labels. When
 * `leftModelX` is null/omitted (the NORMAL/shape view, which has no ground datum),
 * only the lines are drawn — no labels.
 */
function drawFloorPlates(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  vp: Viewport,
  plates: number[] | null,
  preview: number | null,
  tk: {
    floorPlate: string;
    floorPlateGhost: string;
    floorPlateW: number;
    floorPlateDash: number;
    floorPlateGap: number;
    floorPlateLabelGap: number;
  },
  leftModelX: number | null = null,
): void {
  if ((!plates || plates.length === 0) && preview == null) return;

  const line = (modelY: number, color: string): void => {
    const sy = toScreen(vp, { x: 0, y: modelY }).y;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.strokeStyle = color;
    ctx.lineWidth = tk.floorPlateW;
    ctx.stroke();
  };

  ctx.setLineDash([tk.floorPlateDash, tk.floorPlateGap]);
  if (plates) for (const y of plates) line(y, tk.floorPlate);
  // Preview last so it reads on top; skip if it coincides with a placed line.
  if (preview != null) line(preview, tk.floorPlateGhost);
  ctx.setLineDash([]);

  // Height markers — UNRAVEL view only (leftModelX supplied). Right edge of each
  // label sits `floorPlateLabelGap` px left of the strip's leftmost screen-x.
  if (leftModelX == null) return;
  const rightX = toScreen(vp, { x: leftModelX, y: 0 }).x - tk.floorPlateLabelGap;
  // Datum: baseline (model y = 0) is height 0, so the marker text = the plate's
  // model-Y, formatted to match the existing dimension labels (2 decimals, bare).
  if (plates) for (const y of plates) {
    drawRightAlignedLabel(ctx, canvas, rightX, toScreen(vp, { x: leftModelX, y }).y, y.toFixed(2));
  }
  if (preview != null) {
    drawRightAlignedLabel(ctx, canvas, rightX, toScreen(vp, { x: leftModelX, y: preview }).y, preview.toFixed(2));
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  vp: Viewport,
  spacing: number,
  tk: { gridMinor: string; gridMajor: string; gridW: number },
): void {
  // Determine the model-space range visible, then step by `spacing`.
  const left = (0 - vp.originX) / vp.scale;
  const right = (width - vp.originX) / vp.scale;
  const top = (vp.originY - 0) / vp.scale;
  const bottom = (vp.originY - height) / vp.scale;

  // Skip drawing if grid lines would be denser than ~6px (unreadable / slow).
  if (spacing * vp.scale < 6) return;

  ctx.lineWidth = tk.gridW;

  const startX = Math.floor(left / spacing) * spacing;
  for (let x = startX; x <= right; x += spacing) {
    const sx = vp.originX + x * vp.scale;
    // Every 5th line is "major".
    const major = Math.abs(Math.round(x / spacing) % 5) === 0;
    ctx.strokeStyle = major ? tk.gridMajor : tk.gridMinor;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
    ctx.stroke();
  }

  const startY = Math.floor(bottom / spacing) * spacing;
  for (let y = startY; y <= top; y += spacing) {
    const sy = vp.originY - y * vp.scale;
    const major = Math.abs(Math.round(y / spacing) % 5) === 0;
    ctx.strokeStyle = major ? tk.gridMajor : tk.gridMinor;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
}

function drawSegmentLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  a: Point,
  b: Point,
  length: number,
  angle: number,
): void {
  const text = `${length.toFixed(2)}  ∠${angle.toFixed(1)}°`;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const fg = cssVar(canvas, "--label-text", "#1c2530");
  const bgc = cssVar(canvas, "--label-bg", "rgba(255,255,255,0.88)");
  ctx.font = cssVar(canvas, "--label-font", "12px ui-monospace, monospace");
  const padding = 4;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = bgc;
  ctx.fillRect(midX + 8, midY - 18, w + padding * 2, 18);
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, midX + 8 + padding, midY - 9);
}

function drawPlus(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
}

/**
 * Trace the perimeter outline into the CURRENT path, using straight lines for
 * line segments and bezierCurveTo for curved ones. Caller has already called
 * beginPath(); we only moveTo/lineTo/bezierCurveTo (and optionally closePath).
 * Shared by both the fill and the stroke so they always agree.
 */
function tracePerimeterPath(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  p: Perimeter,
  closed: boolean,
): void {
  const v = p.vertices;
  if (v.length === 0) return;
  const start = toScreen(vp, v[0]);
  ctx.moveTo(start.x, start.y);
  const traceSeg = (a: Vertex, b: Vertex): void => {
    if (!isCurved(a, b)) {
      const s = toScreen(vp, b);
      ctx.lineTo(s.x, s.y);
    } else {
      const [, c1, c2, p3] = segmentCubic(a, b);
      const sc1 = toScreen(vp, c1);
      const sc2 = toScreen(vp, c2);
      const s3 = toScreen(vp, p3);
      ctx.bezierCurveTo(sc1.x, sc1.y, sc2.x, sc2.y, s3.x, s3.y);
    }
  };
  for (let i = 0; i < v.length - 1; i++) traceSeg(v[i], v[i + 1]);
  if (closed && v.length >= 3) {
    traceSeg(v[v.length - 1], v[0]);
    ctx.closePath();
  }
}

/**
 * Re-draw a SINGLE edge of the perimeter highlighted (mini-window hover-link).
 * Edge `index` runs from vertices[index] to vertices[(index+1) % n]; the closing
 * edge (index n-1 of a closed shape) is included. Honours curves via the same
 * isCurved/segmentCubic tracing as the main path, so a curved edge highlights
 * along its curve. Out-of-range indices are ignored.
 */
function drawHighlightEdge(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  p: Perimeter,
  index: number,
  tk: { highlight: string; highlightW: number },
): void {
  const v = p.vertices;
  const n = v.length;
  if (n < 2) return;
  const edgeCount = p.closed ? n : n - 1;
  if (index < 0 || index >= edgeCount) return;
  const a = v[index];
  const b = v[(index + 1) % n];
  const sa = toScreen(vp, a);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  if (!isCurved(a, b)) {
    const sb = toScreen(vp, b);
    ctx.lineTo(sb.x, sb.y);
  } else {
    const [, c1, c2, p3] = segmentCubic(a, b);
    const sc1 = toScreen(vp, c1);
    const sc2 = toScreen(vp, c2);
    const s3 = toScreen(vp, p3);
    ctx.bezierCurveTo(sc1.x, sc1.y, sc2.x, sc2.y, s3.x, s3.y);
  }
  ctx.strokeStyle = tk.highlight;
  ctx.lineWidth = tk.highlightW;
  ctx.stroke();
}

/**
 * Draw the UNRAVEL view: each edge becomes a RECTANGLE ("space"/panel) standing
 * on the baseline (model y = 0) and rising to y = `height`. The rectangle's
 * WIDTH is the segment length (preserved from the source edge — geometry-derived
 * and unchangeable); the HEIGHT is the shared `height` applied to every edge.
 *
 * Each rectangle is filled + stroked, with a length label above it. Rectangles
 * from curved edges are dashed/tinted to flag they were rolled out from an arc.
 * The hovered rectangle (matching `hoveredEdge`) is drawn in the highlight fill
 * + stroke so it visibly links to the highlighted edge in the preview. The
 * rectangle whose TOP edge is hovered for resize (`hoveredTop`) gets its top edge
 * redrawn emphasised so the drag affordance reads clearly (paired with the
 * ns-resize cursor set by the input layer).
 *
 * Heights are PER-PANEL: each `UnravelDraw` carries its own resolved height, so
 * every rectangle can rise to a different y = height.
 */
function drawUnravel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vp: Viewport,
  draws: UnravelDraw[],
  hoveredEdge: number,
  hoveredTop: number,
  tk: {
    unravelLine: string;
    unravelCurve: string;
    unravelCell: string;
    unravelRectFill: string;
    unravelHighlightFill: string;
    highlight: string;
    segmentW: number;
    highlightW: number;
    unravelTopW: number;
    unravelLabelGap: number;
  },
): void {
  for (const { seg, height, cells } of draws) {
    // Guard against a non-positive height so the rectangle always has visible area.
    const h = Math.max(height, 0);
    // Rectangle corners: baseline (y=0) to top (y=height), spanning x0..x1.
    const baseL = toScreen(vp, { x: seg.x0, y: 0 });
    const baseR = toScreen(vp, { x: seg.x1, y: 0 });
    const topL = toScreen(vp, { x: seg.x0, y: h });
    const hovered = seg.index === hoveredEdge;

    // Screen-space rectangle (model +Y up flips to screen -Y, so topL.y < baseL.y).
    const x = baseL.x;
    const y = topL.y;
    const w = baseR.x - baseL.x;
    const rectH = baseL.y - topL.y;

    // Fill.
    ctx.fillStyle = hovered ? tk.unravelHighlightFill : tk.unravelRectFill;
    ctx.fillRect(x, y, w, rectH);

    // Outline. Hovered rect uses the highlight colour + thicker stroke; curved
    // edges are dashed regardless so their arc-length origin stays distinguishable.
    ctx.beginPath();
    ctx.rect(x, y, w, rectH);
    ctx.strokeStyle = hovered ? tk.highlight : seg.curved ? tk.unravelCurve : tk.unravelLine;
    ctx.lineWidth = hovered ? tk.highlightW : tk.segmentW;
    if (seg.curved) ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Cell splits: N-1 equal-width vertical division lines inside the rectangle.
    const nCells = Math.max(1, Math.round(cells));
    if (nCells > 1) {
      ctx.strokeStyle = tk.unravelCell;
      ctx.lineWidth = tk.segmentW;
      for (let k = 1; k < nCells; k++) {
        const mx = seg.x0 + (seg.x1 - seg.x0) * (k / nCells);
        const a = toScreen(vp, { x: mx, y: 0 });
        const b = toScreen(vp, { x: mx, y: h });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Top-edge resize affordance: redraw just the top edge emphasised when hovered.
    if (seg.index === hoveredTop) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.strokeStyle = tk.highlight;
      ctx.lineWidth = tk.unravelTopW;
      ctx.stroke();
    }

    // Length (WIDTH) label above the rectangle top, centred over its width. Its
    // bottom edge sits `unravelLabelGap` px above the top border — the SAME gap
    // the HEIGHT field uses outside the left border (shared --unravel-label-gap).
    drawCenteredLabel(ctx, canvas, (baseL.x + baseR.x) / 2, topL.y - tk.unravelLabelGap, seg.length.toFixed(2));
  }
}

/** Draw a small text label with a background plate, horizontally centred at x,
 *  with its bottom edge at bottomY. */
function drawCenteredLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cx: number,
  bottomY: number,
  text: string,
): void {
  const fg = cssVar(canvas, "--label-text", "#1c2530");
  const bgc = cssVar(canvas, "--label-bg", "rgba(255,255,255,0.88)");
  ctx.font = cssVar(canvas, "--label-font", "12px ui-monospace, monospace");
  const padding = 4;
  const h = 16;
  const w = ctx.measureText(text).width;
  const x = cx - (w + padding * 2) / 2;
  const y = bottomY - h;
  ctx.fillStyle = bgc;
  ctx.fillRect(x, y, w + padding * 2, h);
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padding, y + h / 2);
}

/**
 * Draw a small text label with a background plate whose RIGHT edge is at `rightX`
 * and which is vertically CENTRED on `cy`. Used for floor-plate height markers
 * parked just left of the unravel strip, so they read as a right-aligned column
 * of elevations. Matches the look of the other dimension labels (same CSS tokens).
 */
function drawRightAlignedLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  rightX: number,
  cy: number,
  text: string,
): void {
  const fg = cssVar(canvas, "--label-text", "#1c2530");
  const bgc = cssVar(canvas, "--label-bg", "rgba(255,255,255,0.88)");
  ctx.font = cssVar(canvas, "--label-font", "12px ui-monospace, monospace");
  const padding = 4;
  const h = 16;
  const w = ctx.measureText(text).width;
  const x = rightX - (w + padding * 2);
  const y = cy - h / 2;
  ctx.fillStyle = bgc;
  ctx.fillRect(x, y, w + padding * 2, h);
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padding, y + h / 2);
}

/** Draw the in/out Bézier handle lines and square knobs for one vertex. */
function drawHandles(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  vert: Vertex,
  tk: { handleLine: string; handleKnob: string; handleR: number },
): void {
  const anchor = toScreen(vp, vert);
  for (const which of ["in", "out"] as const) {
    const hp = handlePoint(vert, which);
    if (!hp) continue;
    const s = toScreen(vp, hp);
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(s.x, s.y);
    ctx.strokeStyle = tk.handleLine;
    ctx.lineWidth = 1;
    ctx.stroke();
    // Square knob to distinguish a control handle from a round anchor vertex.
    const r = tk.handleR;
    ctx.fillStyle = tk.handleKnob;
    ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
  }
}

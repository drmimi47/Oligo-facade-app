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
import { fmtLengthTick, lengthTick } from "./units";

/**
 * Golden-angle hue step (degrees) for the Material-ID cell view. Spacing successive
 * shape colours by ~137.5° gives maximally distinct, well-separated hues even for
 * many distinct cell shapes (the same trick procedural palettes use). The saturation,
 * lightness and fill alpha are read from CSS tokens so the look stays editable from
 * the single stylesheet source of truth.
 */
const CELL_VIEW_GOLDEN_ANGLE = 137.508;

/** An RGB colour triplet (0–255 channels) for gradient interpolation. */
interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse a `#rgb` / `#rrggbb` hex string into an {@link RGB}. Used for the Orientation
 * Heatmap gradient stops (defined as hex CSS tokens). Falls back to mid-grey on any
 * unparseable input so a typo can never crash the renderer.
 */
function parseHexRGB(hex: string): RGB {
  const s = hex.trim().replace(/^#/, "");
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (![r, g, b].some(Number.isNaN)) return { r, g, b };
  } else if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (![r, g, b].some(Number.isNaN)) return { r, g, b };
  }
  return { r: 128, g: 128, b: 128 };
}

/**
 * Sample a multi-stop colour ramp (the Orientation Heatmap gradient — a vivid cold→hot
 * thermal scale, blue → cyan → yellow → red) at position `t` in [0,1], blending the
 * two bracketing stops in RGB. Returns an `rgba(...)` string at the given alpha.
 */
function sampleRamp(stops: RGB[], t: number, alpha: number): string {
  if (stops.length === 0) return `rgba(128,128,128,${alpha})`;
  if (stops.length === 1) return `rgba(${stops[0].r},${stops[0].g},${stops[0].b},${alpha})`;
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a.r + (b.r - a.r) * f);
  const g = Math.round(a.g + (b.g - a.g) * f);
  const bl = Math.round(a.b + (b.b - a.b) * f);
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

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
  /**
   * User-placed vertical division lines (Subtractive tool), as OFFSETS in model
   * units from this panel's left edge (seg.x0). Drawn as solid mullion lines from
   * the baseline to the panel top. Empty/undefined = none.
   */
  divisions?: number[];
  /**
   * User-placed HORIZONTAL divider lines (Subtractive tool with Shift held), as
   * OFFSETS in model units from this panel's baseline (y = 0). Drawn as solid lines
   * spanning the panel width (seg.x0 → seg.x1) at each offset. Empty/undefined = none.
   */
  dividersH?: number[];
  /**
   * Mullion HALF-WIDTH offset (model units / feet) applied to EVERY vertical grid
   * line of this panel (the equal-cell splits + Subtractive divisions): each line is
   * drawn as a PAIR of lines at ±this offset (the mullion faces, "either side").
   * 0/undefined = no vertical mullion width. Set by the Mullions tool (Stick system).
   */
  mullionV?: number;
  /** Mullion half-width offset for every HORIZONTAL grid line of this panel. */
  mullionH?: number;
  /**
   * Mullions tool HOVER on the focused panel: which axis's grid lines are currently
   * hovered (highlighted to show they'll adjust together), or null. Only set on the
   * focused panel.
   */
  mullionHoverAxis?: "v" | "h" | null;
  /**
   * UNITIZED per-cell framing (Framing tool under the Unitized CW system): each entry
   * is one of this panel's grid CELLS (model rect x0..x1, y0..y1) with the inward INSET
   * of each of its four edges (top/right/bottom/left, model feet). Each non-zero inset
   * draws a solid frame face inset that far from the corresponding cell edge. Empty/
   * undefined = no cell framing. Includes the live drag draft override.
   */
  cellFraming?: Array<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  }>;
  /**
   * Framing-tool HOVER (Unitized) on the focused panel: the cell + which of its four
   * edges the cursor is targeting, drawn highlighted so the user sees the single edge
   * that will move. `offset` is the live inset (for a label); `all` highlights all four
   * edges (Shift). null when not hovering an edge.
   */
  frameHover?: {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    side: "top" | "right" | "bottom" | "left";
    offset: number;
    all: boolean;
  } | null;
  /**
   * MATERIAL-ID view (the "View" button's Material-ID mode): one entry per grid CELL
   * of this panel, carrying a `colorIndex` that groups cells of identical geometric
   * SHAPE across the whole project. The renderer turns the index into a distinct hue
   * (golden-angle spread) and fills the cell with it — a Lumion-style Material ID
   * overlay so matching cells read in the same colour. `shade` is the cell's position
   * (0 → 1) within its shape group; the renderer tapers saturation across it so
   * identical cells get slightly different shades. Undefined when the view is off.
   */
  cellColors?: Array<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    colorIndex: number;
    shade?: number;
  }>;
  /**
   * ORIENTATION HEATMAP view (the "View" button's Orientation mode): one entry per
   * grid CELL of this panel. `t` is a heat scalar in [0,1] (0 = cool/blue/north-
   * facing, 1 = warm/red/west-facing) the renderer maps through a CSS-tuned hue ramp
   * to fill the cell; `label` is the cell's 8-point cardinal direction (N, NE, …),
   * drawn centred in the cell. `sun` is the LIVE direct-sun incidence readout for the
   * facade (e.g. "63%", "0%" when self-shaded, "—" at night) — drawn as a smaller
   * second line under the cardinal when the cell is tall enough. The facing comes from
   * the panel's exterior face normal rotated by the Solar Study's north offset (real
   * per-face data); `sun` additionally uses the studied day + hour. Undefined off-view.
   */
  cellOrient?: Array<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    t: number;
    label: string;
    sun?: string;
  }>;
  /**
   * PER-CELL TYPE (the "Type" tool): each entry is the GLASS-INFILL rect of one typed cell
   * (x0..x1, y0..y1 in model space — already the cell MINUS its extruded frame members) plus
   * its assigned glazing `type` (Vision / Spandrel / Opaque). The renderer overlays a per-
   * type HATCH inside that rect so the elevation reads as a typed facade; the hatch never
   * touches the framing (the frame area is the non-glazed infill). Present in every view
   * (facade spec, not a view mode); only populated while the Type eye is on and the cell
   * carries a type. Undefined = nothing typed on this panel.
   */
  cellTypes?: Array<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    type: "vision" | "spandrel" | "opaque";
  }>;
  /**
   * SHADOWS view only: the glass-infill rects of OPAQUE cells. An opaque infill panel sits
   * FLUSH with the frame face (not recessed like vision/spandrel glass), so no cast shadow
   * lands on it — the renderer punches these rects out of the shadow clip. Independent of the
   * Type-hatch visibility toggle (it's a property of the assigned type, not a view preference).
   */
  opaqueCells?: Array<{ x0: number; x1: number; y0: number; y1: number }>;
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
  /** REVIT-STYLE DIMENSION ENTRY (perimeter draw): when the user is typing an exact
   *  segment length, the rubber band ends HERE — the last vertex plus the typed length
   *  along the cursor direction — instead of at the cursor. null when not entering a
   *  dimension or the direction is undefined (then it falls back to the cursor). */
  dimPreview?: Point | null;
  /** The raw dimension string being typed (e.g. "12."), shown verbatim as the rubber
   *  band's length label (accented) so partial input is visible. null when none. */
  dimText?: string | null;
  /** Index of selected vertex, or -1. */
  selectedVertex: number;
  /** Index of hovered vertex, or -1. */
  hoveredVertex: number;
  /** Erase tool armed in the perimeter view: the hovered vertex is drawn in the
   *  delete colour (a click removes it) rather than the normal hover colour. */
  eraseVertexArmed?: boolean;
  /** Perimeter vertex indices collected during an active Erase click-drag stroke,
   *  drawn in the delete colour to preview what the pointer-up commit will remove. */
  eraseVertices?: number[];
  /** Erase tool: perimeter EDGE indices targeted for removal — the hovered edge and
   *  any swept up during a click-drag stroke — each drawn in the delete colour so the
   *  user sees which segments a release will remove. Empty/undefined when none. */
  eraseEdges?: number[];
  /** Vertex whose Bézier handles should be drawn (selected/active), or -1. */
  handleVertex: number;
  /** Candidate point on a segment for vertex insertion (edit mode), or null. */
  insertPreview: Point | null;
  /**
   * Grid spacing in model units. Drives SNAPPING only (the snap geometry rounds
   * to this spacing); the grid itself is never drawn, so this is not a visual
   * field. Kept here because the input layer passes it through the render state.
   */
  gridSpacing: number;
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
   * UNRAVEL view only: set of ORIGINAL edge indices currently SELECTED for export
   * (via the Export marquee). Selected panels are drawn in the distinct export
   * selection fill/stroke so it's clear which walls will be exported. Empty/omitted
   * = no selection.
   */
  exportSelection?: ReadonlySet<number> | null;
  /**
   * UNRAVEL view only: the live export-selection MARQUEE rectangle in MODEL space
   * (the two drag corners), drawn as a dashed rubber-band while the user is dragging
   * out a selection. null/omitted when not marquee-dragging.
   */
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
  /**
   * UNRAVEL view (Panels phase) only: the model-space rectangle of the single grid
   * CELL the cursor is hovering within the focused panel, or null/undefined for none.
   * Drawn as a tinted fill so a subdivided panel reads as a set of individually
   * navigable cells. Suppressed in OVERVIEW boundaries-only mode.
   */
  hoveredCell?: { x0: number; x1: number; y0: number; y1: number } | null;
  /**
   * UNRAVEL view (Wall Border phase) only: the model-space rectangles of the grid cells
   * the user has SELECTED for glazing-type assignment, each tagged with its owning edge
   * (so a project-wide Shift+select can highlight cells on more than one panel). Drawn
   * with a stronger fill + outline than the hover tint. Empty/undefined = nothing selected.
   */
  selectedCells?: Array<{ edge: number; x0: number; x1: number; y0: number; y1: number }> | null;
  /**
   * UNRAVEL view only: original edge index of the panel currently SELECTED via
   * double-click (the active target for the Additive / Subtractive operations), or
   * -1/undefined for none. The selected panel's WIDTH dimension label is drawn in
   * the faint floor-plate grey (tk.floorPlate) instead of the default label colour,
   * signalling it is the active panel. (Mirrors the input layer's `focusedPanel`.)
   */
  selectedUnravelPanel?: number;
  /**
   * UNRAVEL view, PANELS phase only: edge index of the focused panel to annotate
   * with per-COLUMN width labels (top) and per-ROW height labels (left), or
   * -1/undefined for none. Lets the Panels view dimension the focused panel's full
   * grid (one width per column, one height per row) the way the strip view shows a
   * single overall width per panel. Suppressed in OVERVIEW boundaries-only mode.
   */
  cellDimEdge?: number;
  /**
   * UNRAVEL view, ASSEMBLY phase only: the model-space rectangle of the single
   * SELECTED cell (the one double-clicked into), to annotate with a dimension
   * label on ALL FOUR edges — top/bottom show its WIDTH, left/right its HEIGHT.
   * null/undefined in every other phase so these per-edge labels never appear in
   * the full Elevations strip, the Panels grid, or the perimeter view.
   */
  focusedCellDims?: { x0: number; x1: number; y0: number; y1: number } | null;
  /**
   * UNRAVEL view, ASSEMBLY phase only: which edge of the focused cell the cursor
   * is hovering (within a pixel tolerance), drawn stroked in red to mark it as
   * selected — one edge at a time. null/undefined when the cursor is not near any
   * edge (or outside Assembly).
   */
  focusedCellEdge?: "top" | "right" | "bottom" | "left" | null;
  /**
   * NORMAL (shape) branch only: edge index to draw highlighted on top of the
   * normal stroke (used by mini-window thumbnails to show the edge linked to a
   * hovered unravel strip). -1/undefined or out-of-range = no highlight.
   */
  highlightEdge?: number;
  /**
   * Placed floor-plate elevations (model Y). Each is drawn as a dotted horizontal
   * line spanning the full canvas width at that elevation. Shown ONLY in the
   * UNRAVEL view (floor plates are an elevation/levels concept above the ground
   * datum; the normal plan view has no height datum). Pans/zooms with the scene.
   */
  floorPlates?: number[] | null;
  /**
   * Floor-plate placement preview: the cursor's current elevation (model Y) while
   * the floor-plate tool is armed, drawn as a fainter "ghost" dotted line; null
   * when the tool is off or the cursor is outside the canvas.
   */
  floorPlatePreview?: number | null;
  /**
   * Subtractive panel-division PREVIEW: the candidate division line(s) under the
   * cursor (a single hovered line, or the full evenly-spaced array while click-
   * dragging), drawn as faint "ghost" lines so the user sees where divisions will
   * land before committing. `xs` = VERTICAL preview lines as MODEL x positions
   * (equal-column split); `ys` = HORIZONTAL preview lines as MODEL y positions
   * (equal-row split, when Shift flips the axis). Only one is populated at a time.
   * `dim`, when present, is a live SPACING DIMENSION (parallel to the divisions): a
   * generalized measure SEGMENT between two model-space endpoints (`x1,y1`→`x2,y2`)
   * spanning one bay, labelled with `dist` (model units / feet) so the user sees how
   * far apart the divisions will be — a HORIZONTAL segment for column splits (measures
   * a column width) or a VERTICAL segment for row splits (measures a row height).
   * null when the Subtractive tool is off / cursor outside panel.
   */
  dividePreview?: {
    edge: number;
    xs?: number[];
    ys?: number[];
    dim?: { x1: number; y1: number; x2: number; y2: number; dist: number } | null;
  } | null;
  /**
   * Eraser deletion HIGHLIGHTS: all division lines currently targeted for removal
   * by the armed Eraser tool (hover + any accumulated during a drag stroke), each
   * drawn in the distinct deletion colour. Empty when the Eraser is off.
   */
  eraseHighlight?: Array<{ edge: number; axis: "v" | "h"; offset: number }>;
  /**
   * Eraser deletion HIGHLIGHTS for floor plates: the model-Y elevations of all
   * floor plates currently targeted for deletion (hover + drag accumulated).
   * Drawn full-width in the deletion colour on top of normal floor-plate rendering.
   */
  eraseFloorPlates?: number[];
  /**
   * OVERVIEW-ONLY opt-in. NORMAL (shape) branch: when true, draw ONLY the
   * perimeter outline (fill + stroke) and SKIP every transient/edit overlay —
   * vertex dots, the single-edge highlight, Bézier handles, the rubber-band, and
   * the insert-preview marker. Default false/undefined (the MAIN canvas never sets
   * it, so its rendering is unchanged); the OverviewMap sets it true so the
   * navigator shows just the shape.
   */
  outlineOnly?: boolean;
  /**
   * OVERVIEW-ONLY opt-in. UNRAVEL branch: when true, draw ONLY each panel's
   * RECTANGLE BOUNDARY (outline + light fill) and SKIP the dimension labels, the
   * cell-split lines, the user division mullions, the divide preview, and the
   * hover/selected/top-resize emphasis. Floor plates are also suppressed. Default
   * false/undefined (the MAIN canvas never sets it, so its rendering is unchanged);
   * the OverviewMap sets it true for a clean boundaries-only strip.
   */
  unravelBoundariesOnly?: boolean;
  /**
   * CLEAN view (the "View" button's Clean mode). When true the UNRAVEL panels render
   * as a clean presentation: each panel is filled opaque WHITE behind the framing. NO
   * view auto-hides floor lines, centerlines, framing, OR dimensions — those four follow
   * ONLY their per-button visibility toggles (floorPlatesHidden / centerlinesHidden /
   * framingHidden / dimensionsHidden). Default false/undefined (renders normally).
   */
  cellClean?: boolean;
  /**
   * SHADOWS view (the "View" button's Shadows mode). A 2.5D presentation: it renders
   * the same clean white glass as CLEAN (floor lines / centerlines / framing / dimensions
   * follow their visibility toggles, never the view), and ADDITIONALLY
   * treats every framing bar (Stick mullions + Unitized cell framing) as
   * a member raised above the glass that casts a crisp, hard-edged drop shadow onto the
   * glass beside it. The shadow falls on the glass on both sides of a bar (into cells and
   * across into neighbours) but never on the frame infill itself. Default false/undefined.
   */
  cellShadows?: boolean;
  /**
   * Floor Lines "Hide" (the Floor Lines button's visibility-toggle icon). When true, the
   * floor lines (and their elevation labels / eraser highlights) are NOT drawn — they are
   * only hidden from view, not deleted. Default false/undefined (floor lines drawn normally).
   */
  floorPlatesHidden?: boolean;
  /**
   * Centerlines visibility-toggle icon (on the Centerlines button). When true the
   * centerlines — equal-cell splits, vertical divisions, and horizontal dividers — are
   * NOT drawn (kept in the model, just hidden). Default false/undefined (drawn normally).
   */
  centerlinesHidden?: boolean;
  /**
   * Framing visibility-toggle icon (on the Framing button). When true every framing
   * face — Stick mullion bands (mullionV / mullionH) and Unitized per-cell frame faces
   * (cellFraming) — is NOT drawn (kept in the model, just hidden). Default false.
   */
  framingHidden?: boolean;
  /**
   * Dim visibility-toggle (the Dim button + its eye icon). When true the on-canvas
   * DIMENSION labels — the per-panel overall-width label, the Panels-phase per-column /
   * per-row dimensions, and the Assembly-phase focused-cell four-side dimensions — are
   * NOT drawn. This is the SINGLE source of truth for dimension visibility: the Clean /
   * Shadows views no longer auto-hide dimensions. Default false (dimensions drawn).
   */
  dimensionsHidden?: boolean;
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
    segment: cssVar(canvas, "--segment-color", "#1f6feb"),
    segmentClosed: cssVar(canvas, "--segment-closed-color", "#1f9d6b"),
    rubber: cssVar(canvas, "--rubberband-color", "#c2700a"),
    fill: cssVar(canvas, "--polygon-fill", "rgba(31,157,107,0.10)"),
    vertex: cssVar(canvas, "--vertex-color", "#3a4754"),
    vertexHover: cssVar(canvas, "--vertex-hover-color", "#c2700a"),
    vertexSelected: cssVar(canvas, "--vertex-selected-color", "#d23154"),
    vertexErase: cssVar(canvas, "--vertex-erase-color", "#d23154"),
    vertexFirst: cssVar(canvas, "--vertex-first-color", "#1f9d6b"),
    insert: cssVar(canvas, "--insert-preview-color", "#c2700a"),
    handleLine: cssVar(canvas, "--handle-line-color", "#8492a0"),
    handleKnob: cssVar(canvas, "--handle-knob-color", "#1f6feb"),
    unravelLine: cssVar(canvas, "--unravel-line-color", "#1f6feb"),
    unravelCurve: cssVar(canvas, "--unravel-curve-color", "#c2700a"),
    unravelCell: cssVar(canvas, "--unravel-cell-color", "#8492a0"),
    // Subtractive panel-division preview (faint ghost line before commit).
    unravelDividePreview: cssVar(canvas, "--unravel-divide-preview-color", "rgba(31,111,235,0.45)"),
    // Eraser deletion highlight (the division line a click will delete).
    unravelEraseHighlight: cssVar(canvas, "--unravel-erase-highlight-color", "#d23154"),
    unravelEraseHighlightW: cssNum(canvas, "--unravel-erase-highlight-width", 3),
    unravelRectFill: cssVar(canvas, "--unravel-rect-fill", "rgba(31,111,235,0.10)"),
    unravelHighlightFill: cssVar(canvas, "--unravel-highlight-fill", "rgba(210,49,84,0.18)"),
    // CLEAN view: opaque white fill behind the framing (the glass area reads white,
    // with centerlines / floor plates / dimensions hidden — see the "View" Clean mode).
    unravelCleanFill: cssVar(canvas, "--unravel-clean-fill", "#ffffff"),
    // SHADOWS view: hard-edged drop-shadow colour + the framing member "depth" in FEET
    // that sets the shadow's offset (model-space, so it scales with zoom for a 2.5D look).
    frameShadow: cssVar(canvas, "--frame-shadow-color", "rgba(17,22,28,0.30)"),
    frameShadowDepth: cssNum(canvas, "--frame-shadow-depth", 0.4),
    // SHADOWS view is MONOCHROME: the panel outlines and framing faces drop their
    // blue/teal/orange tints for neutral greys (hover highlights stay coloured).
    frameMonoOutline: cssVar(canvas, "--frame-mono-outline", "#4a4a4a"),
    frameMonoFrame: cssVar(canvas, "--frame-mono-frame", "#6e6e6e"),
    // Per-cell hover tint (Panels phase): a single grid cell lit under the cursor.
    unravelCellHighlightFill: cssVar(canvas, "--unravel-cell-highlight-fill", "rgba(31,111,235,0.18)"),
    // Cell SELECTION (Wall Border phase, Type tool): the blue tint drawn on each cell the
    // user has selected for type assignment. Matches the hover highlight (no outline) — the
    // fill alone marks the selection.
    unravelCellSelectFill: cssVar(canvas, "--unravel-cell-select-fill", "rgba(31,111,235,0.18)"),
    // Assembly phase: red stroke for the focused cell's hovered top/right/bottom/left edge.
    unravelEdgeSelect: cssVar(canvas, "--unravel-edge-select", "#e5484d"),
    // Material-ID cell view: HSL saturation / lightness (%) and fill alpha for the
    // procedurally-hued per-cell shape tint (hue itself is golden-angle generated).
    // shadeFalloff is the FRACTION of saturation removed across a shape group, so
    // identical cells fan from full saturation down to (1 - falloff) of it.
    cellViewSat: cssNum(canvas, "--cellview-saturation", 100),
    cellViewLight: cssNum(canvas, "--cellview-lightness", 50),
    cellViewAlpha: cssNum(canvas, "--cellview-fill-alpha", 1),
    cellViewShadeFalloff: cssNum(canvas, "--cellview-shade-falloff", 0.5),
    // Orientation heatmap: a Grasshopper-style multi-stop ramp sampled by each cell's
    // heat scalar t (0 = north/cool → 1 = west/warm). Stops run dark blue → blue →
    // yellow → orange; the fill alpha + centred cardinal label colour are separate.
    orientStops: [
      parseHexRGB(cssVar(canvas, "--orient-stop-0", "#0b3bd6")),
      parseHexRGB(cssVar(canvas, "--orient-stop-1", "#16b9e8")),
      parseHexRGB(cssVar(canvas, "--orient-stop-2", "#ffd60a")),
      parseHexRGB(cssVar(canvas, "--orient-stop-3", "#ff2d1c")),
    ],
    orientAlpha: cssNum(canvas, "--orient-fill-alpha", 1),
    // PER-CELL TYPE hatch (Type tool): a SINGLE hatch stroke colour (the default cell blue)
    // shared by every type — the type is conveyed only by the hatch PATTERN, never colour —
    // plus the hatch line WIDTH and SPACING (screen px). Vision is a sparse single-direction
    // hatch, Spandrel the opposite diagonal, Opaque a dense cross-hatch.
    cellTypeHatch: cssVar(canvas, "--celltype-hatch-color", "rgba(31,111,235,0.55)"),
    // MONOCHROME variant of the type hatch — used in the SHADOWS view, which is fully
    // greyscale (no colours). Same weight, neutral grey instead of the cell blue.
    cellTypeHatchMono: cssVar(canvas, "--celltype-hatch-color-mono", "rgba(70,70,70,0.55)"),
    cellTypeHatchW: cssNum(canvas, "--celltype-hatch-width", 1),
    cellTypeHatchGap: cssNum(canvas, "--celltype-hatch-gap", 8),
    // Mullions tool: the paired mullion-face lines drawn ±offset around each grid line.
    unravelMullion: cssVar(canvas, "--unravel-mullion-color", "#5b94a8"),
    highlight: cssVar(canvas, "--unravel-highlight-color", "#d23154"),
    // Export marquee selection: the highlight fill/stroke for selected panels and the
    // dashed rubber-band rectangle while dragging out a selection.
    exportSelectFill: cssVar(canvas, "--export-select-fill", "rgba(31,157,107,0.22)"),
    exportSelectStroke: cssVar(canvas, "--export-select-stroke", "#1f9d6b"),
    exportSelectW: cssNum(canvas, "--export-select-width", 2.5),
    marqueeFill: cssVar(canvas, "--export-marquee-fill", "rgba(31,157,107,0.10)"),
    marqueeStroke: cssVar(canvas, "--export-marquee-stroke", "#1f9d6b"),
    marqueeW: cssNum(canvas, "--export-marquee-width", 1.5),
    marqueeDash: cssNum(canvas, "--export-marquee-dash", 5),
    vertexR: cssNum(canvas, "--vertex-radius", 4),
    handleR: cssNum(canvas, "--handle-radius", 3.5),
    segmentW: cssNum(canvas, "--segment-width", 1.5),
    highlightW: cssNum(canvas, "--highlight-width", 3),
    unravelTopW: cssNum(canvas, "--unravel-top-width", 4),
    // Half-length (px) of the end ticks on the Subtractive live spacing dimension.
    unravelDimTick: cssNum(canvas, "--unravel-dim-tick", 4),
    // Thin affordance strokes (insert-preview ring + "＋", first-vertex close ring)
    // and the Bézier handle leader line — kept as tokens so even these minor stroke
    // widths are tunable from styles.css (single source of truth).
    affordanceW: cssNum(canvas, "--affordance-width", 1.5),
    handleLineW: cssNum(canvas, "--handle-line-width", 1),
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

  // NOTE: the grid is intentionally NEVER drawn. `gridSpacing` still drives
  // snapping in the input layer, but there is no grid-display path here.

  // UNRAVEL VIEW: draw the unrolled edge rectangles instead of the shape.
  if (state.unravel && state.unravel.length > 0) {
    drawUnravel(
      ctx,
      canvas,
      state.viewport,
      state.unravel,
      state.hoveredUnravelEdge ?? -1,
      state.hoveredUnravelTop ?? -1,
      state.selectedUnravelPanel ?? -1,
      state.cellDimEdge ?? -1,
      state.hoveredCell ?? null,
      state.selectedCells ?? null,
      state.dividePreview ?? null,
      state.eraseHighlight ?? [],
      state.focusedCellDims ?? null,
      state.focusedCellEdge ?? null,
      state.unravelBoundariesOnly ?? false,
      state.cellClean ?? false,
      state.cellShadows ?? false,
      state.centerlinesHidden ?? false,
      state.framingHidden ?? false,
      state.dimensionsHidden ?? false,
      state.exportSelection ?? null,
      tk,
    );
    // Live export-selection MARQUEE (dashed rubber-band) — drawn right after the panels
    // so it shows in every unravel sub-view, including the boundaries-only overview that
    // returns just below. The selected-panel highlight itself is drawn inside drawUnravel.
    if (state.marquee) drawMarquee(ctx, state.viewport, state.marquee, tk);
    // OVERVIEW boundaries-only mode draws nothing but the panel rectangles — no
    // floor plates (they are an elevation overlay, not a panel boundary).
    if (state.unravelBoundariesOnly) return;
    // Floor-line visibility is controlled SOLELY by the Floor Lines submenu's Show / Hide
    // (state.floorPlatesHidden) — the CLEAN and SHADOWS presentation views do NOT auto-hide
    // them. "Hide" suppresses drawing floor lines (kept in the model, just not shown).
    // Nothing else is drawn after, so return.
    if (state.floorPlatesHidden) return;
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
    // Floor-plate eraser highlights: redraw each targeted plate full-width in the
    // deletion colour so the user sees exactly what a release will remove.
    if (state.eraseFloorPlates?.length) {
      ctx.strokeStyle = tk.unravelEraseHighlight;
      ctx.lineWidth = tk.unravelEraseHighlightW;
      ctx.setLineDash([]);
      for (const y of state.eraseFloorPlates) {
        const sy = toScreen(state.viewport, { x: 0, y }).y;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
        ctx.stroke();
      }
    }
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

  // OVERVIEW outline-only mode: the navigator shows JUST the shape (fill +
  // stroke above), so stop before any vertex dots or transient edit overlays.
  if (state.outlineOnly) return;

  // Single-edge highlight (mini-window hover-link): re-draw one edge on top of
  // the normal stroke in the highlight colour/width. Reuses the same line/curve
  // tracing as the perimeter path so curves are honoured.
  if (state.highlightEdge !== undefined && state.highlightEdge >= 0) {
    drawHighlightEdge(ctx, state.viewport, state.perimeter, state.highlightEdge, tk);
  }

  // Erase tool: every edge the cursor is targeting (hover + drag-collected), re-drawn
  // in the delete colour so they read as "click / release to remove these segments"
  // (the loop reopens at each gap; orphaned vertices, drawn red below, drop with them).
  if (state.eraseEdges) {
    for (const ei of state.eraseEdges) {
      if (ei >= 0) {
        drawHighlightEdge(ctx, state.viewport, state.perimeter, ei, {
          highlight: tk.vertexErase,
          highlightW: tk.highlightW,
        });
      }
    }
  }

  // Bézier handles for the selected/active vertex (lines + knobs).
  if (state.handleVertex >= 0 && state.handleVertex < v.length) {
    drawHandles(ctx, state.viewport, v[state.handleVertex], tk);
  }

  // Rubber-band: last vertex -> cursor, with live length/angle label. While a
  // dimension is being typed, the band ends at the typed length along the cursor
  // direction (dimPreview) and the label shows the raw typed string, accented.
  if (state.rubberBand && state.cursorModel && v.length >= 1) {
    const last = v[v.length - 1];
    const dimming = state.dimText != null && state.dimText !== "";
    const end = state.dimPreview ?? state.cursorModel;
    const a = toScreen(state.viewport, last);
    const b = toScreen(state.viewport, end);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = tk.rubber;
    ctx.lineWidth = tk.segmentW;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    drawSegmentLabel(
      ctx,
      canvas,
      a,
      b,
      distance(last, end),
      angleDeg(last, end),
      dimming ? state.dimText! : undefined,
    );
  }

  // Insertion preview marker (edit mode).
  if (state.insertPreview) {
    const s = toScreen(state.viewport, state.insertPreview);
    ctx.beginPath();
    ctx.arc(s.x, s.y, tk.vertexR + 1, 0, Math.PI * 2);
    ctx.strokeStyle = tk.insert;
    ctx.lineWidth = tk.affordanceW;
    ctx.stroke();
    drawPlus(ctx, s.x, s.y, tk.vertexR, tk.insert, tk.affordanceW);
  }

  // Vertices on top.
  const eraseSet = state.eraseVertices && state.eraseVertices.length > 0 ? new Set(state.eraseVertices) : null;
  v.forEach((pt, i) => {
    const s = toScreen(state.viewport, pt);
    let color = tk.vertex;
    if (i === 0 && !state.perimeter.closed && state.drawing) color = tk.vertexFirst;
    // While the Erase tool is armed, the hovered vertex signals deletion (red);
    // otherwise it uses the normal warm hover colour.
    if (i === state.hoveredVertex) color = state.eraseVertexArmed ? tk.vertexErase : tk.vertexHover;
    // Vertices collected during an Erase drag stroke are all flagged for deletion.
    if (eraseSet?.has(i)) color = tk.vertexErase;
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
      ctx.lineWidth = tk.affordanceW;
      ctx.stroke();
    }
  });

  // Floor plates are an ELEVATION concept (levels above the ground-floor datum),
  // so they are intentionally drawn ONLY in the unravel view (handled in the
  // unravel branch above). The normal draw-perimeter view is a plan/footprint
  // view with no meaningful height datum, so no floor-plate lines are shown here.
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
  // model-Y elevation in FEET (prime mark, matching the panel dimension labels).
  // Markers use the SAME fainter grey as their dotted lines: placed plates take
  // the solid floor-plate colour, the preview takes the ghost colour.
  if (plates) for (const y of plates) {
    drawRightAlignedLabel(ctx, canvas, rightX, toScreen(vp, { x: leftModelX, y }).y, fmtLengthTick(y), tk.floorPlate);
  }
  if (preview != null) {
    drawRightAlignedLabel(ctx, canvas, rightX, toScreen(vp, { x: leftModelX, y: preview }).y, fmtLengthTick(preview), tk.floorPlateGhost);
  }
}

function drawSegmentLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  a: Point,
  b: Point,
  length: number,
  angle: number,
  // When set, the length portion shows this raw string (with the active unit tick)
  // instead of the formatted measurement, and the label is drawn ACCENTED — used for
  // the live Revit-style typed-dimension entry so it reads as an active input. The raw
  // string is what the user TYPED (already in the active display unit), so it just gets
  // the active tick (′ for feet, m for metric) appended.
  lengthOverride?: string,
): void {
  const lenStr = lengthOverride != null ? `${lengthOverride}${lengthTick()}` : fmtLengthTick(length);
  const text = `${lenStr}  ∠${angle.toFixed(1)}°`;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const accent = lengthOverride != null;
  const fg = accent
    ? cssVar(canvas, "--dim-input-text", "#ffffff")
    : cssVar(canvas, "--label-text", "#1c2530");
  const bgc = accent
    ? cssVar(canvas, "--dim-input-bg", "rgba(36,110,234,0.92)")
    : cssVar(canvas, "--label-bg", "rgba(255,255,255,0.88)");
  ctx.font = cssVar(canvas, "--label-font", "12px ui-monospace, monospace");
  const padding = 4;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = bgc;
  ctx.fillRect(midX + 8, midY - 18, w + padding * 2, 18);
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, midX + 8 + padding, midY - 9);
}

function drawPlus(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, lineWidth: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
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
/**
 * Draw the live export-selection MARQUEE: a dashed rubber-band rectangle between
 * the two drag corners (given in MODEL space, converted to screen here so it pans/
 * zooms with the strip). Faint fill + dashed export-selection stroke so it reads as
 * a transient selection box over the unravel rectangles.
 */
function drawMarquee(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  rect: { x0: number; y0: number; x1: number; y1: number },
  tk: { marqueeFill: string; marqueeStroke: string; marqueeW: number; marqueeDash: number },
): void {
  const a = toScreen(vp, { x: rect.x0, y: rect.y0 });
  const b = toScreen(vp, { x: rect.x1, y: rect.y1 });
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  ctx.fillStyle = tk.marqueeFill;
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.strokeStyle = tk.marqueeStroke;
  ctx.lineWidth = tk.marqueeW;
  ctx.setLineDash([tk.marqueeDash, tk.marqueeDash]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawUnravel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  vp: Viewport,
  draws: UnravelDraw[],
  hoveredEdge: number,
  hoveredTop: number,
  selectedEdge: number,
  /** PANELS phase: edge index of the focused panel to dimension per column/row, or -1. */
  cellDimEdge: number,
  hoveredCell: { x0: number; x1: number; y0: number; y1: number } | null,
  /** WALL BORDER phase: cells SELECTED for type assignment (each tagged with its edge). */
  selectedCells: Array<{ edge: number; x0: number; x1: number; y0: number; y1: number }> | null,
  dividePreview: {
    edge: number;
    xs?: number[];
    ys?: number[];
    dim?: { x1: number; y1: number; x2: number; y2: number; dist: number } | null;
  } | null,
  eraseHighlight: Array<{ edge: number; axis: "v" | "h"; offset: number }>,
  /** ASSEMBLY phase: model rect of the SELECTED cell to dimension on all 4 edges, or null. */
  focusedCellDims: { x0: number; x1: number; y0: number; y1: number } | null,
  /** ASSEMBLY phase: which edge of the focused cell to stroke red (hovered), or null. */
  focusedCellEdge: "top" | "right" | "bottom" | "left" | null,
  boundariesOnly: boolean,
  /** CLEAN view: white panel fill only (centerlines / framing / floor lines / dimensions
   *  follow their visibility toggles, not the view). */
  clean: boolean,
  /** SHADOWS view: like CLEAN, plus raised-frame hard drop shadows on the glass. */
  shadows: boolean,
  /** Centerlines visibility-toggle icon: when true, all centerlines are suppressed. */
  centerlinesHidden: boolean,
  /** Framing visibility-toggle icon: when true, all framing faces are suppressed. */
  framingHidden: boolean,
  /** Dim visibility-toggle: when true, all dimension labels are suppressed (no view auto-hides them). */
  dimensionsHidden: boolean,
  /** Export marquee: set of selected ORIGINAL edge indices to draw in the export-selection colours, or null. */
  exportSelection: ReadonlySet<number> | null,
  tk: {
    unravelLine: string;
    unravelCurve: string;
    unravelCell: string;
    unravelDividePreview: string;
    unravelEraseHighlight: string;
    unravelEraseHighlightW: number;
    unravelRectFill: string;
    unravelHighlightFill: string;
    unravelCleanFill: string;
    frameShadow: string;
    frameShadowDepth: number;
    frameMonoOutline: string;
    frameMonoFrame: string;
    unravelCellHighlightFill: string;
    unravelCellSelectFill: string;
    unravelEdgeSelect: string;
    cellViewSat: number;
    cellViewLight: number;
    cellViewAlpha: number;
    cellViewShadeFalloff: number;
    orientStops: RGB[];
    orientAlpha: number;
    cellTypeHatch: string;
    cellTypeHatchMono: string;
    cellTypeHatchW: number;
    cellTypeHatchGap: number;
    unravelMullion: string;
    highlight: string;
    exportSelectFill: string;
    exportSelectStroke: string;
    exportSelectW: number;
    segmentW: number;
    highlightW: number;
    unravelTopW: number;
    unravelDimTick: number;
    unravelLabelGap: number;
    floorPlate: string;
  },
): void {
  for (const { seg, height, cells, divisions, dividersH, mullionV, mullionH, mullionHoverAxis, cellFraming, frameHover, cellColors, cellOrient, cellTypes, opaqueCells } of draws) {
    // Guard against a non-positive height so the rectangle always has visible area.
    const h = Math.max(height, 0);
    // Rectangle corners: baseline (y=0) to top (y=height), spanning x0..x1.
    const baseL = toScreen(vp, { x: seg.x0, y: 0 });
    const baseR = toScreen(vp, { x: seg.x1, y: 0 });
    const topL = toScreen(vp, { x: seg.x0, y: h });
    // In OVERVIEW boundaries-only mode hover/selection emphasis is suppressed.
    const hovered = !boundariesOnly && seg.index === hoveredEdge;
    // Export marquee selection: drawn in the distinct export-selection colours. Hover
    // still wins visually (it's the transient pointer feedback) so the two never fight.
    const isSelected = !boundariesOnly && !!exportSelection && exportSelection.has(seg.index);

    // Screen-space rectangle (model +Y up flips to screen -Y, so topL.y < baseL.y).
    const x = baseL.x;
    const y = topL.y;
    const w = baseR.x - baseL.x;
    const rectH = baseL.y - topL.y;

    // PRESENTATION views (CLEAN and SHADOWS) share the same base: white glass. They do
    // NOT hide floor lines / centerlines / framing / dimensions — all four follow only
    // their per-button visibility toggles. `presentation` now only drives the WHITE panel
    // fill and the framing render STYLE (mitered insets / face breaks). SHADOWS layers
    // raised-frame drop shadows on top of that clean base.
    const presentation = clean || shadows;

    // Fill. PRESENTATION views fill the panel opaque WHITE (the glass behind the framing);
    // otherwise hover, then export-selection, then the translucent panel tint.
    ctx.fillStyle = presentation
      ? tk.unravelCleanFill
      : hovered
        ? tk.unravelHighlightFill
        : isSelected
          ? tk.exportSelectFill
          : tk.unravelRectFill;
    ctx.fillRect(x, y, w, rectH);

    // MATERIAL-ID view: tint each grid cell by its SHAPE colour. Drawn over the base
    // panel fill but UNDER the per-cell hover tint, outline and grid lines below, so
    // the centerlines/borders stay crisp on top of the colour blocks. The hue is
    // golden-angle generated from the cell's shape index; saturation/lightness/alpha
    // come from CSS tokens. Even in OVERVIEW boundaries-only mode this stays useful,
    // so it runs before the boundariesOnly short-circuit further down.
    if (cellColors && cellColors.length > 0) {
      for (const cc of cellColors) {
        const c0 = toScreen(vp, { x: cc.x0, y: cc.y0 });
        const c1 = toScreen(vp, { x: cc.x1, y: cc.y1 });
        const hue = (cc.colorIndex * CELL_VIEW_GOLDEN_ANGLE) % 360;
        // Taper saturation across the cell's shade fraction so identical cells (same
        // hue/number) fan from full saturation down to (1 - falloff) of it.
        const sat = tk.cellViewSat * (1 - tk.cellViewShadeFalloff * (cc.shade ?? 0));
        ctx.fillStyle = `hsla(${hue}, ${sat}%, ${tk.cellViewLight}%, ${tk.cellViewAlpha})`;
        ctx.fillRect(
          Math.min(c0.x, c1.x),
          Math.min(c0.y, c1.y),
          Math.abs(c1.x - c0.x),
          Math.abs(c1.y - c0.y),
        );
      }
    }

    // ORIENTATION HEATMAP fill: tint each cell by its facing-direction heat scalar
    // (t = 0 cool/blue/north → 1 warm/red/west), interpolating the CSS hue endpoints.
    // Same layering as the Material-ID fill (under the grid lines); the cardinal
    // LABELS are drawn later (on top of the grid) near the end of this panel's block.
    if (cellOrient && cellOrient.length > 0) {
      for (const co of cellOrient) {
        const c0 = toScreen(vp, { x: co.x0, y: co.y0 });
        const c1 = toScreen(vp, { x: co.x1, y: co.y1 });
        ctx.fillStyle = sampleRamp(tk.orientStops, co.t, tk.orientAlpha);
        ctx.fillRect(
          Math.min(c0.x, c1.x),
          Math.min(c0.y, c1.y),
          Math.abs(c1.x - c0.x),
          Math.abs(c1.y - c0.y),
        );
      }
    }

    // PER-CELL TYPE hatch (Type tool): overlay each typed cell's GLASS-INFILL rect (the cell
    // minus its extruded frame members) with a pattern that signifies its glazing type —
    // Vision a sparse "/" diagonal, Spandrel a "/"+"\" cross-hatch, Opaque a dot matrix.
    // Clipping to the glass rect keeps the pattern off the framing (frame = the non-glazed
    // area). Drawn over any fill but UNDER the grid lines / outline below so the framing
    // stays crisp, and in EVERY view (it's facade spec, not a view mode).
    if (cellTypes && cellTypes.length > 0) {
      for (const ct of cellTypes) {
        const c0 = toScreen(vp, { x: ct.x0, y: ct.y0 });
        const c1 = toScreen(vp, { x: ct.x1, y: ct.y1 });
        const rx = Math.min(c0.x, c1.x);
        const ry = Math.min(c0.y, c1.y);
        const rw = Math.abs(c1.x - c0.x);
        const rh = Math.abs(c1.y - c0.y);
        if (rw < 1 || rh < 1) continue;
        // One shared colour for every type — the type is told apart by PATTERN only.
        // The SHADOWS view is fully monochrome, so the hatch drops its blue for neutral grey.
        const color = shadows ? tk.cellTypeHatchMono : tk.cellTypeHatch;
        const gap = tk.cellTypeHatchGap;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        if (ct.type === "opaque") {
          // Opaque: a regular MATRIX OF DOTS. Dot radius scales with the line width so it
          // reads at the same weight as the other patterns.
          const r = Math.max(0.75, tk.cellTypeHatchW * 1.1);
          ctx.fillStyle = color;
          for (let y = ry + gap / 2; y <= ry + rh; y += gap) {
            for (let x = rx + gap / 2; x <= rx + rw; x += gap) {
              ctx.beginPath();
              ctx.arc(x, y, r, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = tk.cellTypeHatchW;
          ctx.beginPath();
          // Vision is a SINGLE-direction hatch, so it's spaced wider than Spandrel's cross-
          // hatch — fewer lines so it reads lighter than the denser Spandrel pattern.
          const lineGap = ct.type === "vision" ? gap * 1.7 : gap;
          // "/" diagonals (Vision + Spandrel): sweep the line's x-intercept across the rect
          // so a 45° line covers the whole clipped area.
          for (let x = rx - rh; x <= rx + rw; x += lineGap) {
            ctx.moveTo(x, ry + rh);
            ctx.lineTo(x + rh, ry);
          }
          // "\" diagonals — Spandrel only, completing the cross-hatch.
          if (ct.type === "spandrel") {
            for (let x = rx; x <= rx + rw + rh; x += gap) {
              ctx.moveTo(x, ry);
              ctx.lineTo(x - rh, ry + rh);
            }
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // PANELS-phase per-cell hover: tint the single grid cell under the cursor (its
    // model rect belongs to the SELECTED/focused panel). Drawn over the panel fill
    // but UNDER the outline + division mullions below, so the grid lines bounding
    // the cell stay crisp. Suppressed in boundaries-only (overview) mode.
    // Skip the hover tint when the hovered cell is ALSO selected: the selection fill (drawn
    // just below) is identical, so painting both would darken the cell — selecting a cell
    // must not make its blue any heavier than the hover.
    const hoverIsSelected =
      !!hoveredCell &&
      !!selectedCells &&
      selectedCells.some(
        (sc) =>
          sc.edge === seg.index &&
          Math.abs(sc.x0 - hoveredCell.x0) < 1e-6 &&
          Math.abs(sc.y0 - hoveredCell.y0) < 1e-6 &&
          Math.abs(sc.x1 - hoveredCell.x1) < 1e-6 &&
          Math.abs(sc.y1 - hoveredCell.y1) < 1e-6,
      );
    if (!boundariesOnly && hoveredCell && seg.index === selectedEdge && !hoverIsSelected) {
      const c0 = toScreen(vp, { x: hoveredCell.x0, y: hoveredCell.y0 });
      const c1 = toScreen(vp, { x: hoveredCell.x1, y: hoveredCell.y1 });
      ctx.fillStyle = tk.unravelCellHighlightFill;
      ctx.fillRect(Math.min(c0.x, c1.x), Math.min(c0.y, c1.y), Math.abs(c1.x - c0.x), Math.abs(c1.y - c0.y));
    }

    // CELL SELECTION (Wall Border phase, Type tool): tint every selected cell belonging to
    // THIS panel with the same blue HIGHLIGHT as the hover (no outline — the fill alone marks
    // the selection). Project-wide Shift selections list cells across panels, so each is
    // matched to its owning edge here. Suppressed in boundaries-only overview.
    if (!boundariesOnly && selectedCells && selectedCells.length > 0) {
      for (const sc of selectedCells) {
        if (sc.edge !== seg.index) continue;
        const c0 = toScreen(vp, { x: sc.x0, y: sc.y0 });
        const c1 = toScreen(vp, { x: sc.x1, y: sc.y1 });
        const sx = Math.min(c0.x, c1.x);
        const sy = Math.min(c0.y, c1.y);
        const sw = Math.abs(c1.x - c0.x);
        const sh = Math.abs(c1.y - c0.y);
        // SHADOWS view is fully monochrome, so the selection drops its blue for neutral grey.
        ctx.fillStyle = shadows ? tk.frameShadow : tk.unravelCellSelectFill;
        ctx.fillRect(sx, sy, sw, sh);
      }
    }

    // Outline. Hovered rect uses the highlight colour + thicker stroke; a selected
    // (but not hovered) rect uses the export-selection stroke; curved edges are dashed
    // regardless so their arc-length origin stays distinguishable.
    ctx.beginPath();
    ctx.rect(x, y, w, rectH);
    ctx.strokeStyle = hovered
      ? tk.highlight
      : isSelected
        ? tk.exportSelectStroke
        : shadows
          ? tk.frameMonoOutline
          : seg.curved
            ? tk.unravelCurve
            : tk.unravelLine;
    ctx.lineWidth = hovered ? tk.highlightW : isSelected ? tk.exportSelectW : tk.segmentW;
    if (seg.curved) ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // OVERVIEW boundaries-only: the rectangle outline (+ fill) IS the whole panel
    // here — skip the dimension label, cell/division mullions, divide preview, and
    // hover/selected/top-resize emphasis below.
    if (boundariesOnly) continue;

    // CENTERLINES (the grid lines created by the Centerlines tool + cell splits) are
    // drawn with a long-dash–dot pattern so they read as drafting CENTERLINES, visually
    // distinct from the SOLID framing (mullion) faces drawn afterwards. The dash is set
    // here and reset to solid right after the horizontal dividers, before the framing.
    ctx.setLineDash([9, 4, 1.5, 4]);

    // Centerline stroke colour: neutral grey in the MONOCHROME Shadows view, otherwise the
    // normal slate cell colour. (Shared by the equal-split, division, and divider lines below.)
    const centerlineStroke = shadows ? tk.frameMonoFrame : tk.unravelCell;

    // Cell splits: N-1 equal-width vertical division lines inside the rectangle.
    // Centerline visibility is controlled ONLY by the Centerlines eye icon
    // (centerlinesHidden) — NO view (Clean / Shadows included) auto-hides them.
    const nCells = Math.max(1, Math.round(cells));
    if (!centerlinesHidden && nCells > 1) {
      ctx.strokeStyle = centerlineStroke;
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

    // User-placed division lines (Centerlines tool): dashed centerlines at each stored
    // OFFSET from the panel's left edge, baseline → top. Drawn in the cell colour.
    if (!centerlinesHidden && divisions && divisions.length > 0) {
      ctx.strokeStyle = centerlineStroke;
      ctx.lineWidth = tk.segmentW;
      for (const off of divisions) {
        const mx = seg.x0 + off;
        const a = toScreen(vp, { x: mx, y: 0 });
        const b = toScreen(vp, { x: mx, y: h });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // User-placed HORIZONTAL dividers (Centerlines tool + Shift): dashed centerlines at
    // each stored OFFSET from the panel's baseline (y = 0), spanning x0 → x1. Same cell
    // colour/width as the vertical divisions, just rotated 90°.
    if (!centerlinesHidden && dividersH && dividersH.length > 0) {
      ctx.strokeStyle = centerlineStroke;
      ctx.lineWidth = tk.segmentW;
      for (const off of dividersH) {
        if (off <= 0 || off >= h) continue; // outside the panel body
        const a = toScreen(vp, { x: seg.x0, y: off });
        const b = toScreen(vp, { x: seg.x1, y: off });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    // Centerlines done — back to SOLID so the framing faces (and everything below)
    // are not dashed.
    ctx.setLineDash([]);

    // MULLIONS (Stick system): each grid line carries a mullion of some width, drawn
    // as a PAIR of lines offset to EITHER SIDE of the centre line (±mullion offset).
    // The vertical offset (mullionV) applies to every vertical grid line of this panel
    // (equal-cell splits + Subtractive divisions); the horizontal offset (mullionH) to
    // every horizontal divider. A single per-axis offset means "all lines adjust the
    // same". When the Mullions tool is hovering an axis, those centre lines are also
    // re-stroked in the highlight colour so the user sees the set that will move together.
    const lo = Math.min(seg.x0, seg.x1);
    const hi = Math.max(seg.x0, seg.x1);
    // Interior vertical grid-line x positions (model): equal splits + divisions.
    const gridXs: number[] = [];
    for (let k = 1; k < nCells; k++) gridXs.push(seg.x0 + (seg.x1 - seg.x0) * (k / nCells));
    for (const off of divisions ?? []) gridXs.push(seg.x0 + off);
    // Interior horizontal grid-line y positions (model): Subtractive dividers.
    const gridYs: number[] = [];
    for (const off of dividersH ?? []) if (off > 0 && off < h) gridYs.push(off);

    const mv = mullionV ?? 0;
    const mh = mullionH ?? 0;
    // Framing-face stroke colour: neutral grey in the MONOCHROME Shadows view, otherwise
    // the normal framing tint. (Hover highlights below still use the coloured tokens.)
    const frameStroke = shadows ? tk.frameMonoFrame : tk.unravelMullion;

    // SHADOWS view: render every framing BAR as a member raised above the glass that
    // casts a crisp, hard-edged CAST shadow. We collect each bar as a model-space rect
    // (Stick mullion bands + Unitized cell-framing borders), then (1) clip to the panel,
    // (2) fill each bar's SWEPT silhouette — the convex hull of the bar and its copy
    // offset by the member "depth" (model-space, so it scales with zoom) — in the shadow
    // colour, and (3) repaint the bars themselves opaque white. The swept hull keeps the
    // shadow ATTACHED to the bar's edges with a diagonal outer edge (the cast-shadow
    // angle), so even a THIN frame has a connected shadow with no floating gap. The shadow
    // lands on the glass on BOTH sides of a bar (into cells and across into neighbours) but
    // NEVER on the frame infill. Drawn here, BEFORE the frame faces below, so those crisp
    // lines sit on top. Bar geometry matches the framing drawn later (Stick ±offset bands;
    // Unitized mitered borders inset to the infill rect).
    if (shadows && !framingHidden) {
      type Rect = { x: number; y: number; w: number; h: number };
      const toRect = (mx0: number, my0: number, mx1: number, my1: number): Rect => {
        const a = toScreen(vp, { x: mx0, y: my0 });
        const b = toScreen(vp, { x: mx1, y: my1 });
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      };
      const bars: Rect[] = [];
      // Stick vertical mullion bands: [cx-mv, cx+mv] × full height.
      if (mv > 0) for (const cx of gridXs) bars.push(toRect(Math.max(lo, cx - mv), 0, Math.min(hi, cx + mv), h));
      // Stick horizontal mullion bands: full width × [cy-mh, cy+mh].
      if (mh > 0) for (const cy of gridYs) bars.push(toRect(lo, Math.max(0, cy - mh), hi, Math.min(h, cy + mh)));
      // Unitized cell framing: the mitered border of each framed edge (cell edge → infill).
      if (cellFraming) for (const fc of cellFraming) {
        const inL = fc.x0 + (fc.left > 0 ? fc.left : 0);
        const inR = fc.x1 - (fc.right > 0 ? fc.right : 0);
        const inB = fc.y0 + (fc.bottom > 0 ? fc.bottom : 0);
        const inT = fc.y1 - (fc.top > 0 ? fc.top : 0);
        if (fc.top > 0) bars.push(toRect(fc.x0, inT, fc.x1, fc.y1));
        if (fc.bottom > 0) bars.push(toRect(fc.x0, fc.y0, fc.x1, inB));
        if (fc.left > 0) bars.push(toRect(fc.x0, fc.y0, inL, fc.y1));
        if (fc.right > 0) bars.push(toRect(inR, fc.y0, fc.x1, fc.y1));
      }
      if (bars.length > 0) {
        // Cast-shadow offset (px): a model-space "depth" toward bottom-right (light from
        // the upper-left). Derived from two toScreen samples so it scales with zoom; with
        // model +Y up flipping to screen -Y, model (depth, -depth) maps to screen (+, +).
        const o0 = toScreen(vp, { x: 0, y: 0 });
        const o1 = toScreen(vp, { x: tk.frameShadowDepth, y: -tk.frameShadowDepth });
        const ox = o1.x - o0.x;
        const oy = o1.y - o0.y;
        // SWEPT hull of a bar (x0,y0)-(x1,y1) toward (+ox,+oy): the convex hull of the bar
        // and its offset copy — a hexagon sharing the bar's TOP and LEFT edges, so the
        // shadow stays attached to the bar (the part beyond the bar's right/bottom edges is
        // the visible cast shadow, bounded by a diagonal). All hulls are wound the same way
        // so a single nonzero fill paints the union once (uniform tone, no compounding).
        const addHull = (b: Rect) => {
          const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y0);
          ctx.lineTo(x1 + ox, y0 + oy);
          ctx.lineTo(x1 + ox, y1 + oy);
          ctx.lineTo(x0 + ox, y1 + oy);
          ctx.lineTo(x0, y1);
          ctx.closePath();
        };
        // Clip to the panel rect so shadows stay on this glass card, then fill ALL swept
        // hulls as a SINGLE path in ONE fill call. Filling once (nonzero winding) paints
        // each covered pixel exactly once, so overlapping shadows read as one flat tone —
        // no darker compounded sections. (No blur — hard, crisp edges.)
        // OPAQUE cells sit FLUSH with the frame, so no shadow falls on them: punch their
        // infill rects out of the clip region (even-odd → the panel rect minus those holes).
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, rectH);
        if (opaqueCells && opaqueCells.length > 0) {
          for (const oc of opaqueCells) {
            const a = toScreen(vp, { x: oc.x0, y: oc.y0 });
            const b = toScreen(vp, { x: oc.x1, y: oc.y1 });
            ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          }
        }
        ctx.clip("evenodd");
        ctx.fillStyle = tk.frameShadow;
        ctx.beginPath();
        for (const b of bars) addHull(b);
        ctx.fill();
        ctx.restore();
        // Repaint the bars opaque white — removes the hull's bar-footprint portion (so the
        // shadow only shows on glass, meeting the bar's right/bottom edges with no gap) and
        // leaves each member reading as a solid raised bar (the frame faces stroke on top).
        ctx.fillStyle = tk.unravelCleanFill;
        for (const b of bars) ctx.fillRect(b.x, b.y, b.w, b.h);
        // Frame bars run to the panel edge, so the white repaint (and the clipped shadow
        // fill) just overwrote the INNER half of the border line wherever a mullion meets
        // it — making the border read thinner there. Re-stroke the panel outline on top so
        // it stays one continuous, full-weight line. (Matches the outline stroke above.)
        ctx.beginPath();
        ctx.rect(x, y, w, rectH);
        ctx.strokeStyle = hovered ? tk.highlight : tk.frameMonoOutline;
        ctx.lineWidth = hovered ? tk.highlightW : tk.segmentW;
        if (seg.curved) ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (!framingHidden && mv > 0 && gridXs.length > 0) {
      ctx.strokeStyle = frameStroke;
      ctx.lineWidth = tk.segmentW;
      for (const cx of gridXs) {
        for (const side of [-mv, mv]) {
          const fx = Math.max(lo, Math.min(hi, cx + side)); // keep faces inside the panel
          const a = toScreen(vp, { x: fx, y: 0 });
          const b = toScreen(vp, { x: fx, y: h });
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    if (!framingHidden && mh > 0 && gridYs.length > 0) {
      ctx.strokeStyle = frameStroke;
      ctx.lineWidth = tk.segmentW;
      // CLEAN view: keep the VERTICAL mullions reading as clean continuous lines by
      // BREAKING the horizontal mullion faces around each vertical mullion BODY (the
      // [cx-mv, cx+mv] band between its paired faces). A horizontal frame then stops at
      // the vertical mullion instead of cutting through its infill. Outside Clean (or
      // with no vertical mullions) the horizontal faces span the full panel width.
      const breakV = presentation && mv > 0 && gridXs.length > 0;
      let bands: Array<[number, number]> = [];
      if (breakV) {
        const raw = gridXs
          .map((cx) => [Math.max(lo, cx - mv), Math.min(hi, cx + mv)] as [number, number])
          .filter(([s, e]) => e > s)
          .sort((a, b) => a[0] - b[0]);
        for (const band of raw) {
          const last = bands[bands.length - 1];
          if (last && band[0] <= last[1]) last[1] = Math.max(last[1], band[1]);
          else bands.push([band[0], band[1]]);
        }
      }
      const strokeX = (x1: number, x2: number, fy: number) => {
        if (x2 <= x1) return;
        const a = toScreen(vp, { x: x1, y: fy });
        const b = toScreen(vp, { x: x2, y: fy });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      };
      for (const cy of gridYs) {
        for (const side of [-mh, mh]) {
          const fy = Math.max(0, Math.min(h, cy + side));
          if (!breakV || bands.length === 0) {
            strokeX(lo, hi, fy);
            continue;
          }
          // Draw the horizontal face only in the gaps between vertical mullion bands.
          let cursor = lo;
          for (const [bs, be] of bands) {
            if (bs > cursor) strokeX(cursor, bs, fy);
            cursor = Math.max(cursor, be);
          }
          if (cursor < hi) strokeX(cursor, hi, fy);
        }
      }
    }
    // Mullions-tool hover: emphasise the centre lines of the hovered axis (they all
    // adjust together on drag), plus a live offset dimension label above the panel.
    if (mullionHoverAxis === "v" && gridXs.length > 0) {
      ctx.strokeStyle = tk.highlight;
      ctx.lineWidth = tk.highlightW;
      for (const cx of gridXs) {
        const a = toScreen(vp, { x: cx, y: 0 });
        const b = toScreen(vp, { x: cx, y: h });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      drawCenteredLabel(ctx, canvas, (baseL.x + baseR.x) / 2, topL.y - tk.unravelLabelGap, `↔ ${fmtLengthTick(mv)}`);
    } else if (mullionHoverAxis === "h" && gridYs.length > 0) {
      ctx.strokeStyle = tk.highlight;
      ctx.lineWidth = tk.highlightW;
      for (const cy of gridYs) {
        const a = toScreen(vp, { x: seg.x0, y: cy });
        const b = toScreen(vp, { x: seg.x1, y: cy });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      drawCenteredLabel(ctx, canvas, (baseL.x + baseR.x) / 2, topL.y - tk.unravelLabelGap, `↕ ${fmtLengthTick(mh)}`);
    }

    // UNITIZED per-cell FRAMING (Framing tool under the Unitized system): every cell
    // carries an inward inset on any of its four edges, drawn as a SOLID frame face
    // inset that far from the corresponding cell edge (top/bottom = horizontal faces,
    // left/right = vertical faces). Unlike the Stick bands (which move a whole axis),
    // these are per-cell, per-edge — one edge of one cell at a time, or all four with
    // Shift. Drawn in the same framing colour as the Stick faces.
    //
    // For each framed edge we draw TWO solid lines (the frame profile): the inset face
    // AND a solid line ON the cell EDGE itself. That edge line overlays the dashed
    // CENTERLINE (or panel border) for exactly this cell's span, so the centerline
    // segment a frame is generated against reads as a SOLID framed mullion, not a bare
    // dashed centerline. Drawn after the dashed centerlines above, so it sits on top.
    if (!framingHidden && cellFraming && cellFraming.length > 0) {
      ctx.strokeStyle = frameStroke;
      ctx.lineWidth = tk.segmentW;
      const seg2 = (ax: number, ay: number, bx: number, by: number) => {
        const a = toScreen(vp, { x: ax, y: ay });
        const b = toScreen(vp, { x: bx, y: by });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      };
      for (const fc of cellFraming) {
        // Inner INFILL rectangle: inset from each FRAMED edge (an unframed edge stays at
        // the cell edge). In CLEAN view the inset faces span only this inner rect so the
        // four faces miter at the inner corners — each cell reads as a clean frame around
        // a white infill, with NO overshooting/intersecting lines. Other views keep the
        // full-cell-span faces (the live editing representation).
        const inL = fc.x0 + (fc.left > 0 ? fc.left : 0);
        const inR = fc.x1 - (fc.right > 0 ? fc.right : 0);
        const inB = fc.y0 + (fc.bottom > 0 ? fc.bottom : 0);
        const inT = fc.y1 - (fc.top > 0 ? fc.top : 0);
        // top: inset face + solid line on the cell's top edge (centerline at y1).
        if (fc.top > 0) {
          seg2(presentation ? inL : fc.x0, fc.y1 - fc.top, presentation ? inR : fc.x1, fc.y1 - fc.top);
          seg2(fc.x0, fc.y1, fc.x1, fc.y1);
        }
        // bottom: inset face + solid line on the cell's bottom edge (centerline at y0).
        if (fc.bottom > 0) {
          seg2(presentation ? inL : fc.x0, fc.y0 + fc.bottom, presentation ? inR : fc.x1, fc.y0 + fc.bottom);
          seg2(fc.x0, fc.y0, fc.x1, fc.y0);
        }
        // left: inset face + solid line on the cell's left edge (centerline at x0).
        if (fc.left > 0) {
          seg2(fc.x0 + fc.left, presentation ? inB : fc.y0, fc.x0 + fc.left, presentation ? inT : fc.y1);
          seg2(fc.x0, fc.y0, fc.x0, fc.y1);
        }
        // right: inset face + solid line on the cell's right edge (centerline at x1).
        if (fc.right > 0) {
          seg2(fc.x1 - fc.right, presentation ? inB : fc.y0, fc.x1 - fc.right, presentation ? inT : fc.y1);
          seg2(fc.x1, fc.y0, fc.x1, fc.y1);
        }
      }
    }
    // Framing-tool hover (Unitized): re-stroke the targeted cell EDGE(s) in the highlight
    // colour so the single edge that will move reads as selected (all four with Shift),
    // plus a live inset dimension label centred on the cell while dragging.
    if (frameHover) {
      const fh = frameHover;
      ctx.strokeStyle = tk.highlight;
      ctx.lineWidth = tk.highlightW;
      const seg2 = (ax: number, ay: number, bx: number, by: number) => {
        const a = toScreen(vp, { x: ax, y: ay });
        const b = toScreen(vp, { x: bx, y: by });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      };
      const sides = fh.all ? (["top", "right", "bottom", "left"] as const) : ([fh.side] as const);
      for (const s of sides) {
        if (s === "top") seg2(fh.x0, fh.y1, fh.x1, fh.y1);
        else if (s === "bottom") seg2(fh.x0, fh.y0, fh.x1, fh.y0);
        else if (s === "left") seg2(fh.x0, fh.y0, fh.x0, fh.y1);
        else seg2(fh.x1, fh.y0, fh.x1, fh.y1);
      }
      if (fh.offset > 0) {
        const cx = toScreen(vp, { x: (fh.x0 + fh.x1) / 2, y: (fh.y0 + fh.y1) / 2 });
        drawCenteredLabel(ctx, canvas, cx.x, cx.y, `⊣ ${fmtLengthTick(fh.offset)}`);
      }
    }

    // Division PREVIEW for THIS panel (faint ghost lines at the candidate positions):
    // the single hovered line, or the whole evenly-spaced array mid-drag. `xs` are
    // VERTICAL lines (equal-column split); `ys` are HORIZONTAL lines (equal-row split
    // when Shift flips the axis). Only one is populated at a time.
    const previewXs = dividePreview?.edge === seg.index ? dividePreview.xs ?? [] : [];
    const previewYs = dividePreview?.edge === seg.index ? dividePreview.ys ?? [] : [];
    if (dividePreview && dividePreview.edge === seg.index && (previewXs.length > 0 || previewYs.length > 0)) {
      ctx.strokeStyle = tk.unravelDividePreview;
      ctx.lineWidth = tk.segmentW;
      // Vertical ghost lines (column split): baseline → top at each model-x.
      for (const mx of previewXs) {
        const a = toScreen(vp, { x: mx, y: 0 });
        const b = toScreen(vp, { x: mx, y: h });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Horizontal ghost lines (row split): x0 → x1 at each model-y.
      for (const my of previewYs) {
        const a = toScreen(vp, { x: seg.x0, y: my });
        const b = toScreen(vp, { x: seg.x1, y: my });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // LIVE SPACING DIMENSION (parallel to the divisions): a generalized measure
      // SEGMENT spanning ONE bay with end ticks + a distance label, so the user sees
      // how far apart the divisions will be. Drawn in the accent highlight colour so
      // it reads as an active measurement on top of the ghost lines. The segment is
      // HORIZONTAL for a column split (measures a column width) or VERTICAL for a row
      // split (measures a row height).
      const dim = dividePreview.dim;
      if (dim) {
        const a = toScreen(vp, { x: dim.x1, y: dim.y1 });
        const b = toScreen(vp, { x: dim.x2, y: dim.y2 });
        const t = tk.unravelDimTick;
        // Perpendicular unit vector (in screen space) for the end ticks.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len;
        const py = dx / len;
        ctx.strokeStyle = tk.highlight;
        ctx.lineWidth = tk.segmentW;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        // End ticks (short, perpendicular to the measure segment).
        ctx.moveTo(a.x - px * t, a.y - py * t);
        ctx.lineTo(a.x + px * t, a.y + py * t);
        ctx.moveTo(b.x - px * t, b.y - py * t);
        ctx.lineTo(b.x + px * t, b.y + py * t);
        ctx.stroke();
        // Distance label: above a horizontal-ish measure line (matching the column
        // split); centred ON a vertical-ish measure line (its opaque background plate
        // masks the line) for the row split.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (Math.abs(dx) >= Math.abs(dy)) {
          drawCenteredLabel(ctx, canvas, mx, Math.min(a.y, b.y) - tk.unravelLabelGap, fmtLengthTick(dim.dist));
        } else {
          drawCenteredLabel(ctx, canvas, mx, my + 8, fmtLengthTick(dim.dist));
        }
      }
    }

    // Eraser deletion highlights for THIS panel: redraw each targeted line on top
    // in the deletion colour + heavier stroke so the user sees what will be removed.
    for (const hi of eraseHighlight) {
      if (hi.edge !== seg.index) continue;
      ctx.strokeStyle = tk.unravelEraseHighlight;
      ctx.lineWidth = tk.unravelEraseHighlightW;
      ctx.beginPath();
      if (hi.axis === "v") {
        const mx = seg.x0 + hi.offset;
        const a = toScreen(vp, { x: mx, y: 0 });
        const b = toScreen(vp, { x: mx, y: h });
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      } else {
        const my = Math.max(0, Math.min(h, hi.offset));
        const a = toScreen(vp, { x: seg.x0, y: my });
        const b = toScreen(vp, { x: seg.x1, y: my });
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    // ORIENTATION HEATMAP labels: the cell's 8-point cardinal (N, NE, …) drawn
    // CENTRED in each cell, on top of the fill + grid lines so it reads clearly.
    // Drawn with the inverted 'difference' blend (no background plate) so the text
    // auto-contrasts against whatever heatmap hue is behind it — matching the
    // Material-ID label treatment in the one-button-drawing tool.
    // Skipped in overview boundaries-only mode and on cells too small to fit a label
    // (avoids piling overlapping text on a finely-subdivided panel).
    if (!boundariesOnly && cellOrient && cellOrient.length > 0) {
      // Smaller font for the secondary direct-sun (%) line, so it reads as subordinate
      // to the cardinal. Centralised in CSS like the primary label token.
      const sunFont = cssVar(canvas, "--orient-sun-font", "10px ui-monospace, monospace");
      for (const co of cellOrient) {
        const c0 = toScreen(vp, { x: co.x0, y: co.y0 });
        const c1 = toScreen(vp, { x: co.x1, y: co.y1 });
        const cw = Math.abs(c1.x - c0.x);
        const ch = Math.abs(c1.y - c0.y);
        if (cw < 26 || ch < 18) continue;
        const cx = (c0.x + c1.x) / 2;
        const cy = (c0.y + c1.y) / 2;
        // Two-line stack (cardinal over direct-sun %) only when the cell is tall enough
        // to fit both without overlap; otherwise fall back to the cardinal alone so a
        // finely-subdivided panel never piles text. The 9px half-offset matches the
        // 12px/10px label line heights.
        if (co.sun !== undefined && ch >= 34) {
          drawInvertedCellLabel(ctx, canvas, cx, cy - 9, co.label);
          drawInvertedCellLabel(ctx, canvas, cx, cy + 9, co.sun, sunFont);
        } else {
          drawInvertedCellLabel(ctx, canvas, cx, cy, co.label);
        }
      }
    }

    // MATERIAL-ID numbers: the cell's shape index (1-based) drawn CENTRED in each
    // cell, on top of the colour fill + grid lines. Cells of identical shape share a
    // colour AND therefore a number, so the result reads like a paint-by-number key
    // (matching the one-button-drawing Material-ID overlay). Same inverted 'difference'
    // treatment, font and size as the orientation labels above. Skipped in overview
    // boundaries-only mode and on cells too small to fit a label.
    if (!boundariesOnly && cellColors && cellColors.length > 0) {
      for (const cc of cellColors) {
        const c0 = toScreen(vp, { x: cc.x0, y: cc.y0 });
        const c1 = toScreen(vp, { x: cc.x1, y: cc.y1 });
        const cw = Math.abs(c1.x - c0.x);
        const ch = Math.abs(c1.y - c0.y);
        if (cw < 26 || ch < 18) continue;
        const cx = (c0.x + c1.x) / 2;
        const cy = (c0.y + c1.y) / 2;
        drawInvertedCellLabel(ctx, canvas, cx, cy, String(cc.colorIndex + 1));
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
    // When THIS panel is the one selected via double-click (the active Additive /
    // Subtractive target) the label is drawn in the faint floor-plate grey instead
    // of the default dark label text, to signal the selection (the height field —
    // a DOM overlay — is recoloured to the same token in PolylineTool).
    const selected = seg.index === selectedEdge;
    // In the PANELS phase the focused panel is dimensioned per COLUMN / per ROW
    // (below), so its single overall-width label is suppressed — the per-column
    // labels replace it (for a single-column panel they coincide, so nothing is
    // lost). Every other panel keeps the normal one overall-width label.
    if (!dimensionsHidden && seg.index !== cellDimEdge) {
      drawCenteredLabel(
        ctx,
        canvas,
        (baseL.x + baseR.x) / 2,
        topL.y - tk.unravelLabelGap,
        fmtLengthTick(seg.length),
        selected ? tk.floorPlate : undefined,
      );
    }

    // PANELS phase per-COLUMN / per-ROW dimensions for the focused panel. We label
    // each grid band so the user sees the resolved width of every column (along the
    // TOP) and the height of every row (along the LEFT) — the granular counterpart
    // to the strip view's single width-per-panel label. Boundaries are derived the
    // SAME way as cellsForEdge / the division mullions above so the labels line up
    // exactly with the drawn grid (dedupe epsilon 1e-6).
    if (!boundariesOnly && !dimensionsHidden && seg.index === cellDimEdge) {
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      // VERTICAL boundaries: panel borders + equal-cell splits + Subtractive divisions.
      const xs: number[] = [lo, hi];
      for (let k = 1; k < nCells; k++) xs.push(lo + (hi - lo) * (k / nCells));
      for (const off of divisions ?? []) xs.push(seg.x0 + off);
      // HORIZONTAL boundaries: baseline + top + interior Subtractive dividers.
      const ys: number[] = [0, h];
      for (const off of dividersH ?? []) if (off > 0 && off < h) ys.push(off);
      // Sort ascending + dedupe so coincident lines never produce a zero-width label.
      const dedupe = (arr: number[]): number[] => {
        const sorted = [...arr].sort((a, b) => a - b);
        const out: number[] = [];
        for (const v of sorted) if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1e-6) out.push(v);
        return out;
      };
      const vx = dedupe(xs);
      const vy = dedupe(ys);
      // LEFT row labels reuse the default --label-text colour (so they match the
      // other dimensions); recoloured to the selection grey when this panel is the
      // selected target, mirroring the top labels and the DOM height field.
      const rowColor = selected ? tk.floorPlate : cssVar(canvas, "--label-text", "#1c2530");
      // TOP: one width label centred over each column.
      for (let i = 0; i < vx.length - 1; i++) {
        const center = (vx[i] + vx[i + 1]) / 2;
        drawCenteredLabel(
          ctx,
          canvas,
          toScreen(vp, { x: center, y: 0 }).x,
          topL.y - tk.unravelLabelGap,
          fmtLengthTick(vx[i + 1] - vx[i]),
          selected ? tk.floorPlate : undefined,
        );
      }
      // LEFT: one height label centred on each row, right-aligned just left of the
      // panel border (the same parking the floor-plate elevation markers use).
      for (let j = 0; j < vy.length - 1; j++) {
        const center = (vy[j] + vy[j + 1]) / 2;
        drawRightAlignedLabel(
          ctx,
          canvas,
          baseL.x - tk.unravelLabelGap,
          toScreen(vp, { x: seg.x0, y: center }).y,
          fmtLengthTick(vy[j + 1] - vy[j]),
          rowColor,
        );
      }
    }
  }

  // ASSEMBLY phase: the single SELECTED cell (double-clicked into) is dimensioned
  // on ALL FOUR edges and its hovered edge is stroked red. This is a POST-LOOP
  // block (independent of any one panel/seg): focusedCellDims already carries the
  // cell's model rect, so we annotate it directly. Drawn only on the main canvas
  // (boundariesOnly overview suppresses every label/overlay).
  if (!boundariesOnly && focusedCellDims) {
    const fc = focusedCellDims;
    // Model bounds, normalised so lo/hi hold regardless of corner order.
    const loX = Math.min(fc.x0, fc.x1);
    const hiX = Math.max(fc.x0, fc.x1);
    const loY = Math.min(fc.y0, fc.y1); // BOTTOM edge (model +Y is UP)
    const hiY = Math.max(fc.y0, fc.y1); // TOP edge
    const width = hiX - loX; // top & bottom labels
    const height = hiY - loY; // left & right labels
    const cxM = (loX + hiX) / 2;
    const cyM = (loY + hiY) / 2;
    // Four screen corners (model +Y up flips to screen -Y, so TOP corners are above).
    const tl = toScreen(vp, { x: loX, y: hiY });
    const tr = toScreen(vp, { x: hiX, y: hiY });
    const bl = toScreen(vp, { x: loX, y: loY });
    const br = toScreen(vp, { x: hiX, y: loY });
    // Screen anchors for label placement.
    const centerX = toScreen(vp, { x: cxM, y: cyM }).x;
    const centerY = toScreen(vp, { x: cxM, y: cyM }).y;
    // Height (px) of a label plate — must match drawCenteredLabel's internal `h`
    // so the BOTTOM label clears the edge by exactly one gap + its own height.
    const labelH = 16;
    // Left/right HEIGHT labels match the other dimensions' default text colour.
    const labelColor = cssVar(canvas, "--label-text", "#1c2530");
    // Dimension labels follow ONLY the Dim toggle (dimensionsHidden) — no view auto-hides
    // them. The red edge selection below stays regardless so Assembly-phase edge targeting
    // still works as an affordance even with dimensions hidden.
    if (!dimensionsHidden) {
      // TOP (width): centred above the top edge, its bottom edge one gap up.
      drawCenteredLabel(ctx, canvas, centerX, tl.y - tk.unravelLabelGap, fmtLengthTick(width));
      // BOTTOM (width): centred below the bottom edge. drawCenteredLabel sits the
      // label's BOTTOM at the passed y, so add the gap + the label height to park it
      // just below the edge.
      drawCenteredLabel(ctx, canvas, centerX, bl.y + tk.unravelLabelGap + labelH, fmtLengthTick(width));
      // LEFT (height): right-aligned one gap left of the left edge, vertically centred.
      drawRightAlignedLabel(ctx, canvas, tl.x - tk.unravelLabelGap, centerY, fmtLengthTick(height), labelColor);
      // RIGHT (height): left-aligned one gap right of the right edge, vertically centred.
      drawLeftAlignedLabel(ctx, canvas, tr.x + tk.unravelLabelGap, centerY, fmtLengthTick(height), labelColor);
    }

    // Hovered edge: stroke that ONE edge red (heavier width) to mark the selection.
    if (focusedCellEdge) {
      const edges = {
        top: [tl, tr],
        right: [tr, br],
        bottom: [bl, br],
        left: [tl, bl],
      } as const;
      const [a, b] = edges[focusedCellEdge];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = tk.unravelEdgeSelect;
      ctx.lineWidth = tk.highlightW;
      ctx.stroke();
    }
  }
}

/** Draw a small text label with a background plate, horizontally centred at x,
 *  with its bottom edge at bottomY. An optional `color` overrides the default
 *  label text colour (used to draw a SELECTED panel's width label in floor-plate
 *  grey); when omitted the standard --label-text token is used. */
function drawCenteredLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cx: number,
  bottomY: number,
  text: string,
  color?: string,
): void {
  const fg = color ?? cssVar(canvas, "--label-text", "#1c2530");
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
 * Inverted cell label centred on `(cx, cy)` — used by both the Orientation heatmap
 * (cardinal N, NE, S, …) and the Material-ID view (per-shape number).
 *
 * Unlike {@link drawCenteredLabel} this draws NO background plate. The glyphs are
 * composited with the 'difference' blend over white, so the colour auto-inverts
 * against whatever cell hue sits behind it (like the classic inverted mouse
 * pointer) — maximum contrast on any background with no outline/halo. This mirrors
 * the Material-ID label treatment in the one-button-drawing tool. Font and size
 * match the shared label token so the text reads identically across views.
 */
function drawInvertedCellLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cx: number,
  cy: number,
  text: string,
  font?: string,
): void {
  ctx.save();
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#ffffff"; // difference vs white ⇒ inverted colour of the background pixel
  ctx.font = font ?? cssVar(canvas, "--label-font", "12px ui-monospace, monospace");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/**
 * Draw a small text label with a background plate whose RIGHT edge is at `rightX`
 * and which is vertically CENTRED on `cy`. Used for floor-plate height markers
 * parked just left of the unravel strip, so they read as a right-aligned column
 * of elevations. The text colour is passed in so the markers can match the
 * fainter floor-plate line colour rather than the dark default label text.
 */
function drawRightAlignedLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  rightX: number,
  cy: number,
  text: string,
  color: string,
): void {
  const fg = color;
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

/**
 * Mirror of {@link drawRightAlignedLabel}: a small text label with a background
 * plate whose LEFT edge is at `leftX` and which is vertically CENTRED on `cy`.
 * Used for the Assembly-phase RIGHT edge dimension, parked just right of the
 * focused cell so it reads as a left-aligned counterpart to the left height label.
 */
function drawLeftAlignedLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  leftX: number,
  cy: number,
  text: string,
  color: string,
): void {
  const fg = color;
  const bgc = cssVar(canvas, "--label-bg", "rgba(255,255,255,0.88)");
  ctx.font = cssVar(canvas, "--label-font", "12px ui-monospace, monospace");
  const padding = 4;
  const h = 16;
  const w = ctx.measureText(text).width;
  const x = leftX;
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
  tk: { handleLine: string; handleKnob: string; handleR: number; handleLineW: number },
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
    ctx.lineWidth = tk.handleLineW;
    ctx.stroke();
    // Square knob to distinguish a control handle from a round anchor vertex.
    const r = tk.handleR;
    ctx.fillStyle = tk.handleKnob;
    ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
  }
}

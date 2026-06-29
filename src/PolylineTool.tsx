/**
 * PolylineTool.tsx
 *
 * The interactive tool. This component owns the INPUT-HANDLING layer and the
 * React UI shell. It deliberately keeps three concerns separate:
 *
 *   - DATA MODEL   -> core/geometry.ts + core/perimeterOps.ts (Perimeter)
 *   - RENDERING    -> core/renderer.ts (paints model + viewport to canvas)
 *   - INPUT        -> this file (pointer/keyboard -> model operations)
 *
 * The canvas is treated as a pure projection of the model; React state holds
 * the model and transient interaction flags, and an effect repaints on change.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  emptyPerimeter,
  distance,
  snapPoint,
  constrainAngle,
  hitVertex,
  hitSegment,
  hitHandle,
  flattenPerimeter,
  perimeterLength,
  enclosedArea,
  type Perimeter,
  type Point,
} from "./core/geometry";
import {
  addVertex,
  close as closePerimeter,
  moveVertex,
  insertVertexOnSegment,
  deleteVertex,
  eraseElements,
  popVertex,
  setHandle,
  makeSegmentArc,
  clearVertexHandles,
} from "./core/perimeterOps";
import { defaultViewport, toScreen, toModel, pixelsToModel, zoomAt, pan, fitViewport, easeOut, lerpViewport, type Viewport } from "./core/viewport";
import { render, type RenderState, type UnravelDraw } from "./core/renderer";
import { unravelPerimeter, unravelBoundsPerimeter, buildEqualColumns, buildEqualRows, type UnravelSegment } from "./core/unravel";
import { DEFAULT_WALL_HEIGHT_FT } from "./core/extrude3d";
import {
  fmtLength,
  fmtArea,
  fmtLengthTick,
  toDisplayLength,
  fromDisplayLength,
  lengthAbbr,
  getUnitSystem,
  setUnitSystem,
  persistUnitSystem,
  type UnitSystem,
} from "./core/units";
import {
  loadSaved,
  persistSaved,
  makeSavedPerimeter,
  duplicateSavedPerimeter,
  cloneElevationState,
  clonePerimeter,
  canSave,
  emptyLocation,
  cloneLocation,
  cloneCellFraming,
  type SavedPerimeter,
  type SavedElevationState,
  type LocationInfo,
  type CellInsets,
} from "./core/savedPerimeters";
import {
  cloneSolarSettings,
  defaultSolarSettings,
  sunPosition,
  wallIncidenceCos,
  type SolarSettings,
} from "./core/solar";
import { buildRadiationMatrix } from "./core/radiation";
import RadiationDiagram from "./RadiationDiagram";
import InsolationChart from "./InsolationChart";
import MiniWindow from "./MiniWindow";
import ExportPopup from "./ExportPopup";
import OverviewMap from "./OverviewMap";
import Settings from "./Settings";

/** Pixel tolerance for hit-testing vertices/segments. */
const HIT_TOLERANCE_PX = 9;
/** Pixel tolerance for "click the first vertex to close". */
const CLOSE_TOLERANCE_PX = 12;
/** Pointer travel (px) before a press-drag counts as a handle pull rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/**
 * Cooldown (ms) between consecutive FORWARD layer drills (Elevations → Panels →
 * Assembly). Navigation is now a single click, so a habitual DOUBLE-click would
 * otherwise fire two presses and jump two layers at once; ignoring a second drill
 * within this window makes one click reliably advance exactly one layer while still
 * allowing deliberate sequential navigation (which naturally pauses to reacquire the
 * target after each zoom animation).
 */
const DRILL_COOLDOWN_MS = 300;

/** Curtain-wall fabrication systems selectable from the "CW Type" button, with the
 *  labels shown to the user (the button relabels to "CW Type: <name>" once chosen). */
type CwType = "stick" | "unitized";
const CW_TYPE_LABELS: Record<CwType, string> = {
  stick: "Stick System",
  unitized: "Unitized System",
};

/**
 * CELL VIEW MODES — the display modes the "View" button's dropdown menu lists. "normal"
 * is the default presentation; "materialId" colours every grid cell by its geometric
 * shape (a Lumion-style Material ID overlay). The menu lists them in this array order, so
 * adding a future mode here automatically adds a menu entry.
 */
const CELL_VIEW_MODES = ["normal", "materialId", "orientation", "clean", "shadows"] as const;
type CellViewMode = (typeof CELL_VIEW_MODES)[number];
/** Human label for each cell-view mode (shown on the View button + its menu). */
const CELL_VIEW_LABELS: Record<CellViewMode, string> = {
  normal: "Technical",
  materialId: "Material ID",
  orientation: "Orientation Heatmap",
  clean: "Clean",
  shadows: "Shadows",
};

/**
 * The "?" help button opens a submenu that picks ONE of three reference panels. Each
 * panel reuses the same floating-popup chrome; only its title + body differ.
 */
type HelpPanel = "controls" | "stats" | "views";
/** Title shown (UPPERCASED by CSS) at the top-left of each help reference panel. */
const HELP_PANEL_TITLE: Record<HelpPanel, string> = {
  controls: "Control List",
  stats: "Statistics Info",
  views: "View Modes Info",
};

/** 8-point compass labels, indexed by round(bearing / 45) — N at 0°, clockwise. */
const CARDINALS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** The 8-point cardinal label for a true compass bearing (deg, 0 = N, CW). */
function bearingToCardinal8(bearingDeg: number): string {
  const b = ((bearingDeg % 360) + 360) % 360;
  return CARDINALS_8[Math.round(b / 45) % 8];
}

/**
 * Orientation HEAT scalar in [0,1] for a true compass bearing — drives the
 * Orientation Heatmap colour ramp (0 = cool/blue, 1 = warm/red). Anchored to the
 * brief: NORTH-facing glass is coolest (0, blue) and WEST-facing is hottest (1,
 * red), reflecting that west elevations take the harshest afternoon solar load and
 * north the least. Heat rises clockwise N→E→S→W over the first 270°, then falls
 * back W→N over the final 90° (through NW), so it is continuous around the compass.
 */
function bearingToHeatT(bearingDeg: number): number {
  const b = ((bearingDeg % 360) + 360) % 360;
  return b <= 270 ? b / 270 : 1 - (b - 270) / 90;
}

/**
 * LIVE direct-sun readout for the Orientation Heatmap — the second label line under
 * each cell's cardinal. Given a facade's true compass bearing and the active Solar
 * Study settings, reports how much of the DIRECT beam the facade catches RIGHT NOW
 * (the studied day + hour): the cosine of the sun's angle of incidence on the wall,
 * as a percentage (the industry-standard "direct exposure factor" that scales beam
 * solar gain). It is constant across a panel's cells — they share the wall plane — so
 * every cell of a facade shows the same value, and it updates live as the Solar Study
 * sun is scrubbed. Returns:
 *   "—"   when the sun is BELOW the horizon (night — no direct sun on any facade),
 *   "0%"  when the sun is up but BEHIND the wall (self-shaded — no direct beam),
 *   "NN%" otherwise (100% = sun square-on the facade, the harshest direct load).
 */
function sunHitLabel(bearingDeg: number, solar: SolarSettings): string {
  const pos = sunPosition(solar.latitude, solar.dayOfYear, solar.hour);
  if (pos.altitude <= 0) return "—"; // sun below horizon → no direct sun anywhere
  const f = wallIncidenceCos(pos, bearingDeg);
  if (f <= 0) return "0%"; // sun behind the facade → self-shaded
  return `${Math.round(f * 100)}%`;
}
/**
 * Rounding step (feet) used to BUCKET cell shapes into "same shape" groups for the
 * Material-ID view and the unique-cell count: two cells whose width AND height match
 * to this resolution share a colour. 1e-3′ ≈ 0.012″ — finer than any real tolerance,
 * so it only collapses floating-point dust, not genuinely distinct sizes.
 */
const CELL_SHAPE_EPS = 1e-3;

/** Snap increment (feet) for the Mullions tool's drag-to-set offset (0.25′). */
const MULLION_STEP = 0.25;
/** Pixel tolerance for grabbing a rectangle's TOP edge to resize its height. */
const TOP_EDGE_TOLERANCE_PX = 6;
/**
 * Pixel tolerance for the "intelligent" floor-plate increment snap: when an
 * increment has been established (the first plate above ground), the cursor's
 * elevation magnetically snaps to the nearest multiple of that increment if it
 * lands within this many screen pixels of it. Converted to model units per-frame
 * via `pixelsToModel` so the magnet feels the same at any zoom.
 */
const FLOORPLATE_SNAP_PX = 30;
/**
 * Pixel tolerance for the Eraser tool's "nearest division line" hit-test: while
 * armed, a panel's vertical division / horizontal divider within this many screen
 * pixels of the cursor is targeted for deletion (the nearest one wins). Converted
 * to model units per-frame via `pixelsToModel` so it feels the same at any zoom.
 */
const ERASE_SNAP_PX = 12;
/** Minimum per-panel height (model units) — keeps every rectangle visibly sized. */
const MIN_UNRAVEL_HEIGHT = 0.5;

/**
 * The line currently targeted for deletion by the armed Eraser tool, or null.
 * For panel division lines (`"v"` or `"h"`): `edge` is the panel's edge index
 * and `index` is the position in that axis's offset array. For floor plates
 * (`"fp"`): `edge` is unused (-1) and `index` is the position in `floorPlates`.
 */
type EraseTarget = { edge: number; axis: "v" | "h" | "fp"; index: number };

type Mode = "draw" | "edit";
/** Curve type for newly drawn segments. */
type CurveType = "line" | "arc";

/** Maximum number of undo steps retained. */
const HISTORY_LIMIT = 100;
/**
 * A snapshot of the AUTHORED document for undo/redo. Holds only what the user
 * actively creates/edits — the perimeter geometry and the per-panel unravel
 * heights/cells — not transient view state (viewport, selection, mode) or the
 * saved-library list. All values are immutable (perimeter ops + the height/cell
 * maps are replaced, never mutated), so a snapshot is a cheap reference copy.
 */
interface DocSnapshot {
  perimeter: Perimeter;
  unravelHeights: Record<number, number>;
  unravelCells: Record<number, number>;
  /** Per-edge-index vertical division-line offsets (Subtractive tool). Replaced, never mutated. */
  panelDivisions: Record<number, number[]>;
  /** Per-edge-index HORIZONTAL divider offsets (Subtractive + Shift). Replaced, never mutated. */
  panelDividersH: Record<number, number[]>;
  /** Per-edge vertical / horizontal mullion half-width offsets (Mullions tool). */
  panelMullionsV: Record<number, number>;
  panelMullionsH: Record<number, number>;
  /** Per-edge UNITIZED per-cell framing insets (Framing tool, Unitized system).
   *  panel edge → cell index → the four edge insets. Replaced, never mutated. */
  panelCellFraming: Record<number, Record<number, CellInsets>>;
  /** Per-edge assigned curtain-wall system (Stick / Unitized). Replaced, never mutated. */
  panelCwType: Record<number, CwType>;
  unravelHeight: number;
  /** Placed floor-plate elevations (model Y). Replaced, never mutated. */
  floorPlates: number[];
}

/**
 * Eye / eye-off visibility toggle embedded in the RIGHT edge of a tool button's
 * rectangle (Floor Lines · Centerlines · Framing). Rendered as a sibling that overlays
 * the button's right portion (the host wrapper is position:relative), so clicking it
 * toggles only the corresponding element's on-canvas visibility — never the button's
 * main action. `disabled` mirrors the parent button so the icon greys out in lockstep.
 */
function VisToggle({
  visible,
  disabled,
  onToggle,
  label,
}: {
  visible: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="vis-toggle"
      // Sibling, not nested — but stop propagation anyway so a click never bubbles to
      // the cluster's outside-press handlers that dismiss menus.
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      disabled={disabled}
      aria-pressed={!visible}
      aria-label={`${visible ? "Hide" : "Show"} ${label}`}
      title={`${visible ? "Hide" : "Show"} ${label}`}
    >
      {visible ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      )}
    </button>
  );
}

export default function PolylineTool() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // CURSOR CROSSHAIRS (perimeter view). Two thin full-canvas lines that track the
  // pointer. Driven by a dedicated native pointermove listener writing CSS transforms
  // directly to these elements (no React state / scene redraw), so they follow the
  // cursor with minimal latency. crosshairRef = container (visibility), V/H = the lines.
  const crosshairRef = useRef<HTMLDivElement>(null);
  const crosshairVRef = useRef<HTMLDivElement>(null);
  const crosshairHRef = useRef<HTMLDivElement>(null);

  // --- DATA MODEL (source of truth) ---
  const [perimeter, setPerimeter] = useState<Perimeter>(emptyPerimeter);

  // --- VIEWPORT ---
  const [viewport, setViewport] = useState<Viewport>(() => defaultViewport(800, 600));
  // Always-current viewport, so the zoom animator can read the live start state
  // without a stale closure.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  // requestAnimationFrame id for an in-flight viewport tween (null = none).
  const animRef = useRef<number | null>(null);

  /** Cancel any in-flight viewport animation (e.g. when the user takes over). */
  const cancelAnim = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  /**
   * Smoothly animate the viewport to `target` (ease-out, centre-anchored) so
   * double-click zoom-in, Esc zoom-out, and fit-on-load glide instead of jumping.
   * The motion is anchored to the viewport CENTRE (see lerpViewport), so the view
   * heads straight for its destination with no off-centre swing. Trivial moves snap
   * instantly; any in-flight tween is cancelled first.
   */
  const animateViewport = useCallback((target: Viewport, duration = 280) => {
    cancelAnim();
    const from = viewportRef.current;
    const { w, h } = sizeRef.current;
    if (
      Math.abs(from.scale - target.scale) < 1e-3 &&
      Math.abs(from.originX - target.originX) < 0.5 &&
      Math.abs(from.originY - target.originY) < 0.5
    ) {
      setViewport(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        setViewport(target);
        animRef.current = null;
        return;
      }
      setViewport(lerpViewport(from, target, easeOut(t), w, h));
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }, [cancelAnim]);

  // Stop any running tween if the component unmounts mid-animation.
  useEffect(() => () => cancelAnim(), [cancelAnim]);

  // --- TOOL / PRECISION SETTINGS ---
  const [mode, setMode] = useState<Mode>("draw");
  const [curveType, setCurveType] = useState<CurveType>("line");
  // Snap-to-grid is permanently ON: placing/moving points always rounds to
  // `gridSpacing`. There is no toggle (it is a fixed precision guarantee), so this
  // is a constant rather than state. The grid itself is never drawn — only the
  // snapping uses `gridSpacing`.
  const snapEnabled = true;
  // Fixed 1 ft snap grid; no longer user-editable. Snapping always rounds to this.
  const gridSpacing = 1;

  // --- UNRAVEL VIEW (unwrap edges into rectangles / "spaces") ---
  const [unravelOn, setUnravelOn] = useState(false);
  // Fixed default spacing between unwrapped panels (10 ft). No longer user-editable
  // from the panel; change this constant to retune the strip layout.
  const unravelGap = 10;
  // DEFAULT height (model units, 1u = 1ft) — seeds any panel that hasn't been
  // individually resized. Default reuses DEFAULT_WALL_HEIGHT_FT so the unwrap and
  // 3D massing agree. The global "Height" input edits this value (and clears all
  // per-panel overrides, making it a "make them all uniform" action).
  const [unravelHeight, setUnravelHeight] = useState(DEFAULT_WALL_HEIGHT_FT);
  // PER-PANEL height overrides, keyed by ORIGINAL edge index (stable across gap /
  // order changes). A panel's effective height = override[index] ?? unravelHeight.
  // Stale keys for edges that no longer exist are harmless (ignored); new edges
  // fall back to the default. Set by dragging a rectangle's top edge or by typing
  // in its on-rectangle height input.
  const [unravelHeights, setUnravelHeights] = useState<Record<number, number>>({});
  // Draft text for the on-rectangle height inputs while the user is typing. Keyed
  // by edge index; an entry exists only while a field is focused/edited. Committing
  // (Enter/blur) clamps the value into unravelHeights and drops the draft so the
  // field returns to showing the live effective height. This keeps typing free
  // (clamp doesn't fight mid-edit) while the model stays the source of truth.
  const [unravelInputDraft, setUnravelInputDraft] = useState<Record<number, string>>({});
  // Which per-panel height field (by edge index) is currently focused/being
  // edited, or null if none. Drives a DISPLAY-ONLY swap: when idle the field
  // shows the value WITH the foot tick (e.g. `10.00′`, matching the canvas WIDTH
  // label); when focused it shows the PLAIN number so typing + parsing work
  // normally. This never touches the committed model value.
  const [focusedUnravelInput, setFocusedUnravelInput] = useState<number | null>(null);
  // PER-PANEL cell split count, keyed by ORIGINAL edge index (default 1 = no
  // split). Drawn as N-1 division lines inside the rectangle.
  const [unravelCells, setUnravelCells] = useState<Record<number, number>>({});
  // PER-PANEL vertical DIVISION lines placed by the Subtractive tool, keyed by
  // ORIGINAL edge index. Each value is a list of OFFSETS in model units from the
  // panel's left edge (seg.x0); offsets snap to the global 1 ft grid. Distinct from
  // unravelCells (which is N equal splits) — these are user-placed mullions; the
  // Subtractive tool writes EQUAL-COLUMN splits here, but the store itself is just
  // arbitrary offsets (so divisions can accumulate across multiple splits).
  const [panelDivisions, setPanelDivisions] = useState<Record<number, number[]>>({});
  // PER-PANEL HORIZONTAL dividers placed by the Subtractive tool while Shift is held,
  // keyed by ORIGINAL edge index. Each value is a list of OFFSETS in model units from
  // the panel's BASELINE (y = 0). The horizontal mirror of `panelDivisions`: instead of
  // splitting a panel into equal-width columns, these split it into equal-height rows.
  const [panelDividersH, setPanelDividersH] = useState<Record<number, number[]>>({});
  // Subtractive tool armed? Enabled only with a panel selected (focusedPanel). While
  // on, hovering the selected panel recommends an equal-column split (or equal-row
  // split while Shift is held); click places it. Esc / re-click / deselect disarms it.
  const [subtractiveOn, setSubtractiveOn] = useState(false);
  // Subtractive HOVER PREVIEW: the raw cursor model point inside the selected panel
  // before a press, or null. The render builder picks the split AXIS by `shiftHeld`
  // (vertical columns from .x, horizontal rows from .y). During a drag the array
  // preview lives in `divideDraft` instead.
  const [divideHover, setDivideHover] = useState<Point | null>(null);
  // The in-progress division array being dragged (committed on pointer-up): the target
  // edge, the split AXIS ("v" = vertical columns, model-x; "h" = horizontal rows,
  // model-y), and the line positions for that axis. null when not dragging.
  const [divideDraft, setDivideDraft] = useState<{ edge: number; axis: "v" | "h"; lines: number[] } | null>(null);
  // Eraser tool armed? The DESTRUCTIVE counterpart to Subtractive: deletes division
  // lines on the focused panel AND floor plates (global — no panel required). Enabled
  // whenever the unravel view is open. While on, hovering near any erasable line
  // highlights it; a click removes it. Mutually exclusive with Subtractive/Additive.
  const [eraserOn, setEraserOn] = useState(false);
  // Eraser HOVER HIGHLIGHT: the line currently targeted for deletion (nearest to
  // the cursor within ERASE_SNAP_PX — a panel division or a floor plate), or null.
  // The render builder turns it into a distinct deletion-highlight overlay.
  const [eraseHover, setEraseHover] = useState<EraseTarget | null>(null);
  // Eraser DRAG COLLECTED: the set of lines accumulated during an active click-drag
  // stroke, committed as one undo step on pointer-up. Empty when not dragging.
  const [eraseDragCollected, setEraseDragCollected] = useState<EraseTarget[]>([]);
  // Eraser VERTEX DRAG COLLECTED (perimeter view): the perimeter vertex INDICES the
  // cursor has swept over during an active Erase stroke, highlighted in the delete
  // colour and removed together as one undo step on pointer-up. Empty when not dragging.
  const [eraseVertexCollected, setEraseVertexCollected] = useState<number[]>([]);
  // Eraser EDGE HOVER (perimeter view): the index of the closed-perimeter EDGE the
  // cursor is over (and not over a vertex), highlighted in the delete colour; a click
  // removes that one segment and reopens the loop there (keeping both vertices). -1
  // when not targeting an edge.
  const [eraseEdge, setEraseEdge] = useState(-1);
  // Eraser EDGE DRAG COLLECTED (perimeter view): the perimeter EDGE indices the cursor
  // has swept over during an active Erase stroke, highlighted in the delete colour and
  // removed together (with any vertices, plus orphaned vertices) as one undo step on
  // pointer-up. Empty when not dragging.
  const [eraseEdgeCollected, setEraseEdgeCollected] = useState<number[]>([]);
  // CELL VIEW MODE — a purely VISUAL display mode for the elevation/Panels view
  // (the "View" button, top-left next to Statistics). "normal" is the default look; "materialId"
  // tints every grid CELL by its geometric SHAPE (width × height) in a unique colour
  // — like Lumion's Material ID — so identical cells across the whole project read in
  // the same colour at a glance. Not a tool (it arms nothing, mutates no document
  // state) and not persisted: it is an ephemeral way of LOOKING at the model. The
  // "View" button opens a dropdown menu listing the CELL_VIEW_MODES to pick from.
  const [cellViewMode, setCellViewMode] = useState<CellViewMode>("normal");
  // Is the "View" display-mode dropdown menu open?
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  // CURTAIN-WALL TYPE — assigned PER PANEL (edge index → system). Each panel carries at
  // most ONE system (Stick or Unitized); the "CW Type" menu sets it for the focused
  // panel. Switching a panel's type clears that panel's framing of the OTHER system
  // (its centerlines are kept) — see selectCwType — so a panel never mixes Stick bands
  // and Unitized cell insets. Absent = no system chosen for that panel yet.
  const [panelCwType, setPanelCwType] = useState<Record<number, CwType>>({});
  // Is the CW Type two-option chooser menu open?
  const [cwMenuOpen, setCwMenuOpen] = useState(false);
  // MULLIONS tool armed? Only available once a CW Type is chosen. Mutually exclusive
  // with the rest of the bottom-left cluster.
  const [mullionsOn, setMullionsOn] = useState(false);
  // TYPE tool armed? A SCAFFOLDED cluster tool (no canvas behaviour yet — see the
  // "scaffold only" decision): it turns blue when armed and is mutually exclusive with
  // the rest of the cluster, becoming available only once the focused panel carries at
  // least one frame. Its eye icon toggles `typeVisible` (a wired no-op for now, to drive
  // visibility once the feature renders something).
  const [typeOn, setTypeOn] = useState(false);
  const [typeVisible, setTypeVisible] = useState(true);
  // RENDER / CONSTRAINT — two SCAFFOLDED top-row buttons (no behaviour yet) that sit
  // just left of the Projects minimap, in line with the top-left undo/redo cluster.
  // They toggle blue/white like the other tool buttons and are only clickable outside
  // the Building Perimeter tab (i.e. in the unravel views, `unravelOn`).
  const [renderOn, setRenderOn] = useState(false);
  const [constraintOn, setConstraintOn] = useState(false);
  // --- EXPORT (select walls -> download CAD geometry) ---
  // When armed, a left-drag in the unravel view sweeps a MARQUEE that selects the
  // panels (walls) it intersects; releasing with a non-empty selection opens the
  // export popup. Mutually exclusive with the other armed tools. Unravel-only.
  const [exportSelectMode, setExportSelectMode] = useState(false);
  // ORIGINAL edge indices currently selected (highlighted on the canvas). Persists
  // after release so the user sees what they exported until they reselect / leave.
  const [exportSelection, setExportSelection] = useState<Set<number>>(() => new Set());
  // Live marquee rectangle in MODEL space while dragging a selection, else null.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The selection the export popup is open for (null = popup closed). Snapshotted
  // on release so editing the live selection afterwards doesn't mutate the dialog.
  const [exportPopup, setExportPopup] = useState<Set<number> | null>(null);
  // Per-edge mullion HALF-WIDTH offsets (feet), set by dragging a grid line with the
  // Mullions tool (Stick system). V = applied to every vertical grid line of a panel,
  // H = every horizontal one. Each grid line renders as a pair of faces at ±offset.
  const [panelMullionsV, setPanelMullionsV] = useState<Record<number, number>>({});
  const [panelMullionsH, setPanelMullionsH] = useState<Record<number, number>>({});
  // UNITIZED per-cell framing (Framing tool under the Unitized system): panel edge →
  // cell index (in cellsForEdge order) → the inward inset of each of the cell's four
  // edges (feet). Unlike the Stick maps above (one offset per axis for the whole
  // panel), framing here is per-cell, per-edge. Reset for a panel when its centerlines
  // change (clearPanelMullion), so new cells always start un-framed.
  const [panelCellFraming, setPanelCellFraming] = useState<Record<number, Record<number, CellInsets>>>({});
  // Mullions-tool hover: which axis's grid lines are under the cursor on the focused
  // panel ("v"/"h"), or null. Highlights the whole set (they adjust together).
  const [mullionHover, setMullionHover] = useState<"v" | "h" | null>(null);
  // Live drag preview: the offset being dragged for an axis on a panel, or null.
  const [mullionDraft, setMullionDraft] = useState<{ edge: number; axis: "v" | "h"; offset: number } | null>(null);
  // Framing-tool hover (Unitized): the cell + which of its four edges the cursor is
  // nearest on the focused panel, or null. Highlights that single cell edge so the
  // user sees the one face that a drag will move. Panels tab only.
  const [cellEdgeHover, setCellEdgeHover] = useState<{ cellIndex: number; side: "top" | "right" | "bottom" | "left" } | null>(null);
  // Live drag preview for unitized cell framing: which cell edge is being dragged on a
  // panel, the in-progress inset offset, and whether Shift is held (all four edges).
  const [cellFrameDraft, setCellFrameDraft] = useState<
    { edge: number; cellIndex: number; side: "top" | "right" | "bottom" | "left"; offset: number; all: boolean } | null
  >(null);
  // The panel (edge index) currently zoomed-to via double-click, or null. Esc
  // restores the full-strip fit and clears this.
  const [focusedPanel, setFocusedPanel] = useState<number | null>(null);
  // The ACTIVE curtain-wall type: the FOCUSED panel's assigned system, or null when no
  // panel is focused / the focused panel has no system yet. Derived from the per-panel
  // map so all the existing Framing logic (which already operates on the focused panel)
  // reads "this panel's system" with no further changes. Drives the Framing tool's
  // Stick-vs-Unitized behaviour, the menu's active mark, and button enablement.
  const cwType: CwType | null = focusedPanel !== null ? panelCwType[focusedPanel] ?? null : null;
  // The grid CELL (within focusedPanel) currently zoomed-to in the Assembly phase,
  // identified by its model-space rectangle bounds, or null. Set by the Assembly nav
  // button (defaults to the top-left-most cell) and by double-clicking a cell here.
  // Esc backs out one layer at a time (cell → panel → strip), so this is the deepest
  // navigation level. Always cleared whenever focusedPanel is cleared / view changes.
  const [focusedCell, setFocusedCell] = useState<{ edge: number; x0: number; x1: number; y0: number; y1: number } | null>(null);
  // PANELS phase only: index (into cellsForEdge(focusedPanel)) of the grid cell the
  // cursor is hovering, or -1 for none. Drives a per-cell highlight so a zoomed-in,
  // subdivided panel visibly reads as a set of individually navigable cells. Stored
  // as an index (not a rectangle) so a hover over the SAME cell bails the re-render
  // (number compare), matching the other hovered-* indices. Only meaningful while a
  // split panel is focused and we are not yet in the deeper Assembly cell zoom.
  const [hoveredCell, setHoveredCell] = useState(-1);
  // ASSEMBLY phase only (a single cell zoomed-to via double-click, focusedCell set):
  // which of the focused cell's four edges the cursor is nearest (within a pixel
  // tolerance), or null for none. Drives the red edge-selection highlight so the
  // user can target an individual edge of the cell. One edge at a time; cleared
  // whenever the cursor is not near any edge or the phase changes.
  const [hoveredCellEdge, setHoveredCellEdge] = useState<"top" | "right" | "bottom" | "left" | null>(null);
  // --- FLOOR PLATES (horizontal level reference lines) ---
  // Placed floor-plate elevations stored in MODEL Y (so they pan/zoom with the
  // geometry instead of drifting in screen space — a floor level is a fixed
  // elevation). Drawn as ghosted dotted horizontal lines spanning the canvas.
  const [floorPlates, setFloorPlates] = useState<number[]>([]);
  // When armed, the "floor plate" tool shows a ghosted preview line tracking the
  // cursor's elevation; a left-click drops a plate there (click an existing plate
  // to remove it). Place as many as wanted. Esc / clicking the button disarms it.
  const [floorPlateMode, setFloorPlateMode] = useState(false);
  // VISIBILITY of the floor lines / centerlines / framing — view preferences (NOT model
  // data, so not persisted): false hides those elements from the elevation view without
  // deleting them. Each is toggled by the eye icon embedded in its tool button (Floor
  // Lines / Centerlines / Framing).
  const [floorLinesVisible, setFloorLinesVisible] = useState(true);
  const [centerlinesVisible, setCenterlinesVisible] = useState(true);
  const [framingVisible, setFramingVisible] = useState(true);
  // VISIBILITY of the on-canvas DIMENSION text (panel width / per-column-row / cell
  // dimension labels AND the per-panel height input fields) across the Elevations,
  // Wall Border, and Cells tabs. Toggled ONLY by the Dim button's eye icon (the Dim
  // button itself has no action yet); this is the SINGLE source of truth, so no view
  // (Clean / Shadows) auto-hides dimensions. Visible by default.
  const [dimensionsVisible, setDimensionsVisible] = useState(true);

  // --- ONBOARDING HINT ---
  // A first-run hint centered on the empty canvas ("Draw a perimeter to start or open a
  // saved project") with an arched arrow toward the Projects panel. It is dismissed the
  // instant the user interacts with ANYTHING (any pointerdown) and never returns this
  // session. Only shown while the canvas is genuinely empty (no perimeter drawn yet).
  const [hintDismissed, setHintDismissed] = useState(false);
  const showHint = !hintDismissed && !unravelOn && perimeter.vertices.length === 0;
  // Dismiss on the first pointerdown anywhere (canvas, panel, nav, Projects panel…).
  useEffect(() => {
    if (!showHint) return;
    const dismiss = () => setHintDismissed(true);
    window.addEventListener("pointerdown", dismiss, { capture: true, once: true });
    return () => window.removeEventListener("pointerdown", dismiss, { capture: true });
  }, [showHint]);

  // --- HELP POPUP ---
  // The bottom-right "?" button opens a small submenu (helpMenuOpen) ABOVE itself that
  // picks ONE of three reference panels (helpPanel): the control list, the statistics
  // info, or the view-modes info. The submenu and a panel are mutually exclusive
  // (opening one closes the other). `helpOpen` (derived) means "any help UI is showing"
  // — it drives the button's active state and lets the global key handler defer Escape.
  // Each panel is dismissed by its close button, an outside click, or Escape.
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [helpPanel, setHelpPanel] = useState<HelpPanel | null>(null);
  const helpOpen = helpMenuOpen || helpPanel !== null;
  const closeHelp = () => {
    setHelpMenuOpen(false);
    setHelpPanel(null);
  };

  // --- SMART SEARCH ---
  const [searchQuery, setSearchQuery] = useState("");

  // --- SETTINGS POPUP ---
  // The gear button at the top-right of the nav header toggles a draggable Settings
  // popup (same chrome as the Solar Study popup) holding the Units category.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Attention flash: triggered when the user clicks outside the Settings popup.
  const [settingsFlashing, setSettingsFlashing] = useState(false);
  const settingsFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSettingsBackdrop = useCallback(() => {
    if (settingsFlashTimer.current) clearTimeout(settingsFlashTimer.current);
    setSettingsFlashing(true);
    settingsFlashTimer.current = setTimeout(() => setSettingsFlashing(false), 400);
  }, []);

  // Active DISPLAY unit (feet ↔ metric). Geometry is always stored in feet; this only
  // controls how lengths/areas are formatted and how typed input is parsed. Seeded from
  // the module-level value in core/units (already loaded from the persisted preference),
  // so the first paint matches the saved choice. Mirrored into React state so changing
  // it re-renders the DOM readouts AND re-runs the canvas paint effect (it's a dep).
  const [unitSystem, setUnitSystemState] = useState<UnitSystem>(() => getUnitSystem());
  // Apply a unit choice everywhere: update the module-level value the renderer + all
  // formatters read, persist it, then bump React state to repaint. No geometry changes.
  const applyUnitSystem = useCallback((u: UnitSystem) => {
    setUnitSystem(u);
    persistUnitSystem(u);
    setUnitSystemState(u);
  }, []);

  // --- LEFT TOOL PANEL COLLAPSE ---
  // Hide the left tool panel (Create / Location) to reclaim horizontal screen space
  // for the canvas. Toggled from the chevron at the left of the nav header; when
  // collapsed the panel's grid column shrinks to zero (see .app--panel-collapsed).
  const [panelCollapsed, setPanelCollapsed] = useState(true);

  // --- STATISTICS DROPDOWN ---
  // The "Statistics" button (top of canvas, next to Redo) toggles a dropdown that
  // "none" = hidden; "general" = the general stats overlay; "irradiance" = the
  // Irradiance (W/m²) diagram (a Ladybug-style month×hour solar heatmap on the selected
  // wall border); "insolation" = its energy companion, the monthly Insolation (kWh/m²)
  // bar chart for the same wall. statsMenuOpen controls the selector dropdown (None /
  // General / Irradiance / Insolation options).
  const [statsMode, setStatsMode] = useState<"none" | "general" | "irradiance" | "insolation">("none");
  const [statsMenuOpen, setStatsMenuOpen] = useState(false);
  // The statistics selection is SHARED across views, but only for stats that exist on
  // BOTH sides. "General" reads in the Building Perimeter and the unravel/elevation
  // views alike, so it carries over. The solar diagrams (Irradiance / Insolation) are
  // wall-orientation reads with no footprint meaning, so outside the unravel views the
  // EFFECTIVE mode collapses to "none" — the Building Perimeter shows nothing for them.
  // `statsMode` itself is left untouched so the solar pick is restored on return to the
  // elevations; this derived value drives the button label, the menu active-state, and
  // the overlay render conditions so all three agree per view.
  const effectiveStatsMode =
    !unravelOn && (statsMode === "irradiance" || statsMode === "insolation") ? "none" : statsMode;

  // --- TRANSIENT INTERACTION STATE ---
  const [cursorModel, setCursorModel] = useState<Point | null>(null);
  // REVIT-STYLE DIMENSION ENTRY (perimeter draw). Once at least one vertex is down,
  // typing a number sets the EXACT length of the next segment: the cursor keeps
  // aiming the DIRECTION (the rubber band previews snapping to the typed length),
  // Enter commits the vertex at that distance, Esc cancels the entry, Backspace
  // edits it. null = not entering a dimension; otherwise the partial string typed
  // so far (e.g. "12" or "12.").
  const [dimInput, setDimInput] = useState<string | null>(null);
  // Latest cursor model point + dim-entry string, mirrored to refs so the global
  // keydown handler reads current values without re-subscribing on every move/keystroke.
  const cursorRef = useRef<Point | null>(null);
  cursorRef.current = cursorModel;
  const dimInputRef = useRef<string | null>(null);
  dimInputRef.current = dimInput;
  const [shiftHeld, setShiftHeld] = useState(false);
  const [selectedVertex, setSelectedVertex] = useState(-1);
  const [hoveredVertex, setHoveredVertex] = useState(-1);
  const [insertPreview, setInsertPreview] = useState<Point | null>(null);
  // Perimeter-mode hover-link: original edge index of the footprint edge under the
  // cursor in edit mode (-1 = none). Highlights the matching edge LINE (not the
  // wall panel) on the active saved thumbnail in the mini-window.
  const [hoveredEdge, setHoveredEdge] = useState(-1);
  // Unravel hover-link: original edge index of the unravel strip under the cursor
  // (-1 = none). Highlights that strip on the canvas and the matching edge on the
  // active saved thumbnail in the mini-window.
  const [hoveredUnravelEdge, setHoveredUnravelEdge] = useState(-1);
  // Unravel height-resize: original edge index whose rectangle TOP edge is under
  // the cursor (-1 = none). Drives the ns-resize cursor + the emphasised top edge,
  // and (on press) starts a height drag for that panel.
  const [hoveredUnravelTop, setHoveredUnravelTop] = useState(-1);
  // Vertex whose handles are actively being pulled during DRAW (for rendering),
  // or -1. Distinct from selection so it only fires while pulling a handle out.
  const [activeDrawHandle, setActiveDrawHandle] = useState(-1);

  // --- SAVED PERIMETERS (persisted to localStorage) ---
  // Initialised lazily from localStorage so saves survive a reload (load-on-mount
  // happens once during the initial render, not in an effect that could flash).
  const [saved, setSaved] = useState<SavedPerimeter[]>(() => loadSaved());
  // Which saved entry (if any) is currently loaded into the editor — used to
  // highlight it in the mini-window and to target the "Update" action.
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);

  // --- LOCATION (geo-location of the sketch) ---
  // Free-text address the user types in the LOCATION panel section, plus resolved
  // coordinates (null until a geocoder — the planned Mapbox integration — fills
  // them). Defaults BLANK so an untouched sketch carries no geolocation (the blank
  // canvas is fully supported). Persisted with the saved entry so the address is
  // remembered and the future map view can reference it without re-typing.
  const [location, setLocation] = useState<LocationInfo>(emptyLocation);

  // Drag state lives in a ref (no re-render needed mid-drag for tracking).
  //  - pan:        middle-drag the viewport
  //  - vertex:     move an anchor
  //  - handle:     drag a Bézier control knob (mirror = keep tangent smooth)
  //  - drawHandle: press-drag right after placing a vertex to pull out handles
  //  - unravelHeight: drag a rectangle's top edge to stretch THAT panel's height
  type Drag =
    | { kind: "pan"; lastX: number; lastY: number; button: number; moved: boolean }
    | { kind: "vertex"; index: number }
    | { kind: "handle"; index: number; which: "in" | "out"; mirror: boolean }
    | { kind: "drawHandle"; index: number; anchor: Point; moved: boolean }
    | { kind: "unravelHeight"; edge: number }
    | { kind: "divide"; edge: number }
    | { kind: "mullion"; edge: number; axis: "v" | "h"; ref: number }
    | {
        kind: "cellframe";
        edge: number;
        cellIndex: number;
        side: "top" | "right" | "bottom" | "left";
        cell: { x0: number; x1: number; y0: number; y1: number };
        all: boolean;
      }
    | { kind: "erase"; collected: EraseTarget[]; last: Point }
    | { kind: "eraseVertex"; collected: number[]; edges: number[]; last: Point }
    | { kind: "marquee"; startModel: Point };
  const dragRef = useRef<Drag | null>(null);
  // Timestamp (performance.now) of the last forward layer drill, so a rapid second
  // click (e.g. a habitual double-click) within DRILL_COOLDOWN_MS is ignored and one
  // click advances exactly one layer. See DRILL_COOLDOWN_MS.
  const lastDrillRef = useRef(0);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });

  // --- UNDO / REDO ---
  // A history entry is either a DOCUMENT edit (restore a prior DocSnapshot) or a
  // PROJECT DELETION (re-insert / re-remove a saved entry at its original index).
  // Both share the SAME undo/redo stacks so actions unwind in true temporal order.
  type HistoryEntry =
    | { kind: "doc"; doc: DocSnapshot }
    | { kind: "delete"; entry: SavedPerimeter; index: number };
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  // Always-current document snapshot, refreshed every render, so the capture and
  // undo/redo helpers read fresh values without stale-closure bugs.
  const docRef = useRef<DocSnapshot>({ perimeter, unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCwType, unravelHeight, floorPlates });
  docRef.current = { perimeter, unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCwType, unravelHeight, floorPlates };
  // Pre-interaction snapshot for a drag / field edit, pushed on the FIRST actual
  // change (so a no-op press/focus never creates an empty undo step).
  const pendingRef = useRef<DocSnapshot | null>(null);

  /** Push any history entry and invalidate the redo branch (a fresh action). */
  const pushHistory = useCallback((entry: HistoryEntry) => {
    setUndoStack((s) => {
      const n = [...s, entry];
      return n.length > HISTORY_LIMIT ? n.slice(n.length - HISTORY_LIMIT) : n;
    });
    setRedoStack([]);
  }, []);
  const pushUndo = useCallback((snap: DocSnapshot) => pushHistory({ kind: "doc", doc: snap }), [pushHistory]);
  /** Capture the CURRENT document as a restore point (for discrete actions). */
  const recordHistory = useCallback(() => pushUndo(docRef.current), [pushUndo]);
  /** Mark the start of a drag/field edit (snapshot taken, not yet pushed). */
  const beginHistory = useCallback(() => {
    pendingRef.current = docRef.current;
  }, []);
  /** Push the pending pre-interaction snapshot once (call before the first change). */
  const flushHistory = useCallback(() => {
    if (pendingRef.current) {
      pushUndo(pendingRef.current);
      pendingRef.current = null;
    }
  }, [pushUndo]);

  /** Restore a document snapshot (used by undo/redo). Clears transient edit state. */
  const applyDoc = useCallback((d: DocSnapshot) => {
    setPerimeter(d.perimeter);
    setUnravelHeights(d.unravelHeights);
    setUnravelCells(d.unravelCells);
    setPanelDivisions(d.panelDivisions);
    setPanelDividersH(d.panelDividersH);
    setPanelMullionsV(d.panelMullionsV);
    setPanelMullionsH(d.panelMullionsH);
    setPanelCellFraming(d.panelCellFraming);
    setPanelCwType(d.panelCwType);
    setUnravelHeight(d.unravelHeight);
    setFloorPlates(d.floorPlates);
    setSelectedVertex(-1);
    setHoveredVertex(-1);
    setInsertPreview(null);
    setUnravelInputDraft({});
    pendingRef.current = null;
  }, []);

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    if (entry.kind === "doc") {
      setRedoStack([...redoStack, { kind: "doc", doc: docRef.current }]);
      applyDoc(entry.doc);
    } else {
      // Undo a deletion: re-insert the project at its original position. The redo
      // branch keeps the same descriptor so a redo simply deletes it again.
      setSaved((list) => {
        if (list.some((s) => s.id === entry.entry.id)) return list; // already present
        const next = list.slice();
        next.splice(Math.min(entry.index, next.length), 0, entry.entry);
        return next;
      });
      setRedoStack([...redoStack, entry]);
    }
  }, [undoStack, redoStack, applyDoc]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    if (entry.kind === "doc") {
      setUndoStack([...undoStack, { kind: "doc", doc: docRef.current }]);
      applyDoc(entry.doc);
    } else {
      // Redo a deletion: remove the project again (mirroring the original delete,
      // including clearing the active id if it was the active project).
      setSaved((list) => list.filter((s) => s.id !== entry.entry.id));
      setActiveSavedId((cur) => (cur === entry.entry.id ? null : cur));
      setUndoStack([...undoStack, entry]);
    }
  }, [undoStack, redoStack, applyDoc]);

  const drawing = mode === "draw" && !perimeter.closed;

  // Cursor crosshairs are shown in the BUILDING PERIMETER view (draw or edit) once the
  // user has actually started — i.e. placed at least one vertex (so they appear the
  // moment drawing begins) — and stay active while editing the closed perimeter's
  // vertices. Never shown in the unravel/elevation views.
  const showCrosshair = !unravelOn && perimeter.vertices.length > 0;

  // Drive the crosshairs from a dedicated native pointermove listener so they track
  // the cursor with the least possible lag — direct CSS-transform writes, bypassing
  // React state and the full canvas redraw. Attached only while the crosshairs are
  // active. Visibility follows the pointer entering/leaving the canvas.
  useEffect(() => {
    if (!showCrosshair) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const cont = crosshairRef.current;
    const vLine = crosshairVRef.current;
    const hLine = crosshairHRef.current;
    if (!canvas || !wrap || !cont || !vLine || !hLine) return;
    const place = (clientX: number, clientY: number) => {
      // getBoundingClientRect here does NOT force a reflow: we only ever mutate
      // `transform`, which is composited and never dirties layout.
      const r = wrap.getBoundingClientRect();
      vLine.style.transform = `translateX(${clientX - r.left}px)`;
      hLine.style.transform = `translateY(${clientY - r.top}px)`;
    };
    const move = (e: PointerEvent) => {
      place(e.clientX, e.clientY);
      cont.style.opacity = "1";
    };
    const leave = () => {
      cont.style.opacity = "0";
    };
    canvas.addEventListener("pointermove", move, { passive: true });
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerenter", move);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerenter", move);
    };
  }, [showCrosshair]);

  // Unravel layout (only computed while the view is active). Each edge becomes a
  // horizontal baseline segment in clockwise order, preserving its true length.
  const unravelResult = useMemo(
    () => (unravelOn ? unravelPerimeter(perimeter, unravelGap) : null),
    [unravelOn, perimeter, unravelGap],
  );

  // Effective height for one panel: its per-edge override, else the global default.
  const effectiveHeight = useCallback(
    (edgeIndex: number) => unravelHeights[edgeIndex] ?? unravelHeight,
    [unravelHeights, unravelHeight],
  );

  // Resolve each unravel segment to its drawn (per-panel) height for the renderer
  // and the DOM input overlay. Keeps the renderer height-policy-agnostic.
  const unravelDraws = useMemo<UnravelDraw[] | null>(() => {
    if (!unravelResult) return null;
    return unravelResult.segments.map((seg) => {
      // Effective mullion offsets: the live drag draft overrides the committed value
      // for the panel/axis being dragged, so the band previews as the cursor moves.
      const mullionV =
        mullionDraft && mullionDraft.edge === seg.index && mullionDraft.axis === "v"
          ? mullionDraft.offset
          : panelMullionsV[seg.index] ?? 0;
      const mullionH =
        mullionDraft && mullionDraft.edge === seg.index && mullionDraft.axis === "h"
          ? mullionDraft.offset
          : panelMullionsH[seg.index] ?? 0;
      // Hover highlight only on the focused panel while the Mullions tool (Stick) is armed.
      const mullionHoverAxis =
        mullionsOn && cwType === "stick" && focusedPanel === seg.index ? mullionHover : null;
      return {
        seg,
        height: effectiveHeight(seg.index),
        cells: unravelCells[seg.index] ?? 1,
        divisions: panelDivisions[seg.index] ?? [],
        dividersH: panelDividersH[seg.index] ?? [],
        mullionV,
        mullionH,
        mullionHoverAxis,
      };
    });
  }, [
    unravelResult,
    effectiveHeight,
    unravelCells,
    panelDivisions,
    panelDividersH,
    panelMullionsV,
    panelMullionsH,
    mullionDraft,
    mullionsOn,
    cwType,
    focusedPanel,
    mullionHover,
  ]);

  /** Clamp + (optionally) grid-snap a candidate panel height. */
  const clampHeight = useCallback(
    (h: number) => {
      let v = Number.isFinite(h) ? h : MIN_UNRAVEL_HEIGHT;
      if (snapEnabled && gridSpacing > 0) v = Math.round(v / gridSpacing) * gridSpacing;
      return Math.max(MIN_UNRAVEL_HEIGHT, v);
    },
    [snapEnabled, gridSpacing],
  );

  /** Set one panel's per-edge height override (keyed by original edge index). */
  const setPanelHeight = useCallback((edge: number, h: number) => {
    setUnravelHeights((prev) => ({ ...prev, [edge]: h }));
  }, []);

  /** Commit an on-rectangle height input's draft (Enter/blur): clamp + drop draft. */
  const commitPanelInput = useCallback(
    (edge: number) => {
      const raw = unravelInputDraft[edge];
      if (raw !== undefined && raw.trim() !== "") {
        recordHistory();
        // The field is typed in the active display unit; convert to model feet before
        // clamping/storing so the stored geometry stays in feet regardless of unit.
        setPanelHeight(edge, clampHeight(fromDisplayLength(parseFloat(raw))));
      }
      setUnravelInputDraft((prev) => {
        const next = { ...prev };
        delete next[edge];
        return next;
      });
    },
    [unravelInputDraft, clampHeight, setPanelHeight, recordHistory],
  );

  /**
   * Resolve a raw cursor model-Y into the elevation a floor plate should land at,
   * applying the "intelligent" increment snap. Shared by BOTH placement
   * (`onPointerDown`) and the live preview (`onPointerMove`) so the ghost line and
   * the committed plate can never disagree.
   *
   * The INCREMENT is the smallest strictly-positive plate elevation. Because the
   * ground (0) plate is always present, the first plate the user places ABOVE
   * ground is that smallest positive value, so it defines the floor-to-floor
   * rhythm (matches the user's "place 10′ → snap to 10/20/30…" example). Deriving
   * it from state (not a captured "first" value) keeps it correct across
   * undo/redo and plate deletion.
   *
   * Behaviour:
   *  - No positive plate yet (ground only) OR Shift held -> NO increment snap;
   *    fall back to the existing fixed 1 ft grid snap (`gridSpacing`).
   *  - Otherwise snap to the nearest NON-NEGATIVE multiple of the increment when
   *    the cursor is within `FLOORPLATE_SNAP_PX` (in model units) of it; else fall
   *    back to the grid snap. Multiples are clamped to >= 0 (floors sit at/above
   *    the ground datum).
   */
  const snapFloorPlateY = useCallback(
    (rawY: number): number => {
      const gridSnap = snapEnabled && gridSpacing > 0 ? Math.round(rawY / gridSpacing) * gridSpacing : rawY;
      // Shift bypasses the increment magnet entirely (free / grid-only placement).
      if (shiftHeld) return gridSnap;
      // Increment = smallest strictly-positive plate elevation (the first plate
      // placed above the ground 0 datum). None yet -> no magnet.
      let increment = Infinity;
      for (const p of floorPlates) if (p > 1e-6 && p < increment) increment = p;
      if (!Number.isFinite(increment)) return gridSnap;
      // Nearest non-negative multiple of the increment.
      const multiple = Math.max(0, Math.round(rawY / increment)) * increment;
      const tolModel = pixelsToModel(viewport, FLOORPLATE_SNAP_PX);
      return Math.abs(rawY - multiple) <= tolModel ? multiple : gridSnap;
    },
    [floorPlates, shiftHeld, viewport, snapEnabled, gridSpacing],
  );

  /** Convert a raw pointer event to a model point, applying snap + constraint. */
  const eventToModel = useCallback(
    (e: { clientX: number; clientY: number; shiftKey: boolean }): Point => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      let p = toModel(viewport, sx, sy);
      if (snapEnabled) p = snapPoint(p, gridSpacing);
      // Angle constraint while drawing with Shift: lock to 15° increments
      // relative to the previous vertex. Snap-then-constrain keeps it on grid
      // directions where possible while guaranteeing the angle lock.
      if (e.shiftKey && drawing && perimeter.vertices.length > 0) {
        const last = perimeter.vertices[perimeter.vertices.length - 1];
        p = constrainAngle(last, p, 15);
      }
      return p;
    },
    [viewport, snapEnabled, gridSpacing, drawing, perimeter.vertices],
  );

  /**
   * Revit-style dimension preview: while the user is typing an exact segment length
   * (dimInput), the next vertex sits at that distance from the last vertex along the
   * CURSOR's direction (so the mouse aims, the keyboard sizes). null when not entering
   * a dimension, the typed value isn't a positive number yet, or the cursor has no
   * direction (sitting on the last vertex / off-canvas). Drives both the rubber-band
   * preview and the committed point so they always agree.
   */
  const dimPreview = useMemo<Point | null>(() => {
    if (dimInput === null) return null;
    // The user types in the active display unit; convert to model feet for geometry.
    const len = fromDisplayLength(parseFloat(dimInput));
    if (!isFinite(len) || len <= 0) return null;
    const v = perimeter.vertices;
    if (v.length === 0 || !cursorModel) return null;
    const last = v[v.length - 1];
    const dx = cursorModel.x - last.x;
    const dy = cursorModel.y - last.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    return { x: last.x + (dx / d) * len, y: last.y + (dy / d) * len };
  }, [dimInput, perimeter.vertices, cursorModel]);

  /**
   * Commit the typed dimension as the next vertex (Enter during dimension entry).
   * Reads the live perimeter/cursor/input via refs so the keydown handler need not
   * re-subscribe on every move. Places the vertex at the EXACT typed length along the
   * cursor direction (no grid snap — the typed value is authoritative). Returns true
   * when it consumed the key (an entry was active), even if the value was unusable.
   */
  const commitDimVertex = useCallback(() => {
    const raw = dimInputRef.current;
    if (raw === null) return false;
    // Typed in the active display unit; convert to model feet for the placed vertex.
    const len = fromDisplayLength(parseFloat(raw));
    const v = docRef.current.perimeter.vertices;
    const cur = cursorRef.current;
    if (!isFinite(len) || len <= 0 || v.length === 0 || !cur) {
      setDimInput(null);
      return true;
    }
    const last = v[v.length - 1];
    const dx = cur.x - last.x;
    const dy = cur.y - last.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      setDimInput(null);
      return true;
    }
    const pt = { x: last.x + (dx / d) * len, y: last.y + (dy / d) * len };
    recordHistory();
    setPerimeter((p) => addVertex(p, pt));
    setDimInput(null);
    return true;
  }, [recordHistory]);

  /**
   * Hit-test a model point against each rectangle's TOP edge in the unravel view.
   * A top edge is "hit" when the cursor's x is within [x0,x1] (± tolerance) AND its
   * model-y is within `TOP_EDGE_TOLERANCE_PX` (converted to model units) of that
   * panel's height. Returns the matching ORIGINAL edge index, or -1.
   */
  const hitUnravelTop = useCallback(
    (m: Point): number => {
      const segs = unravelResult?.segments;
      if (!segs || segs.length === 0) return -1;
      const tolModel = pixelsToModel(viewport, TOP_EDGE_TOLERANCE_PX);
      for (const s of segs) {
        const lo = Math.min(s.x0, s.x1);
        const hi = Math.max(s.x0, s.x1);
        if (m.x < lo - tolModel || m.x > hi + tolModel) continue;
        if (Math.abs(m.y - effectiveHeight(s.index)) <= tolModel) return s.index;
      }
      return -1;
    },
    [unravelResult, viewport, effectiveHeight],
  );

  /**
   * Hit-test a model point against each rectangle's BODY (x within [x0,x1] and y
   * in 0..that panel's height, each ± a small tolerance). Returns the matching
   * ORIGINAL edge index, or -1. Used for hover and double-click-to-zoom.
   */
  const hitUnravelPanel = useCallback(
    (m: Point): number => {
      const segs = unravelResult?.segments;
      if (!segs || segs.length === 0) return -1;
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      for (const s of segs) {
        const lo = Math.min(s.x0, s.x1);
        const hi = Math.max(s.x0, s.x1);
        if (m.x < lo - tolModel || m.x > hi + tolModel) continue;
        if (m.y >= -tolModel && m.y <= effectiveHeight(s.index) + tolModel) return s.index;
      }
      return -1;
    },
    [unravelResult, viewport, effectiveHeight],
  );

  /** Zoom the viewport to fit a single panel's rectangle (double-click action). */
  const zoomToPanel = useCallback(
    (edge: number) => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      if (!seg) return;
      const { w, h } = sizeRef.current;
      const h0 = effectiveHeight(edge);
      // Fit just this rectangle with a comfortable margin so it fills the screen.
      // Animate the transition so the zoom-in glides instead of snapping.
      animateViewport(fitViewport(unravelBoundsPerimeter([seg], () => h0), w, h, 56));
      setFocusedPanel(edge);
      // Selecting / re-framing a PANEL leaves any deeper Assembly cell context, so
      // clear it — never carry a stale focused cell from another panel.
      setFocusedCell(null);
    },
    [unravelResult, effectiveHeight, animateViewport],
  );

  /**
   * Compute the grid CELLS of one focused panel (by original edge index) as
   * model-space rectangles — the SAME grid the renderer draws, now made navigable
   * for the Assembly phase. Mirrors renderer.ts: VERTICAL boundaries come from the
   * panel borders (seg.x0/x1), the equal-cell splits (`unravelCells`, N-1 evenly
   * spaced lines), and the Subtractive vertical divisions (`panelDivisions`, offset
   * from seg.x0); HORIZONTAL boundaries come from the baseline (0), the panel height,
   * and the Subtractive horizontal dividers (`panelDividersH`, kept strictly inside).
   * Each adjacent vertical pair × adjacent horizontal pair forms one cell.
   *
   * Reads from the live unravel layout when present, else recomputes it directly from
   * the perimeter (mirroring the Panels nav button), so it works even when `unravelOn`
   * has not yet flipped on.
   */
  const cellsForEdge = useCallback(
    (edge: number): { x0: number; x1: number; y0: number; y1: number }[] => {
      const segs = unravelResult?.segments ?? unravelPerimeter(perimeter, unravelGap).segments;
      const seg = segs.find((s) => s.index === edge);
      if (!seg) return [];
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      const height = effectiveHeight(edge);
      // Vertical boundary set: borders + equal-cell splits + Subtractive divisions.
      const xs: number[] = [lo, hi];
      const nCells = Math.max(1, Math.round(unravelCells[edge] ?? 1));
      for (let k = 1; k < nCells; k++) xs.push(lo + (hi - lo) * (k / nCells));
      for (const off of panelDivisions[edge] ?? []) xs.push(seg.x0 + off);
      // Horizontal boundary set: baseline + top + interior Subtractive dividers.
      const ys: number[] = [0, height];
      for (const off of panelDividersH[edge] ?? []) if (off > 0 && off < height) ys.push(off);
      // Sort ascending + dedupe (epsilon) so coincident lines never make zero-size cells.
      const dedupe = (arr: number[]) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const out: number[] = [];
        for (const v of sorted) if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1e-6) out.push(v);
        return out;
      };
      const vx = dedupe(xs);
      const vy = dedupe(ys);
      const cells: { x0: number; x1: number; y0: number; y1: number }[] = [];
      for (let i = 0; i < vx.length - 1; i++)
        for (let j = 0; j < vy.length - 1; j++)
          cells.push({ x0: vx[i], x1: vx[i + 1], y0: vy[j], y1: vy[j + 1] });
      return cells;
    },
    [unravelResult, perimeter, unravelGap, effectiveHeight, unravelCells, panelDivisions, panelDividersH],
  );

  /**
   * The SOLAR settings governing the LIVE drawing: the active saved entry's stored
   * settings (edited in its Solar Study popup), or fresh defaults for a brand-new
   * unsaved shape. Only `northOffset` matters for the Orientation Heatmap — it is the
   * compass bearing (deg CW from true north) of the model's +Y axis, so it rotates
   * every facade's outward-normal bearing into TRUE compass directions. This is the
   * link that ties the heatmap to the Solar Study diagram (same source of truth).
   */
  const activeSolar = useMemo<SolarSettings>(() => {
    const entry = activeSavedId ? saved.find((s) => s.id === activeSavedId) : null;
    return entry?.solar ?? defaultSolarSettings();
  }, [activeSavedId, saved]);

  /**
   * TRUE compass bearing (deg, 0 = N, CW) that each perimeter EDGE's glass faces —
   * its OUTWARD normal in plan, rotated by the Solar Study's `northOffset`. Keyed by
   * the originating edge index (== UnravelSegment.index), so each unravel panel can
   * look up which way it points. Drives the Orientation Heatmap's per-cell colour +
   * cardinal label.
   *
   * Outward normal: with model +Y up, the polygon's signed area gives its winding;
   * interior lies to the LEFT of each directed edge for a CCW loop (RIGHT for CW), so
   * the OUTWARD normal of edge a→b (direction d) is (d.y,−d.x) when CCW and (−d.y,d.x)
   * when CW — guaranteeing we use the EXTERIOR face normal, not the interior one,
   * regardless of how the user drew the loop. The bearing is atan2(nx,ny) (CW from
   * model-north = +Y) plus `northOffset` to reach true compass north.
   */
  const faceBearings = useMemo<Record<number, number>>(() => {
    const v = perimeter.vertices;
    const n = v.length;
    if (!perimeter.closed || n < 3) return {};
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const a = v[i];
      const b = v[(i + 1) % n];
      area2 += a.x * b.y - b.x * a.y;
    }
    const ccw = area2 > 0;
    const out: Record<number, number> = {};
    for (let i = 0; i < n; i++) {
      const a = v[i];
      const b = v[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const nx = ccw ? dy : -dy;
      const ny = ccw ? -dx : dx;
      let bearing = (Math.atan2(nx, ny) * 180) / Math.PI + activeSolar.northOffset;
      bearing = ((bearing % 360) + 360) % 360;
      out[i] = bearing;
    }
    return out;
  }, [perimeter, activeSolar]);

  /**
   * MATERIAL-ID cell grouping for the whole project. Walks EVERY panel's cell grid
   * (via cellsForEdge — a panel with no centerlines yields exactly one whole-panel
   * cell, so it counts as one large cell) and buckets cells by geometric SHAPE
   * (width × height, rounded to CELL_SHAPE_EPS). Each distinct shape gets a stable
   * colour INDEX (sorted by width then height so colours don't reshuffle as panels
   * change). Exposes `uniqueCount` for the Statistics readout and `indexOf(cell)` for
   * the renderer's per-cell tint. Recomputed live as the grid (cellsForEdge) changes.
   */
  const cellShapeColors = useMemo(() => {
    const keyOf = (c: { x0: number; x1: number; y0: number; y1: number }) =>
      `${Math.round((c.x1 - c.x0) / CELL_SHAPE_EPS)}x${Math.round((c.y1 - c.y0) / CELL_SHAPE_EPS)}`;
    const keys = new Set<string>();
    // Per shape key, collect EVERY cell instance across all panels so identical cells
    // can be given slightly different SHADES (a saturation taper) — matching the
    // one-button-drawing Material-ID map, where same-shape panels share a hue/number
    // but fan out in saturation. Each instance is identified by (edge, x0, y0).
    const instances = new Map<string, Array<{ edge: number; x0: number; y0: number }>>();
    for (const seg of unravelResult?.segments ?? [])
      for (const c of cellsForEdge(seg.index)) {
        const k = keyOf(c);
        keys.add(k);
        const inst = { edge: seg.index, x0: c.x0, y0: c.y0 };
        const arr = instances.get(k);
        if (arr) arr.push(inst);
        else instances.set(k, [inst]);
      }
    const sorted = [...keys].sort((a, b) => {
      const [aw, ah] = a.split("x").map(Number);
      const [bw, bh] = b.split("x").map(Number);
      return aw - bw || ah - bh;
    });
    const index = new Map(sorted.map((k, i) => [k, i] as const));
    // Deterministic RANK of each instance within its shape group (ordered by panel,
    // then position) plus the group size — together they give each cell a shade
    // fraction in [0,1] below. Sorting keeps shades stable as unrelated panels change.
    const rank = new Map<string, number>();
    const groupSize = new Map<string, number>();
    for (const [k, arr] of instances) {
      arr.sort((a, b) => a.edge - b.edge || a.y0 - b.y0 || a.x0 - b.x0);
      groupSize.set(k, arr.length);
      arr.forEach((inst, i) => rank.set(`${inst.edge}|${inst.x0}|${inst.y0}`, i));
    }
    return {
      uniqueCount: sorted.length,
      indexOf: (c: { x0: number; x1: number; y0: number; y1: number }) => index.get(keyOf(c)) ?? 0,
      // Shade FRACTION (0 → 1) of a cell instance within its shape group: 0 for the
      // first instance, 1 for the last (single-instance groups → 0). Identical cells
      // keep one hue/number but get a slightly different saturation across this range.
      shadeOf: (edge: number, c: { x0: number; x1: number; y0: number; y1: number }) => {
        const n = groupSize.get(keyOf(c)) ?? 1;
        if (n <= 1) return 0;
        return (rank.get(`${edge}|${c.x0}|${c.y0}`) ?? 0) / (n - 1);
      },
      // Material-ID KEY of a cell (its shape bucket). Two cells with the same key are
      // the "same" cell — used both for the colour index above and for mirroring a
      // Unitized framing edit across every cell of that shape (see the cellframe commit).
      keyOf,
    };
  }, [unravelResult, cellsForEdge]);

  /**
   * The base unravel draws AUGMENTED with the UNITIZED per-cell framing overlay, for
   * the 2D elevation canvas only. Computed HERE (after cellsForEdge) because resolving
   * each cell's model rect needs the panel's cell grid — and the base `unravelDraws`
   * memo is declared before cellsForEdge (it would hit the temporal-dead-zone). The
   * base draws (3D minimap + the DOM height-input overlay) stay framing-agnostic. The
   * live drag draft and the hover edge are folded in so the inset previews live.
   */
  const unravelDraws2d = useMemo<UnravelDraw[] | null>(() => {
    if (!unravelDraws) return null;
    // MATERIAL-ID MIRRORING (live preview): while a cellframe drag is in flight, the
    // inset is previewed on EVERY cell sharing the dragged cell's shape (Material ID),
    // across all panels — not just the cell under the cursor. Resolve the dragged
    // cell's shape key once so each cell below can test membership.
    const draftCell = cellFrameDraft
      ? cellsForEdge(cellFrameDraft.edge)[cellFrameDraft.cellIndex] ?? null
      : null;
    const draftKey = draftCell ? cellShapeColors.keyOf(draftCell) : null;
    return unravelDraws.map((d) => {
      const edge = d.seg.index;
      const store = panelCellFraming[edge];
      const isDraftPanel = cellFrameDraft?.edge === edge;
      // Hover highlight only on the focused panel while the Framing tool is armed under
      // the Unitized system, and only in the Panels tab (not the deeper Assembly zoom).
      const isHoverPanel =
        mullionsOn && cwType === "unitized" && focusedPanel === edge && focusedCell === null;
      // MATERIAL-ID / ORIENTATION views both tint every cell of every panel; when on we
      // always need the cell grid even if this panel has no framing/hover.
      const colorView = cellViewMode === "materialId";
      const orientView = cellViewMode === "orientation";
      // A draft can touch ANY panel (mirroring), so never early-out while one is live.
      if (!store && !cellFrameDraft && !(isHoverPanel && cellEdgeHover) && !colorView && !orientView)
        return d;
      const cells = cellsForEdge(edge);
      const framing: NonNullable<UnravelDraw["cellFraming"]> = [];
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        let ins = store?.[i];
        // Live drag preview: every cell whose SHAPE matches the dragged cell (same
        // Material ID), on this or any other panel, previews the same inset — so the
        // edit visibly mirrors across the whole project as the cursor moves.
        if (cellFrameDraft && draftKey !== null && cellShapeColors.keyOf(c) === draftKey) {
          const o = cellFrameDraft.offset;
          const base = ins ?? { top: 0, right: 0, bottom: 0, left: 0 };
          ins = cellFrameDraft.all
            ? { top: o, right: o, bottom: o, left: o }
            : { ...base, [cellFrameDraft.side]: o };
        }
        if (ins && (ins.top > 0 || ins.right > 0 || ins.bottom > 0 || ins.left > 0)) {
          framing.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, ...ins });
        }
      }
      let frameHover: UnravelDraw["frameHover"] = null;
      if (isDraftPanel && cellFrameDraft) {
        const c = cells[cellFrameDraft.cellIndex];
        if (c)
          frameHover = {
            x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1,
            side: cellFrameDraft.side, offset: cellFrameDraft.offset, all: cellFrameDraft.all,
          };
      } else if (isHoverPanel && cellEdgeHover) {
        const c = cells[cellEdgeHover.cellIndex];
        if (c)
          frameHover = {
            x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1,
            side: cellEdgeHover.side, offset: 0, all: false,
          };
      }
      // MATERIAL-ID tint: one entry per cell carrying its SHAPE colour index (the
      // renderer turns the index into a hue) and its SHADE fraction (identical cells
      // share the hue but fan out in saturation). Only built while the view is active.
      const cellColors: NonNullable<UnravelDraw["cellColors"]> | undefined = colorView
        ? cells.map((c) => ({
            x0: c.x0,
            x1: c.x1,
            y0: c.y0,
            y1: c.y1,
            colorIndex: cellShapeColors.indexOf(c),
            shade: cellShapeColors.shadeOf(edge, c),
          }))
        : undefined;
      // ORIENTATION HEATMAP: tint each cell by its panel's facing direction (heat
      // scalar t) and label it with the cardinal PLUS the live direct-sun incidence
      // (`sun`). All cells of a panel share the panel's outward-normal bearing — they
      // are the same wall plane — so both the colour and the sun reading are constant
      // across the grid; the sun reading is computed once per panel here. Panels with
      // no resolvable bearing (open polyline) are left untinted.
      const bearing = faceBearings[edge];
      const sunHit = bearing !== undefined ? sunHitLabel(bearing, activeSolar) : undefined;
      const cellOrient: NonNullable<UnravelDraw["cellOrient"]> | undefined =
        orientView && bearing !== undefined
          ? cells.map((c) => ({
              x0: c.x0,
              x1: c.x1,
              y0: c.y0,
              y1: c.y1,
              t: bearingToHeatT(bearing),
              label: bearingToCardinal8(bearing),
              sun: sunHit,
            }))
          : undefined;
      return {
        ...d,
        cellFraming: framing.length ? framing : undefined,
        frameHover,
        cellColors,
        cellOrient,
      };
    });
  }, [
    unravelDraws,
    panelCellFraming,
    cellFrameDraft,
    cellEdgeHover,
    mullionsOn,
    cwType,
    cellViewMode,
    cellShapeColors,
    faceBearings,
    activeSolar,
    focusedPanel,
    focusedCell,
    cellsForEdge,
  ]);

  /**
   * Pick the TOP-LEFT-most cell of a grid: the left-most column (minimum x), and
   * within that column the top-most row (maximum y, since model +Y points up).
   * Returns null for an empty grid.
   */
  const topLeftCell = useCallback(
    (cells: { x0: number; x1: number; y0: number; y1: number }[]) => {
      if (cells.length === 0) return null;
      return cells.reduce((best, c) => {
        if (c.x0 < best.x0 - 1e-6) return c; // strictly further left → take it
        if (c.x0 > best.x0 + 1e-6) return best; // strictly further right → keep best
        return c.y1 > best.y1 + 1e-6 ? c : best; // same column → prefer the higher (top) row
      });
    },
    [],
  );

  /** Has this panel been split by the Subtractive tool (vertical and/or horizontal)?
   *  Gates the Assembly button — there is nothing deeper to navigate until it has. */
  const panelHasSubtractiveCells = useCallback(
    (edge: number) => (panelDivisions[edge]?.length ?? 0) > 0 || (panelDividersH[edge]?.length ?? 0) > 0,
    [panelDivisions, panelDividersH],
  );

  /** Zoom the viewport to fit a single grid CELL (Assembly phase). Mirrors
   *  zoomToPanel but frames the cell's full rectangle (y0..y1, not baseline→top). */
  const zoomToCell = useCallback(
    (cell: { edge: number; x0: number; x1: number; y0: number; y1: number }) => {
      const { w, h } = sizeRef.current;
      // A throwaway 4-corner open perimeter of the cell rectangle, fed to the same
      // fit-to-bounds math; a comfortable margin so the cell fills the screen.
      const bounds: Perimeter = {
        vertices: [
          { x: cell.x0, y: cell.y0 },
          { x: cell.x1, y: cell.y0 },
          { x: cell.x1, y: cell.y1 },
          { x: cell.x0, y: cell.y1 },
        ],
        closed: false,
      };
      // Frame the cell with the shared fit-to-bounds math, then deliberately back
      // off to HALF that zoom. A tight cell fill loses all spatial context — at the
      // Assembly phase the user is reasoning about how a cell sits within its panel
      // and neighbors, so we intentionally show more of the surroundings. Halving
      // the scale (not just widening the margin) makes the cell appear ~half size
      // in a way that is predictable regardless of the cell's aspect ratio.
      const fit = fitViewport(bounds, w, h, 44);
      // Zoom about the canvas center (w/2, h/2) as a fixed screen anchor so the cell
      // stays centered while shrinking — same "anchor + (origin - anchor) * applied"
      // transform used by zoomAt() in core/viewport.ts, here with applied = 0.5.
      const factor = 0.5;
      const less = {
        scale: fit.scale * factor,
        originX: w / 2 + (fit.originX - w / 2) * factor,
        originY: h / 2 + (fit.originY - h / 2) * factor,
      };
      animateViewport(less);
      setFocusedCell(cell);
    },
    [animateViewport],
  );

  // Close EVERY drop-down / submenu (CW Type · Floor Lines · View · Statistics) in
  // one call. Used whenever a tool is armed or another menu opens, so only one menu
  // surface is ever open.
  const closeAllMenus = useCallback(() => {
    setCwMenuOpen(false);
    setViewMenuOpen(false);
    setStatsMenuOpen(false);
    // Arming any cluster tool (each calls this first) also disarms the Export-select
    // tool, so only one tool/mode is ever active. Re-armed last by toggleExportSelect.
    setExportSelectMode(false);
    setMarquee(null);
  }, []);

  // Disarm EVERY armed cluster tool (Floor plate · Centerlines · Eraser · Framing)
  // and drop their in-flight previews. Called when the user clicks ANY other button
  // so an armed tool never lingers (stays blue) while the user interacts elsewhere —
  // no canvas click or Esc required first.
  const disarmClusterTools = useCallback(() => {
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setEraseVertexCollected([]);
    setEraseEdgeCollected([]);
    setEraseEdge(-1);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    // Menu opens (which call this) also disarm the Export-select tool.
    setExportSelectMode(false);
    setMarquee(null);
  }, []);

  /**
   * Which panels does an export MARQUEE rectangle (model space) intersect? A panel
   * occupies [min(x0,x1), max(x0,x1)] on x and [0, height] on y; selection is a
   * standard AABB overlap test (touching counts). Returns the set of ORIGINAL edge
   * indices hit — empty when nothing overlaps or there's no unravel layout.
   */
  const panelsInMarquee = useCallback(
    (rect: { x0: number; y0: number; x1: number; y1: number }): Set<number> => {
      const out = new Set<number>();
      const segs = unravelResult?.segments;
      if (!segs) return out;
      const mx0 = Math.min(rect.x0, rect.x1);
      const mx1 = Math.max(rect.x0, rect.x1);
      const my0 = Math.min(rect.y0, rect.y1);
      const my1 = Math.max(rect.y0, rect.y1);
      for (const s of segs) {
        const px0 = Math.min(s.x0, s.x1);
        const px1 = Math.max(s.x0, s.x1);
        const py1 = Math.max(effectiveHeight(s.index), 0);
        // Non-overlap on either axis => not selected (panel base is y = 0).
        if (mx1 < px0 || mx0 > px1 || my1 < 0 || my0 > py1) continue;
        out.add(s.index);
      }
      return out;
    },
    [unravelResult, effectiveHeight],
  );

  /**
   * Toggle the Export selection tool. Arming it disarms every other tool / menu so
   * only one is active at a time; disarming clears any live marquee + selection.
   * (closeAllMenus / disarmClusterTools also clear exportSelectMode, so we re-arm it
   * LAST — the final write wins within React's batch.)
   */
  const toggleExportSelect = useCallback(() => {
    if (exportSelectMode) {
      setExportSelectMode(false);
      setMarquee(null);
      setExportSelection(new Set());
      return;
    }
    disarmClusterTools();
    closeAllMenus();
    setExportSelectMode(true);
  }, [exportSelectMode, disarmClusterTools, closeAllMenus]);

  // --- CW TYPE (curtain-wall system) + MULLIONS ---
  // "CW Type" opens a small two-option menu (Stick / Unitized). Picking one stores the
  // choice (relabelling the button to "CW Type: <name>") and unlocks the Mullions
  // tool. The curtain-wall system is a project-level spec, so the button is always
  // available — it is NOT gated on a selected panel.
  const onCwType = useCallback(() => {
    setCwMenuOpen((open) => !open);
    setViewMenuOpen(false);
    setStatsMenuOpen(false);
    disarmClusterTools();
  }, [disarmClusterTools]);
  /**
   * Assign curtain-wall system `t` to the FOCUSED panel. Because a panel may carry only
   * one system, switching to a DIFFERENT type clears that panel's framing of the other
   * system — Stick mullion bands (panelMullionsV/H) when switching to Unitized, Unitized
   * cell insets (panelCellFraming) when switching to Stick — while KEEPING its
   * centerlines (panelDivisions / panelDividersH). No-op if the panel already has `t`.
   * One undoable step. Requires a focused panel (the button is disabled otherwise).
   */
  const selectCwType = useCallback(
    (t: CwType) => {
      setCwMenuOpen(false);
      if (focusedPanel !== null) {
        // Apply to the focused panel only.
        const edge = focusedPanel;
        // Auto-arm the Centerlines tool: choosing a CW system makes placing centerlines
        // the natural next step, so the button turns blue/armed immediately and the user
        // doesn't have to click it. (The CW menu already disarmed the other cluster tools,
        // so no mutual-exclusion conflict; restore centerline visibility like onSubtractive.)
        setCenterlinesVisible(true);
        setSubtractiveOn(true);
        if (panelCwType[edge] === t) return; // already this system — nothing else to change
        recordHistory();
        setPanelCwType((prev) => ({ ...prev, [edge]: t }));
        // Drop the now-incompatible framing for this panel (centerlines are untouched).
        if (t === "unitized") {
          setPanelMullionsV((prev) => {
            if (prev[edge] === undefined) return prev;
            const next = { ...prev }; delete next[edge]; return next;
          });
          setPanelMullionsH((prev) => {
            if (prev[edge] === undefined) return prev;
            const next = { ...prev }; delete next[edge]; return next;
          });
        } else {
          setPanelCellFraming((prev) => {
            if (prev[edge] === undefined) return prev;
            const next = { ...prev }; delete next[edge]; return next;
          });
        }
      } else {
        // No panel focused — apply to every panel in the current perimeter.
        const segs = unravelPerimeter(perimeter, unravelGap).segments;
        if (segs.length === 0) return;
        recordHistory();
        setPanelCwType((prev) => {
          const next = { ...prev };
          for (const seg of segs) next[seg.index] = t;
          return next;
        });
        if (t === "unitized") {
          setPanelMullionsV((prev) => {
            const next = { ...prev };
            for (const seg of segs) delete next[seg.index];
            return next;
          });
          setPanelMullionsH((prev) => {
            const next = { ...prev };
            for (const seg of segs) delete next[seg.index];
            return next;
          });
        } else {
          setPanelCellFraming((prev) => {
            const next = { ...prev };
            for (const seg of segs) delete next[seg.index];
            return next;
          });
        }
      }
      // Drop any in-flight framing previews so a stale draft can't re-apply the old type.
      setMullionHover(null);
      setMullionDraft(null);
      setCellEdgeHover(null);
      setCellFrameDraft(null);
    },
    [focusedPanel, panelCwType, recordHistory, perimeter],
  );

  // MULLIONS: becomes available only once a CW Type is chosen. Mutually exclusive with
  // every other tool in the cluster (arming it disarms Floor plate / Centerlines /
  // Eraser and drops their in-flight previews). The actual mullion placement is an
  // intentional TODO stub — wired so the gated button exists and has a clear home.
  const onMullions = useCallback(() => {
    if (cwType === null) return; // disabled in the UI, but guard anyway
    // Arming a tool whose drawn elements are hidden makes no sense — restore visibility
    // so the user always sees what they're editing (mirrors the Floor Lines button).
    setFramingVisible(true);
    closeAllMenus();
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setTypeOn(false);
    setMullionsOn((on) => {
      if (on) {
        // Toggling off: drop the hover highlight + any in-flight drag preview.
        setMullionHover(null);
        setMullionDraft(null);
        setCellEdgeHover(null);
        setCellFrameDraft(null);
      }
      return !on;
    });
  }, [cwType, closeAllMenus]);

  // TYPE: a SCAFFOLDED cluster tool (no canvas behaviour yet). Becomes available only
  // once the focused panel carries at least one frame (gated by `canType` in the UI).
  // Mutually exclusive with every other cluster tool — arming it disarms the rest and
  // drops their in-flight previews — and turns blue while armed like the others. The
  // actual "type" assignment/render is an intentional TODO stub.
  const onType = useCallback(() => {
    if (focusedPanel === null) return; // disabled in the UI, but guard anyway
    // Restore visibility on click so an armed tool's elements are always shown (mirrors
    // the Floor Lines button).
    setTypeVisible(true);
    closeAllMenus();
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn((on) => !on);
  }, [focusedPanel, closeAllMenus]);

  /** Interior GRID-LINE positions of a panel (the lines the Mullions tool targets):
   *  vertical = equal-cell splits + Subtractive divisions (model x); horizontal =
   *  Subtractive dividers strictly inside the panel (model y from the baseline). */
  const gridLinesForEdge = useCallback(
    (edge: number): { vx: number[]; hy: number[] } => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      if (!seg) return { vx: [], hy: [] };
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      const height = effectiveHeight(edge);
      const vx: number[] = [];
      const nCells = Math.max(1, Math.round(unravelCells[edge] ?? 1));
      for (let k = 1; k < nCells; k++) vx.push(lo + (hi - lo) * (k / nCells));
      for (const off of panelDivisions[edge] ?? []) vx.push(seg.x0 + off);
      const hy: number[] = [];
      for (const off of panelDividersH[edge] ?? []) if (off > 0 && off < height) hy.push(off);
      return { vx, hy };
    },
    [unravelResult, effectiveHeight, unravelCells, panelDivisions, panelDividersH],
  );

  /** The interior grid line of `edge` NEAREST the model point, within hit tolerance,
   *  as which AXIS its set belongs to + the grabbed line's coordinate (x for vertical,
   *  y for horizontal). Used by the Mullions tool to start a drag. Null when none. */
  const nearestGridLine = useCallback(
    (mu: Point, edge: number): { axis: "v" | "h"; coord: number } | null => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      if (!seg) return null;
      const tol = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      const height = effectiveHeight(edge);
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      const { vx, hy } = gridLinesForEdge(edge);
      let best: { axis: "v" | "h"; coord: number; d: number } | null = null;
      if (mu.y >= -tol && mu.y <= height + tol) {
        for (const x of vx) {
          const d = Math.abs(mu.x - x);
          if (d <= tol && (!best || d < best.d)) best = { axis: "v", coord: x, d };
        }
      }
      if (mu.x >= lo - tol && mu.x <= hi + tol) {
        for (const y of hy) {
          const d = Math.abs(mu.y - y);
          if (d <= tol && (!best || d < best.d)) best = { axis: "h", coord: y, d };
        }
      }
      return best ? { axis: best.axis, coord: best.coord } : null;
    },
    [unravelResult, viewport, effectiveHeight, gridLinesForEdge],
  );

  /** The CELL of `edge` the cursor is over, and which of that cell's four edges is
   *  NEAREST the cursor (within hit tolerance), for the UNITIZED Framing tool. The
   *  cursor's containing cell wins (so the offset goes INTO the cell the cursor is in),
   *  and only fires when actually near one of that cell's edges (a centerline / border)
   *  so it reads as "mousing over the centerlines". Null when not near any cell edge. */
  const nearestCellEdge = useCallback(
    (
      mu: Point,
      edge: number,
    ): { cellIndex: number; side: "top" | "right" | "bottom" | "left"; cell: { x0: number; x1: number; y0: number; y1: number } } | null => {
      const cells = cellsForEdge(edge);
      if (cells.length === 0) return null;
      const tol = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      // Containing cell: prefer a STRICT hit (cursor's actual cell), then fall back to a
      // tolerant hit so a cursor parked just outside a border edge still resolves.
      let ci = cells.findIndex((c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1);
      if (ci < 0)
        ci = cells.findIndex(
          (c) => mu.x >= c.x0 - tol && mu.x <= c.x1 + tol && mu.y >= c.y0 - tol && mu.y <= c.y1 + tol,
        );
      if (ci < 0) return null;
      const c = cells[ci];
      const dists: Array<["top" | "right" | "bottom" | "left", number]> = [
        ["top", Math.abs(mu.y - c.y1)],
        ["bottom", Math.abs(mu.y - c.y0)],
        ["left", Math.abs(mu.x - c.x0)],
        ["right", Math.abs(mu.x - c.x1)],
      ];
      dists.sort((a, b) => a[1] - b[1]);
      const [side, d] = dists[0];
      if (d > tol) return null;
      return { cellIndex: ci, side, cell: c };
    },
    [cellsForEdge, viewport],
  );

  /** Inward inset (feet) of `side` of `cell` for the cursor model point, clamped to the
   *  cell's perpendicular span and snapped to the framing step (0.25′). Dragging toward
   *  the cell interior grows the inset; dragging back out clamps it to 0. */
  const cellInsetForPoint = useCallback(
    (mu: Point, cell: { x0: number; x1: number; y0: number; y1: number }, side: "top" | "right" | "bottom" | "left") => {
      let raw: number;
      let span: number;
      if (side === "top") {
        raw = cell.y1 - mu.y;
        span = cell.y1 - cell.y0;
      } else if (side === "bottom") {
        raw = mu.y - cell.y0;
        span = cell.y1 - cell.y0;
      } else if (side === "left") {
        raw = mu.x - cell.x0;
        span = cell.x1 - cell.x0;
      } else {
        raw = cell.x1 - mu.x;
        span = cell.x1 - cell.x0;
      }
      const snapped = Math.round(raw / MULLION_STEP) * MULLION_STEP;
      return Math.max(0, Math.min(span, snapped));
    },
    [],
  );

  // FLOOR PLATE: arm the elevation floor-plate placement tool. Mutually exclusive
  // with the panel tools — arming it disarms Subtractive / Eraser and drops their
  // in-flight previews so only one tool in the cluster is ever active. Re-click
  // toggles it back off (the panel tools are already off then, so the clears are
  // harmless no-ops).
  const onFloorPlate = useCallback(() => {
    closeAllMenus();
    setFloorPlateMode((on) => {
      if (!on) {
        setSubtractiveOn(false);
        setDivideHover(null);
        setDivideDraft(null);
        setEraserOn(false);
        setEraseHover(null);
        setMullionsOn(false);
        setMullionHover(null);
        setMullionDraft(null);
        setCellEdgeHover(null);
        setCellFrameDraft(null);
        setTypeOn(false);
      }
      return !on;
    });
  }, [closeAllMenus]);
  // "Floor Lines" button — arm/disarm the placement tool directly (single-function
  // button, no submenu). onFloorPlate already closes the other menus and enforces
  // cluster mutual-exclusion; we also ensure floor lines are VISIBLE (placing lines you
  // can't see makes no sense).
  const onFloorPlace = useCallback(() => {
    setFloorLinesVisible(true);
    onFloorPlate();
  }, [onFloorPlate]);
  // SUBTRACTIVE: arm the panel-division tool for the selected panel. Toggling it
  // off (or deselecting / Esc) clears any in-flight preview. The actual placement
  // happens in the pointer handlers (hover preview + click/drag commit).
  const onSubtractive = useCallback(() => {
    if (focusedPanel === null) return; // disabled in the UI, but guard anyway
    // Restore visibility on click so the centerlines are always shown while editing them
    // (mirrors the Floor Lines button).
    setCenterlinesVisible(true);
    closeAllMenus();
    // Mutually exclusive with the rest of the cluster: arming Subtractive disarms
    // the Floor plate tool and the Eraser and drops their previews (clicking
    // Subtractive while it's already on toggles it off — the others are already
    // off then, so these are harmless no-ops).
    setFloorPlateMode(false);
    setEraserOn(false);
    setEraseHover(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    setSubtractiveOn((on) => {
      if (on) {
        setDivideHover(null);
        setDivideDraft(null);
      }
      return !on;
    });
  }, [focusedPanel, closeAllMenus]);

  // ERASER: arm the line-DELETION tool for the selected panel — the destructive
  // counterpart to Subtractive. Toggling it off (or deselecting / Esc / leaving
  // the view) clears the in-flight deletion highlight. The actual removal happens
  // in the pointer handlers (hover targets the nearest line; a click deletes it).
  const onEraser = useCallback(() => {
    // No focusedPanel guard — eraser also targets floor plates (global, no panel needed).
    closeAllMenus();
    // Mutually exclusive with the rest of the cluster: arming it disarms Floor plate
    // and Subtractive and drops their previews so no two tools ever fight.
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    setEraserOn((on) => {
      // Disarming drops the unravel line highlight AND the perimeter vertex
      // hover (in Draw mode the move handler won't reset it otherwise).
      if (on) {
        setEraseHover(null);
        setHoveredVertex(-1);
        setEraseVertexCollected([]);
        setEraseEdgeCollected([]);
        setEraseEdge(-1);
      }
      return !on;
    });
  }, [closeAllMenus]);

  /**
   * "View" button — toggles its dropdown menu of CELL VIEW MODES. It arms no tool and
   * changes no document state (purely a display chooser), but like every other button
   * it DISARMS any armed cluster tool so a tool never lingers (blue) when the user
   * interacts elsewhere.
   */
  const onViewMenu = useCallback(() => {
    setViewMenuOpen((open) => !open);
    setCwMenuOpen(false);
    setStatsMenuOpen(false);
    disarmClusterTools();
  }, [disarmClusterTools]);
  /** Pick a display mode from the View menu (closes the menu). */
  const selectViewMode = useCallback((m: CellViewMode) => {
    setCellViewMode(m);
    setViewMenuOpen(false);
  }, []);

  /**
   * Find the division line on the focused panel NEAREST the cursor, within
   * ERASE_SNAP_PX. Considers both VERTICAL divisions (panelDivisions, stored as
   * x-offsets from seg.x0) and HORIZONTAL dividers (panelDividersH, stored as
   * y-offsets from the baseline). Returns the closest target, or null if none is
   * within tolerance. Mirrors the floor-plate snap distance pattern (model-space
   * tolerance from `pixelsToModel`, so it feels the same at any zoom).
   */
  const eraseTargetsNear = useCallback(
    (m: Point): Array<{ t: EraseTarget; d: number }> => {
      const tolModel = pixelsToModel(viewport, ERASE_SNAP_PX);
      const out: Array<{ t: EraseTarget; d: number }> = [];

      // Panel division lines (vertical / horizontal) on EVERY panel — no panel needs to
      // be focused first. Each line is bounded to its own panel's rectangle, so the
      // cursor must be within that panel's body (x within [x0,x1], y within [0,height])
      // for its lines to be candidates — that keeps a horizontal divider's y from
      // matching across the whole row of panels in the Elevations strip.
      for (const seg of unravelResult?.segments ?? []) {
        const lo = Math.min(seg.x0, seg.x1);
        const hi = Math.max(seg.x0, seg.x1);
        const height = effectiveHeight(seg.index);
        const inX = m.x >= lo - tolModel && m.x <= hi + tolModel;
        const inY = m.y >= -tolModel && m.y <= height + tolModel;
        if (inY) {
          const vs = panelDivisions[seg.index] ?? [];
          for (let i = 0; i < vs.length; i++) {
            const d = Math.abs(m.x - (seg.x0 + vs[i]));
            if (d <= tolModel) out.push({ t: { edge: seg.index, axis: "v", index: i }, d });
          }
        }
        if (inX) {
          const hs = panelDividersH[seg.index] ?? [];
          for (let i = 0; i < hs.length; i++) {
            const d = Math.abs(m.y - hs[i]);
            if (d <= tolModel) out.push({ t: { edge: seg.index, axis: "h", index: i }, d });
          }
        }
      }

      // Floor plates — global, no panel selection required. The ground datum (model
      // y ≈ 0, level 0) is a PERMANENT line and is never an erase candidate.
      for (let i = 0; i < floorPlates.length; i++) {
        if (Math.abs(floorPlates[i]) <= 1e-6) continue; // ground plate: undeletable
        const d = Math.abs(m.y - floorPlates[i]);
        if (d <= tolModel) out.push({ t: { edge: -1, axis: "fp", index: i }, d });
      }

      return out;
    },
    [unravelResult, viewport, effectiveHeight, panelDivisions, panelDividersH, floorPlates],
  );

  /** The single erasable line nearest the cursor (within tolerance), for the hover
   *  highlight. Derived from {@link eraseTargetsNear}. */
  const nearestEraseLine = useCallback(
    (m: Point): EraseTarget | null => {
      let best: EraseTarget | null = null;
      let bestDist = Infinity;
      for (const { t, d } of eraseTargetsNear(m)) {
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
      return best;
    },
    [eraseTargetsNear],
  );

  /** A stable string key for an erase target (for dedupe across a drag stroke). */
  const eraseKey = (t: EraseTarget) => `${t.axis}:${t.edge}:${t.index}`;

  /** Collect EVERY erasable line the cursor sweeps over moving from `a` to `b`, so a
   *  fast drag never skips lines between two sampled pointer events. Samples the path
   *  at ~half the hit tolerance and unions all targets within tolerance of each sample
   *  into `collected` (deduped by key). Returns the (possibly unchanged) array. */
  const collectEraseAlong = useCallback(
    (a: Point, b: Point, collected: EraseTarget[]): EraseTarget[] => {
      const seen = new Set(collected.map(eraseKey));
      const result = [...collected];
      const stepModel = Math.max(pixelsToModel(viewport, ERASE_SNAP_PX / 2), 1e-6);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / stepModel));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        for (const { t } of eraseTargetsNear(p)) {
          const k = eraseKey(t);
          if (!seen.has(k)) {
            seen.add(k);
            result.push(t);
          }
        }
      }
      return result;
    },
    [viewport, eraseTargetsNear],
  );

  /** Collect EVERY perimeter VERTEX the cursor sweeps over moving from `a` to `b`, so
   *  the Erase drag never skips a vertex between two sampled pointer events. Samples the
   *  path at ~half the hit tolerance and unions any vertex within tolerance into
   *  `collected` (deduped by index). Indices stay valid through the drag because the
   *  perimeter is only mutated on the pointer-up commit. Returns the (possibly
   *  unchanged) array. */
  const collectVerticesAlong = useCallback(
    (a: Point, b: Point, collected: number[]): number[] => {
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      const seen = new Set(collected);
      const result = [...collected];
      const stepModel = Math.max(pixelsToModel(viewport, HIT_TOLERANCE_PX / 2), 1e-6);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / stepModel));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const vi = hitVertex(perimeter, p, tolModel);
        if (vi >= 0 && !seen.has(vi)) {
          seen.add(vi);
          result.push(vi);
        }
      }
      return result;
    },
    [viewport, perimeter],
  );

  /** Collect every perimeter EDGE the cursor sweeps over moving from `a` to `b`, so a
   *  fast Erase drag never skips a segment between two sampled pointer events. Mirrors
   *  collectVerticesAlong but hit-tests segments (hitSegment). Works on both open and
   *  closed perimeters. Indices stay valid through the drag (the perimeter is mutated
   *  only on the commit). */
  const collectEdgesAlong = useCallback(
    (a: Point, b: Point, collected: number[]): number[] => {
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      const seen = new Set(collected);
      const result = [...collected];
      const stepModel = Math.max(pixelsToModel(viewport, HIT_TOLERANCE_PX / 2), 1e-6);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / stepModel));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        // Vertices win over edges: don't collect an edge where a corner is the target.
        if (hitVertex(perimeter, p, tolModel) >= 0) continue;
        const seg = hitSegment(perimeter, p, tolModel);
        if (seg && !seen.has(seg.index)) {
          seen.add(seg.index);
          result.push(seg.index);
        }
      }
      return result;
    },
    [viewport, perimeter],
  );

  /** Reset a panel's framing (mullion) offset for one axis to none, so newly added
   *  centerlines never inherit an existing offset — the user re-applies framing after
   *  placing them. A no-op (same reference) when there was no offset. */
  const clearPanelMullion = useCallback((edge: number, axis: "v" | "h") => {
    const setter = axis === "v" ? setPanelMullionsV : setPanelMullionsH;
    setter((prev) => {
      if (prev[edge] === undefined) return prev;
      const next = { ...prev };
      delete next[edge];
      return next;
    });
    // The UNITIZED per-cell framing is keyed by cell INDEX, which shifts whenever the
    // panel's grid changes — so adding/removing centerlines also drops this panel's
    // cell framing. The user re-applies framing on the new cells (same as Stick).
    setPanelCellFraming((prev) => {
      if (prev[edge] === undefined) return prev;
      const next = { ...prev };
      delete next[edge];
      return next;
    });
  }, []);

  /** Commit all lines collected during an erase drag stroke as a single undoable
   *  step. Groups targets by (edge, axis) and removes them with one filter pass
   *  per array, so indices captured during the drag remain valid (arrays are only
   *  modified AFTER the loop). */
  const commitEraseLines = useCallback(
    (targets: EraseTarget[]) => {
      if (targets.length === 0) return;
      recordHistory();
      // Group by axis so each state array is filtered in one pass.
      const vByEdge = new Map<number, Set<number>>();
      const hByEdge = new Map<number, Set<number>>();
      const fpIndices = new Set<number>();
      for (const t of targets) {
        if (t.axis === "v") {
          if (!vByEdge.has(t.edge)) vByEdge.set(t.edge, new Set());
          vByEdge.get(t.edge)!.add(t.index);
        } else if (t.axis === "h") {
          if (!hByEdge.has(t.edge)) hByEdge.set(t.edge, new Set());
          hByEdge.get(t.edge)!.add(t.index);
        } else {
          fpIndices.add(t.index);
        }
      }
      if (vByEdge.size > 0) {
        setPanelDivisions((prev) => {
          const next = { ...prev };
          for (const [edge, indices] of vByEdge) {
            next[edge] = (prev[edge] ?? []).filter((_, i) => !indices.has(i));
          }
          return next;
        });
        // Removing centerlines changes the grid, so the panel's framing no longer maps
        // to it — drop it (same invariant the add path enforces via commitDivisions), or
        // the frame bars would linger along the border with their centerlines gone.
        for (const edge of vByEdge.keys()) clearPanelMullion(edge, "v");
      }
      if (hByEdge.size > 0) {
        setPanelDividersH((prev) => {
          const next = { ...prev };
          for (const [edge, indices] of hByEdge) {
            next[edge] = (prev[edge] ?? []).filter((_, i) => !indices.has(i));
          }
          return next;
        });
        for (const edge of hByEdge.keys()) clearPanelMullion(edge, "h");
      }
      if (fpIndices.size > 0) {
        // The ground datum (model y ≈ 0, level 0) is permanent — never remove it even
        // if its index somehow got collected.
        setFloorPlates((plates) =>
          plates.filter((p, i) => !(fpIndices.has(i) && Math.abs(p) > 1e-6)),
        );
      }
    },
    [recordHistory, clearPanelMullion],
  );

  /** Commit a set of division-line MODEL-x positions onto a panel as stored OFFSETS
   *  (relative to the panel's left edge x0), merged with any existing ones,
   *  de-duplicated to the grid, and sorted. One undoable step. */
  const commitDivisions = useCallback(
    (edge: number, x0: number, xs: number[]) => {
      if (xs.length === 0) return;
      recordHistory();
      setPanelDivisions((prev) => {
        const existing = prev[edge] ?? [];
        const merged = [...existing, ...xs.map((x) => x - x0)];
        // De-dup at ~0.01 ft so a click on an existing line never stacks duplicates.
        const unique: number[] = [];
        for (const off of merged.sort((a, b) => a - b)) {
          if (unique.length === 0 || Math.abs(off - unique[unique.length - 1]) > 0.01) unique.push(off);
        }
        return { ...prev, [edge]: unique };
      });
      // Adding vertical centerlines RESETS this panel's vertical framing offset, so
      // new lines never inherit an offset — the user re-applies framing afterwards.
      clearPanelMullion(edge, "v");
    },
    [recordHistory, clearPanelMullion],
  );

  /** Commit a set of HORIZONTAL divider MODEL-y positions onto a panel as stored
   *  OFFSETS from the baseline (y = 0, so the offsets ARE the y-values), merged with
   *  any existing ones, de-duplicated to the grid, and sorted. One undoable step.
   *  The horizontal mirror of {@link commitDivisions}. */
  const commitDividersH = useCallback(
    (edge: number, ys: number[]) => {
      if (ys.length === 0) return;
      recordHistory();
      setPanelDividersH((prev) => {
        const existing = prev[edge] ?? [];
        // Baseline is y = 0, so a position's offset from the baseline IS its y-value.
        const merged = [...existing, ...ys];
        // De-dup at ~0.01 ft so a click on an existing line never stacks duplicates.
        const unique: number[] = [];
        for (const off of merged.sort((a, b) => a - b)) {
          if (unique.length === 0 || Math.abs(off - unique[unique.length - 1]) > 0.01) unique.push(off);
        }
        return { ...prev, [edge]: unique };
      });
      // Adding horizontal centerlines RESETS this panel's horizontal framing offset.
      clearPanelMullion(edge, "h");
    },
    [recordHistory, clearPanelMullion],
  );


  /**
   * Frame the unravelled rectangle strip in the viewport (fit-to-bounds, reusing
   * fitViewport). The bounds include each rectangle's OWN top (per-panel height),
   * so the TALLEST panel is framed and nothing is clipped. Defined here (before the
   * keyboard effect) so the Esc handler can call it to exit a double-click zoom.
   */
  const fitUnravel = useCallback(
    (gap: number, heights: Record<number, number>, defaultHeight: number) => {
      const res = unravelPerimeter(perimeter, gap);
      if (res.segments.length === 0) return;
      const { w, h } = sizeRef.current;
      const heightOf = (s: UnravelSegment) => heights[s.index] ?? defaultHeight;
      // Generous margin so the per-segment length labels above the strip fit.
      // Animate so exiting a double-click zoom (Esc) eases back out smoothly.
      animateViewport(fitViewport(unravelBoundsPerimeter(res.segments, heightOf), w, h, 48));
    },
    [perimeter, animateViewport],
  );

  // ---------------------------------------------------------------------------
  // POINTER HANDLERS
  // ---------------------------------------------------------------------------

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current!;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // A press means the user is taking over: stop any running zoom animation
      // so it doesn't fight their input.
      cancelAnim();

      // Any press on the canvas dismisses an open Statistics / CW Type / View menu.
      if (statsMenuOpen) setStatsMenuOpen(false);
      if (cwMenuOpen) setCwMenuOpen(false);
      if (viewMenuOpen) setViewMenuOpen(false);

      // FLOOR PLATE tool: while armed, a left-click drops a horizontal level line
      // at the cursor's elevation (or removes one already there). Takes precedence
      // over draw/edit. Other buttons (middle = pan) fall through unaffected.
      if (floorPlateMode && e.button === 0) {
        const mu = toModel(viewport, sx, sy);
        // Apply the increment magnet (or grid fallback / Shift-bypass) — the SAME
        // helper the preview uses, so the dropped plate lands exactly where the
        // ghost line showed. Removal-by-click still wins below (deletes any plate
        // within tolerance of this snapped elevation).
        const yModel = snapFloorPlateY(mu.y);
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        recordHistory(); // place/remove is one undoable step
        setFloorPlates((plates) => {
          const hit = plates.findIndex((p) => Math.abs(p - yModel) <= tolModel);
          // Click on an existing plate removes it; otherwise add a new one (kept
          // sorted bottom→top for tidy iteration). EXCEPTION: the ground plate
          // (model y ≈ 0, level 0) is a permanent datum — never remove it, so a
          // click at/near the baseline is a no-op rather than deleting the 0′ line.
          if (hit >= 0) {
            if (Math.abs(plates[hit]) <= 1e-6) return plates; // ground datum is permanent
            return plates.filter((_, i) => i !== hit);
          }
          return [...plates, yModel].sort((a, b) => a - b);
        });
        return;
      }

      // RIGHT button pans (touchpads have no middle button).
      if (e.button === 2) {
        dragRef.current = { kind: "pan", lastX: sx, lastY: sy, button: 2, moved: false };
        return;
      }
      // Middle button or space-less: pan with middle mouse.
      if (e.button === 1) {
        dragRef.current = { kind: "pan", lastX: sx, lastY: sy, button: 1, moved: false };
        return;
      }
      if (e.button !== 0) return;
      // Unravel view: left-click does not draw/edit, but the TOP edge of a
      // rectangle can be dragged to stretch THAT panel's height.
      if (unravelOn) {
        const mu = toModel(viewport, sx, sy); // raw model point (no draw snap/constrain)
        // EXPORT tool armed: start a selection MARQUEE instead of any tool / resize /
        // navigation. The drag sweeps a box that selects the panels it intersects.
        if (exportSelectMode) {
          dragRef.current = { kind: "marquee", startModel: mu };
          setMarquee({ x0: mu.x, y0: mu.y, x1: mu.x, y1: mu.y });
          setExportSelection(new Set()); // a fresh sweep clears the prior selection
          canvasRef.current?.setPointerCapture(e.pointerId);
          return;
        }
        // SUBTRACTIVE division tool: while armed, a press on the SELECTED panel
        // commits an EQUAL-COLUMN split — the same even subdivision the hover
        // recommendation previews (N equal-width columns chosen by the cursor's
        // position). Owns the click — no height resize or deselect happens.
        if (subtractiveOn && focusedPanel !== null) {
          const clickedEdge = hitUnravelPanel(mu);
          // A press on the SELECTED panel commits the equal split.
          const seg = clickedEdge === focusedPanel ? unravelResult?.segments.find((s) => s.index === focusedPanel) : undefined;
          if (seg) {
            beginHistory(); // pushed on commit (pointer-up)
            dragRef.current = { kind: "divide", edge: focusedPanel };
            setDivideHover(null);
            // Shift flips the split axis: HORIZONTAL equal-height rows (from the
            // cursor's distance above the baseline) instead of VERTICAL equal-width
            // columns. Both use the SAME pure generators as the live preview/commit.
            if (shiftHeld) {
              const panelH = effectiveHeight(focusedPanel);
              // Floor plates crossing the panel act as guides the rows snap to.
              setDivideDraft({ edge: focusedPanel, axis: "h", lines: buildEqualRows(mu.y, 0, panelH, floorPlates) });
            } else {
              setDivideDraft({ edge: focusedPanel, axis: "v", lines: buildEqualColumns(mu.x, seg.x0, seg.x1) });
            }
          } else if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
            // QoL: a press on a DIFFERENT wall border reframes to it with the tool
            // STILL armed — the user can pan/zoom to another border and keep editing
            // without disarming, reselecting the border, and re-arming. Debounced like
            // the layer-nav drill so a habitual double-click jumps only once.
            const now = performance.now();
            if (now - lastDrillRef.current >= DRILL_COOLDOWN_MS) {
              lastDrillRef.current = now;
              zoomToPanel(clickedEdge);
            }
          } else if (clickedEdge < 0) {
            // A press on the empty WHITE canvas (no panel under the cursor) DISARMS the
            // Centerlines tool — its dedicated deselect gesture. Presses ON a panel keep
            // every behaviour above (commit split / reframe); only blank canvas deselects.
            setSubtractiveOn(false);
            setDivideHover(null);
            setDivideDraft(null);
          }
          return; // armed tool consumes the press regardless of where it landed
        }
        // ERASER tool: start a drag stroke that accumulates lines to delete. The
        // initial press captures whatever is under the cursor; moving over more
        // lines while the button is held adds them to the set; pointer-up commits
        // all of them as one undoable step. Owns the press — no height resize or
        // deselect happens.
        if (eraserOn) {
          // Collect EVERY line under the press (not just the nearest) so a click that
          // lands where lines overlap removes all of them.
          const initial = eraseTargetsNear(mu).map(({ t }) => t);
          dragRef.current = { kind: "erase", collected: initial, last: mu };
          setEraseDragCollected(initial);
          setEraseHover(null);
          canvasRef.current?.setPointerCapture(e.pointerId);
          return; // armed tool consumes the press regardless of where it landed
        }
        // MULLIONS tool (Stick system): grab a grid line and drag to set the mullion
        // half-width offset (to EITHER side) for that whole axis on the focused panel.
        // Snapped to 0.25′ on move; committed on pointer-up. Owns the press.
        if (mullionsOn && cwType === "stick" && focusedPanel !== null) {
          const hit = nearestGridLine(mu, focusedPanel);
          if (hit) {
            beginHistory(); // pushed on first change (pointer-up commit)
            dragRef.current = { kind: "mullion", edge: focusedPanel, axis: hit.axis, ref: hit.coord };
            const cur = (hit.axis === "v" ? panelMullionsV : panelMullionsH)[focusedPanel] ?? 0;
            setMullionDraft({ edge: focusedPanel, axis: hit.axis, offset: cur });
          } else {
            // QoL: not near a grid line of THIS panel — a press on a DIFFERENT wall
            // border reframes to it with the Framing tool STILL armed, so the user can
            // move between borders and keep editing without disarming/reselecting.
            const clickedEdge = hitUnravelPanel(mu);
            if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
              const now = performance.now();
              if (now - lastDrillRef.current >= DRILL_COOLDOWN_MS) {
                lastDrillRef.current = now;
                zoomToPanel(clickedEdge);
              }
            } else if (clickedEdge < 0) {
              // A press on the empty WHITE canvas (no panel) DISARMS the Framing tool —
              // its dedicated deselect gesture. Presses on a panel keep the behaviours
              // above; only blank canvas deselects.
              setMullionsOn(false);
              setMullionHover(null);
              setMullionDraft(null);
              setCellEdgeHover(null);
              setCellFrameDraft(null);
            }
          }
          return; // armed tool consumes the press regardless of where it landed
        }
        // FRAMING tool (Unitized system): grab the nearest edge of the cell under the
        // cursor and drag to set that edge's inward inset (into the cell) in 0.25′ steps.
        // Holding Shift offsets all four edges of the cell together. Panels tab only
        // (focusedPanel set, not the deeper Assembly cell zoom). Owns the press.
        if (mullionsOn && cwType === "unitized" && focusedPanel !== null && focusedCell === null) {
          const hit = nearestCellEdge(mu, focusedPanel);
          if (hit) {
            beginHistory(); // pushed on first change (pointer-up commit)
            const all = e.shiftKey;
            dragRef.current = {
              kind: "cellframe",
              edge: focusedPanel,
              cellIndex: hit.cellIndex,
              side: hit.side,
              cell: hit.cell,
              all,
            };
            const cur = panelCellFraming[focusedPanel]?.[hit.cellIndex];
            const startOffset = cur ? cur[hit.side] : 0;
            setCellFrameDraft({
              edge: focusedPanel,
              cellIndex: hit.cellIndex,
              side: hit.side,
              offset: startOffset,
              all,
            });
          } else {
            // QoL: not near a cell edge of THIS panel — a press on a DIFFERENT wall
            // border reframes to it with the Framing tool STILL armed, so the user can
            // move between borders and keep editing without disarming/reselecting.
            const clickedEdge = hitUnravelPanel(mu);
            if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
              const now = performance.now();
              if (now - lastDrillRef.current >= DRILL_COOLDOWN_MS) {
                lastDrillRef.current = now;
                zoomToPanel(clickedEdge);
              }
            } else if (clickedEdge < 0) {
              // A press on the empty WHITE canvas (no panel) DISARMS the Framing tool —
              // its dedicated deselect gesture. Presses on a panel keep the behaviours
              // above; only blank canvas deselects.
              setMullionsOn(false);
              setMullionHover(null);
              setMullionDraft(null);
              setCellEdgeHover(null);
              setCellFrameDraft(null);
            }
          }
          return; // armed tool consumes the press regardless of where it landed
        }
        const edge = hitUnravelTop(mu);
        if (edge >= 0) {
          beginHistory(); // capture pre-resize state; pushed on first drag move
          dragRef.current = { kind: "unravelHeight", edge };
          setHoveredUnravelTop(edge);
          return;
        }
        // LAYER NAVIGATION (single click). A single left-click is the ONE gesture that
        // moves between layers, both directions:
        //   • click ON a panel/cell  -> drill exactly ONE layer DEEPER
        //       Elevations -> Panels (zoom the clicked panel)
        //       Panels     -> Assembly (zoom the clicked cell of a SPLIT panel)
        //       Assembly   -> the cell under the cursor (keep going cell by cell)
        //     ...except when already focused on a panel (Panels/Assembly): clicking a
        //     DIFFERENT panel switches focus straight to it, no back-out click needed.
        //   • click on the empty WHITE canvas -> step ONE layer BACK, deepest-first
        //       Assembly -> Panels, Panels -> Elevations, Elevations -> stays put
        //       (only the Perimeter TAB returns to the footprint).
        // "Empty canvas" = the click landed on no panel rectangle (hit-test === -1).
        if (hitUnravelPanel(mu) === -1) {
          if (focusedCell !== null && focusedPanel !== null) {
            setFocusedCell(null);
            zoomToPanel(focusedPanel);
          } else if (focusedPanel !== null) {
            setFocusedPanel(null);
            fitUnravel(unravelGap, unravelHeights, unravelHeight);
          }
          return;
        }
        // Click landed ON a panel/cell -> drill one layer deeper, OR sideways. Debounced
        // so a habitual double-click advances only one layer (see DRILL_COOLDOWN_MS).
        // While already focused on a panel (Panels/Assembly), clicking a DIFFERENT panel
        // switches focus straight to it — no intermediate empty-canvas back-out needed.
        const now = performance.now();
        if (now - lastDrillRef.current < DRILL_COOLDOWN_MS) return;
        if (focusedCell !== null && focusedPanel !== null) {
          // ASSEMBLY: a click on a DIFFERENT panel jumps to that panel (Panels phase —
          // zoomToPanel clears the Assembly cell focus); otherwise drill into whichever
          // cell of the current panel the cursor is over.
          const clickedEdge = hitUnravelPanel(mu);
          if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
            lastDrillRef.current = now;
            zoomToPanel(clickedEdge);
          } else {
            const target = cellsForEdge(focusedPanel).find(
              (c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1,
            );
            if (target) {
              lastDrillRef.current = now;
              zoomToCell({ edge: focusedPanel, ...target });
            }
          }
        } else if (focusedPanel !== null) {
          // PANELS: a click on a DIFFERENT panel switches focus directly to it; clicking
          // the SAME panel drills deeper — a SPLIT panel's cell enters Assembly, while an
          // unsplit panel has no deeper layer (do nothing, keep the selection).
          const clickedEdge = hitUnravelPanel(mu);
          if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
            lastDrillRef.current = now;
            zoomToPanel(clickedEdge);
          } else {
            const cells = cellsForEdge(focusedPanel);
            if (cells.length > 1) {
              const target = cells.find(
                (c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1,
              );
              if (target) {
                lastDrillRef.current = now;
                zoomToCell({ edge: focusedPanel, ...target });
              }
            }
          }
        } else {
          // ELEVATIONS: enter the Panels layer for the clicked panel.
          const edge = hitUnravelPanel(mu);
          if (edge >= 0) {
            lastDrillRef.current = now;
            zoomToPanel(edge);
          }
        }
        return;
      }

      const m = eventToModel(e);
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);

      // ERASE tool (perimeter view): start a drag stroke that collects every vertex AND
      // every edge the cursor sweeps over; a plain click collects just the one under the
      // press. The whole set is removed as one undo step on pointer-up — vertices spliced
      // out, edges opened, and any vertex orphaned by losing both its edges auto-dropped
      // (see eraseElements). Vertices win over edges under the cursor (corners delete the
      // vertex). Works on both open and closed perimeters, in both Draw and Edit mode.
      // Owns the press, so a click on empty canvas neither places nor selects.
      if (eraserOn) {
        // Hit-test against the RAW cursor (no grid snap) so vertices/edges catch exactly.
        const mr = toModel(viewport, sx, sy);
        const vi = hitVertex(perimeter, mr, tolModel);
        const initialV = vi >= 0 ? [vi] : [];
        // No vertex under the press but a segment is under the cursor → seed the edge set.
        const seg = vi < 0 ? hitSegment(perimeter, mr, tolModel) : null;
        const initialE = seg ? [seg.index] : [];
        dragRef.current = { kind: "eraseVertex", collected: initialV, edges: initialE, last: mr };
        setEraseVertexCollected(initialV);
        setEraseEdgeCollected(initialE);
        setEraseEdge(-1);
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }

      if (drawing) {
        // A pointer placement supersedes any in-progress typed dimension.
        setDimInput(null);
        // Click first vertex (within tolerance) to close.
        if (perimeter.vertices.length >= 3) {
          const first = perimeter.vertices[0];
          if (distance(first, toModel(viewport, sx, sy)) <= pixelsToModel(viewport, CLOSE_TOLERANCE_PX)) {
            recordHistory();
            setPerimeter((p) => closePerimeter(p));
            setMode("edit");
            return;
          }
        }
        // Place the vertex, then arm a press-drag so the user can immediately
        // pull out curve handles (pen-tool style). A plain click (no drag) is
        // resolved on pointer-up: straight in Line mode, auto-arc in Arc mode.
        // One history step covers the place + any handle pull + arc-on-up.
        const newIndex = perimeter.vertices.length;
        recordHistory();
        setPerimeter((p) => addVertex(p, m));
        dragRef.current = { kind: "drawHandle", index: newIndex, anchor: m, moved: false };
        return;
      }

      // EDIT MODE.
      // 1. Grab a handle knob of the selected vertex (handles are drawn for it).
      if (selectedVertex >= 0) {
        const which = hitHandle(perimeter, selectedVertex, m, tolModel);
        if (which) {
          beginHistory(); // pushed on first handle-drag move
          dragRef.current = { kind: "handle", index: selectedVertex, which, mirror: !e.altKey };
          return;
        }
      }
      // 2. Hit a vertex.
      const vi = hitVertex(perimeter, m, tolModel);
      // 2a. Shift-click a vertex DELETES it (a quick "remove point" gesture,
      //     perimeter/edit view only — Shift while DRAWING is the 45° angle
      //     constraint, so this never fires there). One undo step; clears the
      //     selection and any stale hover/insert transient that referenced the
      //     now-removed/shifted index. The deleteVertex op reopens a closed
      //     polygon if it would drop below 3 vertices.
      if (vi >= 0 && e.shiftKey) {
        recordHistory();
        setPerimeter((p) => deleteVertex(p, vi));
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
        return;
      }
      // 2b. Plain hit: select + drag it. Alt-drag instead pulls out fresh
      //     symmetric handles, turning a corner into a smooth curve.
      if (vi >= 0) {
        setSelectedVertex(vi);
        beginHistory(); // pushed on first move (a pure select makes no history)
        dragRef.current = e.altKey
          ? { kind: "handle", index: vi, which: "out", mirror: true }
          : { kind: "vertex", index: vi };
        return;
      }
      // 3. Hit a segment: insert a vertex (splitting curves cleanly) and drag it.
      const seg = hitSegment(perimeter, m, tolModel);
      if (seg) {
        const { perimeter: np, newIndex } = insertVertexOnSegment(perimeter, seg.index, seg.t, seg.point);
        if (newIndex >= 0) {
          recordHistory();
          setPerimeter(np);
          setSelectedVertex(newIndex);
          dragRef.current = { kind: "vertex", index: newIndex };
          setInsertPreview(null);
        }
        return;
      }
      setSelectedVertex(-1);
    },
    [
      drawing,
      perimeter,
      viewport,
      eventToModel,
      selectedVertex,
      unravelOn,
      hitUnravelTop,
      hitUnravelPanel,
      focusedPanel,
      statsMenuOpen,
      cwMenuOpen,
      viewMenuOpen,
      recordHistory,
      beginHistory,
      // Subtractive division tool reads these; without them the handler would keep
      // a stale closure (subtractiveOn === false) and never start a division drag.
      subtractiveOn,
      unravelResult,
      gridSpacing,
      // Eraser tool reads these to collect the targeted line(s) on press; without them
      // the handler would keep a stale closure (eraserOn === false) and never erase.
      eraserOn,
      eraseTargetsNear,
      // Mullions tool reads these to start an offset drag on a grid line.
      mullionsOn,
      cwType,
      nearestGridLine,
      panelMullionsV,
      panelMullionsH,
      // Framing tool (Unitized) reads these to start a per-cell edge inset drag.
      // (focusedCell is already listed below for layer navigation.)
      nearestCellEdge,
      panelCellFraming,
      // Shift flips the Subtractive split axis (rows vs columns); effectiveHeight
      // resolves the panel height for the equal-row generator. Stale closures here
      // would lock the axis / use a stale height.
      shiftHeld,
      effectiveHeight,
      // Floor plates are passed to buildEqualRows as snap guides; a stale closure
      // would align rows to an out-of-date set of plates.
      floorPlates,
      // Floor-plate branch reads these; without them the memoized handler keeps a
      // stale closure (floorPlateMode === false) and clicks fall through to
      // draw/edit until an unrelated dep change rebuilds the callback.
      floorPlateMode,
      // The floor-plate snap helper (reads floorPlates/shiftHeld/viewport). Listing
      // it here keeps placement in lock-step with the preview's snapped elevation.
      snapFloorPlateY,
      cancelAnim,
      // Single-click layer navigation: a click ON a panel/cell drills one layer
      // deeper, a click on the empty canvas backs out one layer (deepest-first:
      // cell -> panel -> strip). These drive the hit-tests, re-frame, and current layer.
      // (focusedPanel is already listed above for the Subtractive tool.)
      focusedCell,
      cellsForEdge,
      zoomToCell,
      zoomToPanel,
      fitUnravel,
      unravelGap,
      unravelHeights,
      unravelHeight,
      // Export tool: a stale closure (exportSelectMode === false) would never start the
      // selection marquee after arming Export.
      exportSelectMode,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const drag = dragRef.current;

      if (drag?.kind === "pan") {
        const dx = sx - (drag.lastX ?? sx);
        const dy = sy - (drag.lastY ?? sy);
        drag.lastX = sx;
        drag.lastY = sy;
        if (dx !== 0 || dy !== 0) {
          drag.moved = true;
        }
        setViewport((vp) => pan(vp, dx, dy));
        return;
      }

      // Export marquee drag: grow the selection rectangle to the cursor and live-
      // update which panels it intersects. Raw model point (no draw snap/constrain).
      if (drag?.kind === "marquee") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const rect = { x0: drag.startModel.x, y0: drag.startModel.y, x1: mu.x, y1: mu.y };
        setMarquee(rect);
        setExportSelection(panelsInMarquee(rect));
        return;
      }

      // Subtractive division drag: recompute the equal split from the current cursor
      // position (dragging just re-picks the iteration / spacing) and show it as a
      // live preview, committed on pointer-up. The AXIS is fixed at press time (stored
      // on the draft) so mid-drag the user keeps splitting rows OR columns.
      if (drag?.kind === "divide") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const seg = unravelResult?.segments.find((s) => s.index === drag.edge);
        if (seg) {
          const axis = divideDraft?.axis ?? (shiftHeld ? "h" : "v");
          if (axis === "h") {
            const panelH = effectiveHeight(drag.edge);
            // Floor plates crossing the panel act as guides the rows snap to.
            setDivideDraft({ edge: drag.edge, axis: "h", lines: buildEqualRows(mu.y, 0, panelH, floorPlates) });
          } else {
            setDivideDraft({ edge: drag.edge, axis: "v", lines: buildEqualColumns(mu.x, seg.x0, seg.x1) });
          }
        }
        return;
      }

      // Height-resize drag: set THIS panel's height to the cursor's model-y. Use
      // the raw model point (not the draw-mode snap/constrain) and clamp/snap via
      // clampHeight. Update cursor readout from the same raw point.
      if (drag?.kind === "unravelHeight") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        flushHistory(); // record the pre-resize state once, on the first move
        setPanelHeight(drag.edge, clampHeight(mu.y));
        return;
      }

      // MULLION offset drag: the half-width offset = the perpendicular distance from
      // the grabbed grid line to the cursor (raw model point), snapped to 0.25′. Lives
      // as a draft (live ± band preview) until pointer-up commits it to the panel.
      if (drag?.kind === "mullion") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const dist = drag.axis === "v" ? Math.abs(mu.x - drag.ref) : Math.abs(mu.y - drag.ref);
        const offset = Math.max(0, Math.round(dist / MULLION_STEP) * MULLION_STEP);
        setMullionDraft({ edge: drag.edge, axis: drag.axis, offset });
        return;
      }

      // CELL-FRAMING drag (Unitized): the inset = the cursor's inward distance from the
      // grabbed cell edge (raw model point), clamped to the cell span and snapped to
      // 0.25′. Previews live (one edge, or all four with Shift) until pointer-up commits.
      if (drag?.kind === "cellframe") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const offset = cellInsetForPoint(mu, drag.cell, drag.side);
        setCellFrameDraft({ edge: drag.edge, cellIndex: drag.cellIndex, side: drag.side, offset, all: drag.all });
        return;
      }

      const m = eventToModel(e);
      setCursorModel(m);

      if (drag?.kind === "vertex") {
        flushHistory();
        setPerimeter((p) => moveVertex(p, drag.index, m));
        return;
      }

      if (drag?.kind === "handle") {
        flushHistory();
        const anchor = perimeter.vertices[drag.index];
        const offset = { x: m.x - anchor.x, y: m.y - anchor.y };
        setPerimeter((p) => setHandle(p, drag.index, drag.which, offset, drag.mirror));
        return;
      }

      if (drag?.kind === "drawHandle") {
        // Promote a press to a drag once it travels past the threshold, then
        // pull symmetric handles on the just-placed vertex: this curves the
        // segment we just drew (via handleIn) and pre-curves the next one.
        const distPx = Math.hypot((m.x - drag.anchor.x) * viewport.scale, (m.y - drag.anchor.y) * viewport.scale);
        if (!drag.moved && distPx < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        setActiveDrawHandle(drag.index);
        const offset = { x: m.x - drag.anchor.x, y: m.y - drag.anchor.y };
        setPerimeter((p) => setHandle(p, drag.index, "out", offset, true));
        return;
      }

      // ERASE VERTEX drag (perimeter view): accumulate every vertex the cursor SWEEPS
      // over (sampling the whole path from the last point to this one) so a fast drag
      // never skips a vertex between two pointer events. Uses the RAW cursor for the
      // same precision reason as the unravel line eraser. Deleted as one undo step on up.
      if (drag?.kind === "eraseVertex") {
        const mr = toModel(viewport, sx, sy);
        const beforeV = drag.collected.length;
        const beforeE = drag.edges.length;
        drag.collected = collectVerticesAlong(drag.last, mr, drag.collected);
        drag.edges = collectEdgesAlong(drag.last, mr, drag.edges);
        drag.last = mr;
        if (drag.collected.length !== beforeV) setEraseVertexCollected([...drag.collected]);
        if (drag.edges.length !== beforeE) setEraseEdgeCollected([...drag.edges]);
        return;
      }

      // Unravel hover-link: hit-test the cursor against the edge RECTANGLES (each
      // spans x0→x1 on x and y = 0..height on y). A rectangle is "hovered" when
      // the cursor falls inside its x range and its y range (0..height), with a
      // small screen-pixel tolerance. The matched rectangle's ORIGINAL edge index
      // highlights the rectangle here and the linked edge in the mini-window.
      if (unravelOn) {
        // ERASE drag: accumulate every erasable line the cursor SWEEPS over (sampling
        // the whole path from the last point to this one) so a fast drag never skips a
        // line between two pointer events. Uses the RAW cursor (the grid-snapped `m`
        // quantises to whole feet, but centerlines sit at fractional offsets and the
        // hit tolerance shrinks as you zoom in). Highlight the current cursor target.
        // The whole set is committed as one undo step on pointer-up.
        if (drag?.kind === "erase") {
          const mr = toModel(viewport, sx, sy);
          const before = drag.collected.length;
          drag.collected = collectEraseAlong(drag.last, mr, drag.collected);
          drag.last = mr;
          if (drag.collected.length !== before) setEraseDragCollected([...drag.collected]);
          setEraseHover(nearestEraseLine(mr));
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }

        // ASSEMBLY phase (a single CELL zoomed-into via double-click): highlight the
        // ONE edge of the focused cell the cursor is nearest, within a pixel
        // tolerance, so the user can target an individual edge. Left/right test the
        // cell's vertical borders (cursor near x0/x1 AND its y inside the cell band);
        // top/bottom test the horizontal borders (cursor near y1/y0 — model +Y is UP,
        // so y1 is the TOP edge, y0 the BOTTOM — AND its x inside the band). The
        // nearest qualifying edge wins; null when not near any. Other unravel hovers
        // are cleared so they don't fight. Takes precedence over the panel-phase tools.
        if (focusedCell !== null) {
          const fc = focusedCell;
          const loX = Math.min(fc.x0, fc.x1);
          const hiX = Math.max(fc.x0, fc.x1);
          const loY = Math.min(fc.y0, fc.y1);
          const hiY = Math.max(fc.y0, fc.y1);
          // Use the RAW (un-snapped) cursor position: the grid-snapped `m` quantises
          // to whole feet, but the cell's edges sit at arbitrary fractional offsets,
          // so the snapped point could never land within tolerance of an edge.
          const rect = canvasRef.current!.getBoundingClientRect();
          const mr = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
          const tol = pixelsToModel(viewport, HIT_TOLERANCE_PX);
          let best: "top" | "right" | "bottom" | "left" | null = null;
          let bestDist = Infinity;
          // Accumulate the nearest qualifying edge: record one whose perpendicular
          // distance is within tolerance AND closer than any seen so far.
          const consider = (edge: "top" | "right" | "bottom" | "left", dist: number): void => {
            if (dist <= tol && dist < bestDist) {
              best = edge;
              bestDist = dist;
            }
          };
          // Vertical edges (left = x0, right = x1): only when the cursor's y is within
          // the cell's height band.
          if (mr.y >= loY && mr.y <= hiY) {
            consider("left", Math.abs(mr.x - loX));
            consider("right", Math.abs(mr.x - hiX));
          }
          // Horizontal edges (top = y1, bottom = y0): only when the cursor's x is
          // within the cell's width band.
          if (mr.x >= loX && mr.x <= hiX) {
            consider("top", Math.abs(mr.y - hiY));
            consider("bottom", Math.abs(mr.y - loY));
          }
          setHoveredCellEdge(best);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          return;
        }
        // MULLIONS tool armed (Stick system): highlight whichever axis's grid lines the
        // cursor is over so the user sees that dragging will move them ALL together. Uses
        // the RAW (un-snapped) cursor position — the grid-snapped `m` quantises to whole
        // feet, but the centerlines sit at fractional offsets and `nearestGridLine`'s
        // tolerance SHRINKS in model units as you zoom in; at high zoom the snapped point
        // could never land within tolerance of a centerline, so the highlight would never
        // fire. (Mirrors the cell-edge hover above and the drag-start in onPointerDown.)
        // Clears the other hovers so they don't fight.
        if (mullionsOn && cwType === "stick" && focusedPanel !== null) {
          const hit = nearestGridLine(toModel(viewport, sx, sy), focusedPanel);
          setMullionHover(hit ? hit.axis : null);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        // FRAMING tool armed (Unitized system): highlight the single nearest edge of the
        // cell under the cursor so the user sees the one face a drag will move. Uses the
        // RAW cursor (same reasoning as the Stick hover above). Panels tab only. Clears
        // the other hovers so they don't fight.
        if (mullionsOn && cwType === "unitized" && focusedPanel !== null && focusedCell === null) {
          const hit = nearestCellEdge(toModel(viewport, sx, sy), focusedPanel);
          setCellEdgeHover(hit ? { cellIndex: hit.cellIndex, side: hit.side } : null);
          setMullionHover(null);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        // SUBTRACTIVE tool armed: instead of the hover-link, recommend an equal split.
        // We store the raw cursor model point (NO grid snap) whenever it's inside the
        // selected panel; the render builder picks the AXIS by `shiftHeld` (equal-width
        // columns from .x, or equal-height rows from .y) and turns it into the division
        // lines + the spacing dimension. Clears the rectangle hover-link so they don't fight.
        if (subtractiveOn && focusedPanel !== null) {
          const seg = unravelResult?.segments.find((s) => s.index === focusedPanel);
          setDivideHover(seg && hitUnravelPanel(m) === focusedPanel ? m : null);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        // ERASER tool armed: highlight the nearest erasable line (division line on
        // the focused panel, or a floor plate) as the deletion candidate. Clears
        // the rectangle hover-link so they don't fight.
        if (eraserOn) {
          setEraseHover(nearestEraseLine(toModel(viewport, sx, sy)));
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        const segs = unravelResult?.segments;
        if (segs && segs.length > 0) {
          // Top-edge resize hover takes PRECEDENCE near a rectangle's top so the
          // resize affordance wins over the body hover-highlight.
          const top = hitUnravelTop(m);
          setHoveredUnravelTop(top);
          // PANELS phase (a SPLIT panel zoomed-in, not yet in the deeper Assembly
          // cell zoom): highlight the individual CELL under the cursor so the
          // subdivision reads as a set of navigable cells. When a cell is hit we
          // suppress the whole-panel body hover-link so the two highlights don't
          // fight; an unsplit panel (<= 1 cell) keeps the plain panel hover-link.
          if (focusedPanel !== null && focusedCell === null) {
            const cells = cellsForEdge(focusedPanel);
            const idx =
              cells.length > 1
                ? cells.findIndex((c) => m.x >= c.x0 && m.x <= c.x1 && m.y >= c.y0 && m.y <= c.y1)
                : -1;
            setHoveredCell(idx);
            setHoveredUnravelEdge(idx >= 0 ? -1 : hitUnravelPanel(m));
          } else {
            setHoveredCell(-1);
            // Rectangle body hover (reuses the shared panel hit-test).
            setHoveredUnravelEdge(hitUnravelPanel(m));
          }
        } else {
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
        }
        return;
      }

      // Hover feedback (edit mode, OR while the Erase tool is armed; not in the
      // read-only unravel view). The Erase tool lights the hovered vertex (drawn red)
      // for deletion; failing a vertex it lights the hovered EDGE of a closed loop
      // (also red) — a click there removes that segment, reopening the perimeter.
      if (!unravelOn && (mode === "edit" || eraserOn)) {
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        const vi = hitVertex(perimeter, m, tolModel);
        setHoveredVertex(vi);
        if (eraserOn) {
          setInsertPreview(null);
          setHoveredEdge(-1);
          // Vertex wins over edge; when no vertex is hovered, target the nearest segment.
          setEraseEdge(vi < 0 ? (hitSegment(perimeter, m, tolModel)?.index ?? -1) : -1);
        } else if (vi < 0) {
          const seg = hitSegment(perimeter, m, tolModel);
          setInsertPreview(seg ? seg.point : null);
          // Link the hovered footprint edge to its line on the active thumbnail.
          setHoveredEdge(seg ? seg.index : -1);
        } else {
          // Over a vertex, not an edge: drop the edge hover-link.
          setInsertPreview(null);
          setHoveredEdge(-1);
        }
      }
    },
    [
      eventToModel,
      mode,
      perimeter,
      viewport,
      unravelOn,
      unravelResult,
      hitUnravelTop,
      hitUnravelPanel,
      clampHeight,
      setPanelHeight,
      flushHistory,
      // Subtractive division tool reads these for the drag array + hover preview.
      subtractiveOn,
      focusedPanel,
      gridSpacing,
      // Eraser tool reads these to highlight the nearest line on hover and to sweep up
      // every line crossed during a drag.
      eraserOn,
      nearestEraseLine,
      collectEraseAlong,
      // Erase drag (perimeter view) sweeps up every vertex AND edge crossed.
      collectVerticesAlong,
      collectEdgesAlong,
      // Shift flips the drag axis; effectiveHeight resolves the panel height for the
      // equal-row generator; divideDraft.axis pins the axis chosen at press time.
      shiftHeld,
      effectiveHeight,
      divideDraft,
      // Floor plates feed buildEqualRows as snap guides during the row drag.
      floorPlates,
      // Per-cell hover (Panels phase) reads the focused-cell state + the cell grid.
      focusedCell,
      cellsForEdge,
      // Mullions tool hover/drag reads these.
      mullionsOn,
      cwType,
      nearestGridLine,
      // Framing tool (Unitized) hover/drag reads these.
      nearestCellEdge,
      cellInsetForPoint,
      // Export marquee drag recomputes the selected panels live as the box grows.
      panelsInMarquee,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      canvasRef.current?.releasePointerCapture(e.pointerId);
      const drag = dragRef.current;
      // Export marquee release: finalise the selection from the drag's final corner
      // (computed fresh from the event, so no reliance on async state) and, if any
      // walls were caught, open the export popup and disarm the select tool.
      if (drag?.kind === "marquee") {
        dragRef.current = null;
        setMarquee(null);
        const canvas = canvasRef.current;
        let sel = new Set<number>();
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const mu = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
          sel = panelsInMarquee({ x0: drag.startModel.x, y0: drag.startModel.y, x1: mu.x, y1: mu.y });
        }
        setExportSelection(sel);
        if (sel.size > 0) {
          setExportPopup(sel);
          setExportSelectMode(false); // tool's job is done; disarm like a one-shot
        }
        return;
      }
      // A plain click in Arc mode (no handle pulled) auto-curves the segment
      // that was just committed (between the previous vertex and the new one).
      if (drag?.kind === "drawHandle" && !drag.moved && curveType === "arc" && drag.index >= 1) {
        setPerimeter((p) => makeSegmentArc(p, drag.index - 1));
      }
      // Subtractive division drag/click: commit the previewed equal split (the N-1
      // even division lines) onto the panel. Route by the draft's AXIS: VERTICAL
      // columns go to panelDivisions as x-OFFSETS from the panel's left edge;
      // HORIZONTAL rows go to panelDividersH as y-OFFSETS from the baseline. Then
      // clear the transient preview.
      if (drag?.kind === "divide") {
        const seg = unravelResult?.segments.find((s) => s.index === drag.edge);
        if (seg && divideDraft && divideDraft.edge === drag.edge) {
          if (divideDraft.axis === "h") {
            commitDividersH(drag.edge, divideDraft.lines);
          } else {
            commitDivisions(drag.edge, seg.x0, divideDraft.lines);
          }
        }
        setDivideDraft(null);
        setDivideHover(null);
      }
      // Erase drag: commit everything collected during the stroke as one undo step.
      if (drag?.kind === "erase") {
        commitEraseLines(drag.collected);
        setEraseDragCollected([]);
        setEraseHover(null);
      }
      // Erase drag (perimeter view): remove every vertex AND edge swept during the
      // stroke in one undo step. eraseElements splices the vertices, opens the edges,
      // and auto-drops any vertex orphaned by losing both its walls (so no point is
      // left alone); a closed loop reopens when an edge is cut or it falls below 3.
      if (drag?.kind === "eraseVertex") {
        if (drag.collected.length > 0 || drag.edges.length > 0) {
          recordHistory();
          const edges = drag.edges;
          const verts = drag.collected;
          setPerimeter((p) => eraseElements(p, edges, verts));
          setSelectedVertex(-1);
          setHoveredVertex(-1);
          setInsertPreview(null);
        }
        setEraseVertexCollected([]);
        setEraseEdgeCollected([]);
        setEraseEdge(-1);
      }
      // Mullion drag: commit the dragged half-width offset onto the panel/axis (one
      // undo step via the pre-drag snapshot taken on pointer-down), then drop the draft.
      if (drag?.kind === "mullion" && mullionDraft && mullionDraft.edge === drag.edge) {
        flushHistory();
        const off = mullionDraft.offset;
        const edge = mullionDraft.edge;
        if (mullionDraft.axis === "v") setPanelMullionsV((prev) => ({ ...prev, [edge]: off }));
        else setPanelMullionsH((prev) => ({ ...prev, [edge]: off }));
        setMullionDraft(null);
      }
      // Cell-framing drag (Unitized): commit the dragged inset — one edge, or all four
      // with Shift — onto EVERY cell that shares the dragged cell's Material ID (shape),
      // across all panels, so editing one cell mirrors to all identical cells project-
      // wide. One undo step. Matching cells are found by walking each panel's grid and
      // comparing shape keys, so the framing store stays keyed by panel + cell index.
      if (drag?.kind === "cellframe" && cellFrameDraft && cellFrameDraft.edge === drag.edge) {
        flushHistory();
        const { side, offset, all } = cellFrameDraft;
        const key = cellShapeColors.keyOf(drag.cell);
        const applyInset = (cur: CellInsets): CellInsets =>
          all
            ? { top: offset, right: offset, bottom: offset, left: offset }
            : { ...cur, [side]: offset };
        setPanelCellFraming((prev) => {
          const next = { ...prev };
          for (const seg of unravelResult?.segments ?? []) {
            const cells = cellsForEdge(seg.index);
            let panel: Record<number, CellInsets> | null = null;
            for (let i = 0; i < cells.length; i++) {
              if (cellShapeColors.keyOf(cells[i]) !== key) continue;
              if (!panel) panel = { ...(next[seg.index] ?? {}) };
              panel[i] = applyInset(panel[i] ?? { top: 0, right: 0, bottom: 0, left: 0 });
            }
            if (panel) next[seg.index] = panel;
          }
          return next;
        });
        setCellFrameDraft(null);
      }
      dragRef.current = null;
      setActiveDrawHandle(-1);
    },
    [curveType, unravelResult, divideDraft, commitDivisions, commitDividersH, commitEraseLines, mullionDraft, cellFrameDraft, cellShapeColors, cellsForEdge, flushHistory, recordHistory,
      // Export marquee release resolves the final corner via viewport and selects panels.
      viewport, panelsInMarquee],
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Layer navigation is now driven by a SINGLE click (see onPointerDown), so a
      // double-click no longer drills into the layers — the two underlying presses
      // already advance one layer (debounced so they don't jump two). In the unravel
      // view a double-click therefore does nothing extra; the draw/edit double-click
      // shortcuts below apply only to the footprint views.
      if (unravelOn) return;
      if (drawing && perimeter.vertices.length >= 3) {
        recordHistory();
        setPerimeter((p) => closePerimeter(p));
        setMode("edit");
        return;
      }
      // In edit mode, double-clicking a vertex strips its handles (curve → corner).
      if (mode === "edit") {
        const m = eventToModel(e);
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        const vi = hitVertex(perimeter, m, tolModel);
        if (vi >= 0) {
          recordHistory();
          setPerimeter((p) => clearVertexHandles(p, vi));
          setSelectedVertex(vi);
        }
      }
    },
    [drawing, mode, perimeter, viewport, eventToModel, unravelOn, recordHistory],
  );

  // Smooth, trackpad-friendly zoom. Attached as a NON-PASSIVE native wheel
  // listener (see effect below) so preventDefault() actually fires — React's
  // synthetic onWheel is passive, which would let a trackpad PINCH (ctrl+wheel)
  // zoom the whole browser page and two-finger scroll pan the page. The native
  // listener stops both and routes the gesture into the canvas viewport.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      cancelAnim(); // manual zoom interrupts any running animation
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      const anchorY = e.clientY - rect.top;

      // Normalize the wheel delta to PIXELS so line/page-based wheels match the
      // pixel-mode trackpad case before we apply the exponential constant.
      //   deltaMode 0 = pixel (trackpad / most mice), 1 = line, 2 = page.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; // ~16px per line
      else if (e.deltaMode === 2) dy *= rect.height; // a page ≈ canvas height

      // Magnitude-proportional EXPONENTIAL zoom: factor = exp(-dy * K).
      // K = ln(1.1)/100 so a typical mouse notch (|dy| ≈ 100) ≈ the old 1.1 step,
      // while small trackpad/pinch deltas yield small, smooth factors. Clamp the
      // per-event factor so one huge delta can't teleport the zoom.
      const K = 0.0009531; // ln(1.1) / 100
      const factor = Math.min(2, Math.max(0.5, Math.exp(-dy * K)));
      setViewport((vp) => zoomAt(vp, anchorX, anchorY, factor));
    },
    [cancelAnim],
  );

  // Attach the wheel handler as a non-passive native listener so preventDefault
  // works (the primary fix for page-zoom on trackpad pinch). Re-binds only if
  // onWheel changes (it is stable: depends on the stable cancelAnim).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // ---------------------------------------------------------------------------
  // SAVE / LOAD / DELETE / RENAME / UPDATE saved perimeters.
  // The live model is deep-copied on save (clonePerimeter) so later edits to the
  // editor never mutate a stored entry. Declared before the keyboard effect so
  // the Ctrl+S handler can reference saveCurrent.
  // ---------------------------------------------------------------------------

  // Whether the current editor perimeter is substantial enough to save.
  const saveable = canSave(perimeter);

  /**
   * The current authored elevation state, bundled for save/auto-save. Mirrors the
   * persistent fields of DocSnapshot (NOT transient view state). Memoised so the
   * auto-save effect below has a stable, value-equal dependency to compare.
   */
  const currentElevation: SavedElevationState = useMemo(
    () => ({ unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCwType, unravelHeight, floorPlates }),
    [unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCwType, unravelHeight, floorPlates],
  );

  /**
   * Start a fresh, BLANK project — the clean slate a page refresh gives, minus the
   * onboarding hint. Resets the live editor document and all view/tool/navigation state
   * to their defaults and detaches from any loaded save (activeSavedId → null), while
   * KEEPING the saved projects list intact. Clears undo/redo (there's nothing to undo
   * back into the previous project) and suppresses the first-run hint, since this is a
   * deliberate "new project" action, not a cold load.
   */
  const newProject = useCallback(() => {
    cancelAnim();
    // --- Document state (mirrors the initial useState values) ---
    setPerimeter(emptyPerimeter());
    setUnravelHeights({});
    setUnravelCells({});
    setPanelDivisions({});
    setPanelDividersH({});
    setPanelMullionsV({});
    setPanelMullionsH({});
    setPanelCellFraming({});
    setPanelCwType({});
    setUnravelHeight(DEFAULT_WALL_HEIGHT_FT);
    setFloorPlates([]);
    setLocation(emptyLocation());
    setUnravelInputDraft({});
    setFocusedUnravelInput(null);
    // --- View + navigation ---
    setUnravelOn(false);
    setMode("draw");
    setCurveType("line");
    setFocusedPanel(null);
    setFocusedCell(null);
    setCellViewMode("normal");
    setActiveSavedId(null);
    setViewport(defaultViewport(sizeRef.current.w, sizeRef.current.h));
    // --- Tools / menus / transient selection ---
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setEraseDragCollected([]);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    setFloorPlateMode(false);
    setFloorLinesVisible(true);
    setCwMenuOpen(false);
    setViewMenuOpen(false);
    setStatsMode("none");
    setStatsMenuOpen(false);
    setSelectedVertex(-1);
    setHoveredVertex(-1);
    setHoveredCell(-1);
    setHoveredCellEdge(null);
    setHoveredEdge(-1);
    setInsertPreview(null);
    setCursorModel(null);
    setDimInput(null);
    // --- History ---
    setUndoStack([]);
    setRedoStack([]);
    pendingRef.current = null;
    // The empty canvas would normally re-show the onboarding hint; this action
    // explicitly suppresses it (no load-in text/arrow for a deliberate new project).
    setHintDismissed(true);
  }, [cancelAnim]);

  /** Capture the current perimeter + elevation state as a NEW saved entry. */
  const saveCurrent = useCallback(() => {
    if (!canSave(perimeter)) return; // guard empty/degenerate
    setSaved((list) => {
      const entry = makeSavedPerimeter(perimeter, currentElevation, list, location);
      setActiveSavedId(entry.id);
      return [...list, entry];
    });
  }, [perimeter, currentElevation, location]);

  /** Load a saved perimeter back into the editor (replaces the live one). */
  const loadSavedEntry = useCallback(
    (s: SavedPerimeter) => {
      recordHistory(); // loading replaces the live shape — make it undoable
      const loaded = clonePerimeter(s.perimeter); // detach from the stored copy
      setPerimeter(loaded);
      // Restore the entry's elevation/unwrapped-view document state so a loaded
      // project brings back its panel edits (defaulting any field absent on
      // older saves). Fresh containers detach from the stored snapshot.
      setUnravelHeights({ ...(s.unravelHeights ?? {}) });
      setUnravelCells({ ...(s.unravelCells ?? {}) });
      // Division arrays are nested, so copy each panel's offsets array too.
      setPanelDivisions(
        Object.fromEntries(Object.entries(s.panelDivisions ?? {}).map(([k, v]) => [k, [...v]])),
      );
      // Horizontal dividers: same nested-array copy + default-{} for older saves.
      setPanelDividersH(
        Object.fromEntries(Object.entries(s.panelDividersH ?? {}).map(([k, v]) => [k, [...v]])),
      );
      // Mullion offsets (flat number maps) — fresh containers detach from the snapshot.
      setPanelMullionsV({ ...(s.panelMullionsV ?? {}) });
      setPanelMullionsH({ ...(s.panelMullionsH ?? {}) });
      // Unitized per-cell framing is a nested map — deep-copy both object levels.
      setPanelCellFraming(cloneCellFraming(s.panelCellFraming ?? {}));
      // Per-panel curtain-wall system assignment (flat map) — fresh container.
      setPanelCwType({ ...(s.panelCwType ?? {}) });
      setUnravelHeight(s.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT);
      setFloorPlates([...(s.floorPlates ?? [])]);
      // Restore the entry's geo-location (blank for older saves with none).
      setLocation(s.location ? cloneLocation(s.location) : emptyLocation());
      setActiveSavedId(s.id);
      // Closed shapes are most useful to edit; open polylines can keep drawing.
      setMode(s.perimeter.closed ? "edit" : "draw");
      setSelectedVertex(-1);
      setHoveredVertex(-1);
      setInsertPreview(null);
      // ZOOM-TO-FIT the loaded perimeter's content — footprint when in perimeter
      // view, unravel strip when in elevation view — so saved shapes at different
      // scales each arrive framed on screen without manual zoom hunting.
      const { w, h } = sizeRef.current;
      if (unravelOn) {
        const res = unravelPerimeter(loaded, unravelGap);
        if (res.segments.length > 0) {
          const loadedHeights = { ...(s.unravelHeights ?? {}) };
          const loadedDefaultH = s.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT;
          const heightOf = (seg: UnravelSegment) => loadedHeights[seg.index] ?? loadedDefaultH;
          animateViewport(fitViewport(unravelBoundsPerimeter(res.segments, heightOf), w, h, 48));
        }
      } else {
        animateViewport(fitViewport(loaded, w, h, 64));
      }
    },
    [recordHistory, animateViewport, unravelOn, unravelGap],
  );

  const deleteSavedEntry = useCallback(
    (id: string) => {
      const index = saved.findIndex((s) => s.id === id);
      if (index === -1) return;
      // Record the deletion so Ctrl+Z / the Undo button can bring the project back
      // (and Ctrl+Y / Redo removes it again). Entries are immutable, so holding the
      // reference for re-insertion is safe.
      pushHistory({ kind: "delete", entry: saved[index], index });
      setSaved((list) => list.filter((s) => s.id !== id));
      setActiveSavedId((cur) => (cur === id ? null : cur));
    },
    [saved, pushHistory],
  );

  const renameSavedEntry = useCallback((id: string, name: string) => {
    setSaved((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const reorderSaved = useCallback((from: number, to: number) => {
    setSaved((list) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  /**
   * Duplicate an entire saved project (perimeter + all elevation/framing state, floor
   * plates, location, solar) into a new "Option N" entry appended to the list. The
   * source's stored snapshot stays current via the auto-save effect, so duplicating the
   * ACTIVE project copies its live edits too. Leaves the current selection untouched
   * (the copy is added, not loaded) so it's non-destructive to in-progress work.
   */
  const duplicateSavedEntry = useCallback((id: string) => {
    setSaved((list) => {
      const src = list.find((s) => s.id === id);
      if (!src) return list;
      return [...list, duplicateSavedPerimeter(src, list)];
    });
  }, []);

  /**
   * Update a saved entry's geo-location (edited from its Solar Study popup). When
   * the entry is the ACTIVE one, also sync the live `location` state so the left
   * LOCATION panel stays consistent and the auto-save effect doesn't overwrite the
   * change with the stale live value.
   */
  const changeSavedLocation = useCallback(
    (id: string, loc: LocationInfo) => {
      setSaved((list) => list.map((s) => (s.id === id ? { ...s, location: cloneLocation(loc) } : s)));
      if (id === activeSavedId) setLocation(cloneLocation(loc));
    },
    [activeSavedId],
  );

  // Persist a saved entry's SOLAR settings (cardinal orientation + studied date/time
  // + site), edited from its Solar Study popup. Mirrors changeSavedLocation: the
  // settings are deep-copied so the stored snapshot is detached from the popup's live
  // state. Persisting `northOffset` here is what a later step will read to derive each
  // facade's cardinal orientation from the drawn perimeter + this study set.
  const changeSavedSolar = useCallback((id: string, solar: SolarSettings) => {
    setSaved((list) => list.map((s) => (s.id === id ? { ...s, solar: cloneSolarSettings(solar) } : s)));
  }, []);

  // AUTO-SAVE the active entry. When a saved entry is loaded (activeSavedId set),
  // every authored document change — footprint geometry AND elevation-view panel
  // edits — writes back into THAT entry only, with no manual button. The user's
  // edits to a loaded project always persist to that specific pipeline.
  useEffect(() => {
    if (activeSavedId == null) return; // brand-new unsaved shape: stays live only
    setSaved((list) => {
      const idx = list.findIndex((s) => s.id === activeSavedId);
      if (idx === -1) return list; // active id no longer present: nothing to write
      const cur = list[idx];
      // NO-OP GUARD: loading an entry sets these states, which would otherwise
      // trigger an identical write-back every render (and persist churn). If the
      // stored fields already deep-equal the live document, return the SAME list
      // reference so React bails out (no re-render, no persist). A JSON compare of
      // these small maps/arrays/perimeter is cheap and readable. The maps/arrays
      // are built/replaced (never mutated) with stable key insertion order, so
      // stringify comparison is reliable here.
      const sameGeom = JSON.stringify(cur.perimeter) === JSON.stringify(perimeter);
      const sameElev =
        JSON.stringify(cur.unravelHeights ?? {}) === JSON.stringify(unravelHeights) &&
        JSON.stringify(cur.unravelCells ?? {}) === JSON.stringify(unravelCells) &&
        JSON.stringify(cur.panelDivisions ?? {}) === JSON.stringify(panelDivisions) &&
        JSON.stringify(cur.panelDividersH ?? {}) === JSON.stringify(panelDividersH) &&
        JSON.stringify(cur.panelMullionsV ?? {}) === JSON.stringify(panelMullionsV) &&
        JSON.stringify(cur.panelMullionsH ?? {}) === JSON.stringify(panelMullionsH) &&
        JSON.stringify(cur.panelCellFraming ?? {}) === JSON.stringify(panelCellFraming) &&
        JSON.stringify(cur.panelCwType ?? {}) === JSON.stringify(panelCwType) &&
        (cur.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT) === unravelHeight &&
        JSON.stringify(cur.floorPlates ?? []) === JSON.stringify(floorPlates);
      // Location is metadata, compared the same way (a blank live location matches a
      // stored entry that never had one, so loading then idling never re-writes).
      const sameLoc = JSON.stringify(cur.location ?? emptyLocation()) === JSON.stringify(location);
      if (sameGeom && sameElev && sameLoc) return list; // already in sync — no change

      // ISOLATION: replace ONLY the active entry; every other entry keeps its
      // exact reference. Deep-copy the live document into the snapshot so later
      // edits can't mutate it.
      const elev = cloneElevationState(currentElevation);
      const next = list.slice();
      next[idx] = {
        ...cur,
        perimeter: clonePerimeter(perimeter),
        unravelHeights: elev.unravelHeights,
        unravelCells: elev.unravelCells,
        panelDivisions: elev.panelDivisions,
        panelDividersH: elev.panelDividersH,
        panelMullionsV: elev.panelMullionsV,
        panelMullionsH: elev.panelMullionsH,
        panelCellFraming: elev.panelCellFraming,
        panelCwType: elev.panelCwType,
        unravelHeight: elev.unravelHeight,
        floorPlates: elev.floorPlates,
        location: cloneLocation(location),
      };
      return next;
    });
  }, [activeSavedId, perimeter, unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCwType, unravelHeight, floorPlates, currentElevation, location, setSaved]);

  // Persist whenever the saved list changes (keeps localStorage in sync).
  useEffect(() => {
    persistSaved(saved);
  }, [saved]);

  // ---------------------------------------------------------------------------
  // KEYBOARD
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);

      // While the help popup is open it owns Escape (its own effect closes it);
      // don't let Escape here also cancel a polyline / clear selection. (The
      // Statistics dropdown is sticky and does NOT consume Escape, so Escape keeps
      // its normal behaviour while stats are shown.)
      if (helpOpen && e.key === "Escape") return;

      // Ignore shortcuts while typing in a form field.
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";

      // Ctrl/Cmd+S — save the current perimeter (prevent the browser save dialog).
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveCurrent();
        return;
      }

      // Ctrl/Cmd+Z = undo · Ctrl+Y or Ctrl/Cmd+Shift+Z = redo. Skipped while typing
      // in a field so native text undo still works there.
      if (!typing && (e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (!typing && (e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }

      // ARROW KEYS — when already zoomed into a wall border (Panels phase: a panel is
      // focused but not drilled into a cell), Left / Right jump to the PREVIOUS / NEXT
      // border along the unravel strip, wrapping around the closed loop. This is a
      // keyboard shortcut for the same gesture as clicking the neighbouring panel, so it
      // routes through zoomToPanel — identical animated zoom, focus, and cell-clear.
      if (
        !typing &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        unravelOn &&
        focusedPanel !== null &&
        focusedCell === null
      ) {
        const segs = unravelResult?.segments;
        if (segs && segs.length > 1) {
          const pos = segs.findIndex((s) => s.index === focusedPanel);
          if (pos >= 0) {
            e.preventDefault();
            const dir = e.key === "ArrowRight" ? 1 : -1;
            const next = segs[(pos + dir + segs.length) % segs.length];
            zoomToPanel(next.index);
            // Drop any stale strip-hover so the minimap's wall highlight falls back to
            // the newly FOCUSED border (lit red, as if moused over) until the pointer
            // moves and resumes driving the hover itself.
            setHoveredUnravelEdge(-1);
            return;
          }
        }
      }

      // REVIT-STYLE DIMENSION ENTRY (perimeter draw). Active once at least one vertex
      // is down: typing digits / "." builds the next segment's exact length, Enter
      // commits the vertex at that length in the cursor's direction, Backspace edits,
      // Esc cancels the entry. This intercepts those keys BEFORE the generic
      // Enter/Esc/Backspace handlers below, but only while an entry makes sense, so
      // normal drawing keys are untouched otherwise.
      if (!typing && drawing && perimeter.vertices.length > 0) {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          setDimInput((d) => (d ?? "") + e.key);
          return;
        }
        if (e.key === ".") {
          e.preventDefault();
          // Start as "0." so it reads as a number; never allow two decimal points.
          setDimInput((d) => (d === null ? "0." : d.includes(".") ? d : d + "."));
          return;
        }
        // The remaining keys only matter once an entry is actually in progress, so
        // when no dimension is being typed they fall through to their usual handlers.
        if (dimInput !== null) {
          if (e.key === "Backspace") {
            e.preventDefault();
            setDimInput((d) => {
              if (d === null) return null;
              const next = d.slice(0, -1);
              return next.length ? next : null;
            });
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            commitDimVertex();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setDimInput(null);
            return;
          }
        }
      }

      // Curve-type shortcuts: A = arc, L = line (for segments drawn next).
      if (!typing && (e.key === "a" || e.key === "A")) {
        setCurveType("arc");
        return;
      }
      if (!typing && (e.key === "l" || e.key === "L")) {
        setCurveType("line");
        return;
      }

      if (e.key === "Enter" && !typing) {
        if (drawing && perimeter.vertices.length >= 3) {
          recordHistory();
          setPerimeter((p) => closePerimeter(p));
          setMode("edit");
        }
      } else if (e.key === "Escape") {
        // The export popup owns Esc while open (its own capture listener closes it);
        // don't let the canvas Esc actions (zoom-out, etc.) also fire underneath it.
        if (exportPopup) return;
        // Esc cancels an armed Export-select tool (and any in-progress marquee).
        if (exportSelectMode) {
          setExportSelectMode(false);
          setMarquee(null);
          setExportSelection(new Set());
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc closes the Settings popup first of all, then the Statistics menu, the
        // View menu, the Floor Lines menu, the CW Type menu, disarms the Mullions tool, and so on.
        if (settingsOpen) {
          setSettingsOpen(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (statsMenuOpen) {
          setStatsMenuOpen(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (viewMenuOpen) {
          setViewMenuOpen(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (cwMenuOpen) {
          setCwMenuOpen(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (mullionsOn) {
          setMullionsOn(false);
          setMullionHover(null);
          setMullionDraft(null);
          setCellEdgeHover(null);
          setCellFrameDraft(null);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc disarms the (scaffolded) Type tool.
        if (typeOn) {
          setTypeOn(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc first disarms the Subtractive division tool (and drops its preview),
        // keeping the panel selected so a second Esc exits the zoom.
        if (subtractiveOn) {
          setSubtractiveOn(false);
          setDivideHover(null);
          setDivideDraft(null);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc also disarms the Eraser (drops its deletion highlight and any
        // in-progress drag collection) before exiting the zoom.
        if (eraserOn) {
          setEraserOn(false);
          setEraseHover(null);
          setEraseDragCollected([]);
          setHoveredVertex(-1); // drop the perimeter vertex delete-highlight too
          setEraseVertexCollected([]); // and any in-progress vertex sweep
          setEraseEdgeCollected([]); // and any in-progress edge sweep
          setEraseEdge(-1);
          dragRef.current = null;
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Then disarms the floor-plate tool if it's active.
        if (floorPlateMode) {
          setFloorPlateMode(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // In the unravel view, Esc backs out ONE navigation layer at a time. Deepest
        // first: from the Assembly cell zoom, return to the focused panel (keep the
        // panel selected). Otherwise fall through to the panel-exit logic below.
        if (unravelOn && focusedCell !== null && focusedPanel !== null) {
          setFocusedCell(null);
          zoomToPanel(focusedPanel);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Next, Esc exits a panel double-click zoom (restoring the full-strip fit).
        if (unravelOn && focusedPanel !== null) {
          if (focusedPanel !== null) {
            setFocusedPanel(null);
            fitUnravel(unravelGap, unravelHeights, unravelHeight);
          }
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (drawing) {
          // Cancel the in-progress polyline.
          if (perimeter.vertices.length > 0) recordHistory();
          setPerimeter(emptyPerimeter());
        }
        setSelectedVertex(-1);
        (document.activeElement as HTMLElement)?.blur?.();
      } else if ((e.key === "Backspace" || e.key === "Delete") && !typing) {
        if (drawing) {
          if (perimeter.vertices.length === 0) return;
          e.preventDefault();
          recordHistory();
          setPerimeter((p) => popVertex(p));
        } else if (mode === "edit" && selectedVertex >= 0) {
          e.preventDefault();
          recordHistory();
          setPerimeter((p) => deleteVertex(p, selectedVertex));
          setSelectedVertex(-1);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    drawing,
    mode,
    perimeter.vertices.length,
    selectedVertex,
    saveCurrent,
    unravelOn,
    statsMenuOpen,
    cwMenuOpen,
    viewMenuOpen,
    mullionsOn,
    typeOn,
    focusedPanel,
    focusedCell,
    unravelResult,
    zoomToPanel,
    fitUnravel,
    unravelGap,
    unravelHeights,
    unravelHeight,
    undo,
    redo,
    recordHistory,
    floorPlateMode,
    helpOpen,
    subtractiveOn,
    eraserOn,
    dimInput,
    commitDimVertex,
    settingsOpen,
    exportSelectMode,
    exportPopup,
  ]);

  // CW-TYPE GATE for the bottom-left cluster + Eraser. Floor Lines, Centerlines,
  // Framing, and the Eraser are only enabled once the SELECTED panel has a CW Type
  // assigned (cwType !== null, which implies the unravel view AND a focused panel).
  // Whenever the type is lost — deselecting the panel, leaving the unravel view, or
  // focusing a panel with no type yet — de-arm every armed cluster tool and drop its
  // in-flight preview so a now-disabled button is never left visually "active".
  useEffect(() => {
    if (cwType !== null) return;
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setMullionsOn(false);
    setMullionDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setTypeOn(false);
  }, [cwType]);

  // A typed dimension only makes sense mid-draw; drop any leftover entry as soon as
  // drawing stops (polyline closed/cancelled, switched to edit, entered unravel).
  useEffect(() => {
    if (!drawing && dimInput !== null) setDimInput(null);
  }, [drawing, dimInput]);

  // GROUND-PLATE INVARIANT: whenever the unravel/elevation view is active, a
  // floor plate at the ground datum (model y = 0, level 0, the panels' bottom
  // baseline) MUST exist. toggleUnravel adds it on ENTRY, but several other paths
  // replace floorPlates without it — loading a saved entry (esp. older saves),
  // undo/redo restoring a pre-ground snapshot, or click-removing a near-0 plate.
  // This single guard re-asserts the datum across ALL of them: if we're in the
  // view and no ~0 plate is present, append one (kept sorted bottom→top).
  //   - NOT an undo step: like the toggleUnravel insert, this is view scaffolding,
  //     not an authored edit — no recordHistory().
  //   - No infinite loop: it only adds when missing, and returns the SAME array
  //     reference when a ~0 plate already exists, so React bails (no re-render).
  //   - Interplay with auto-save: when this fires after a load, the auto-save
  //     effect persists the added 0 into the active entry; its JSON no-op guard
  //     then sees them equal and stops, so there's no write loop.
  useEffect(() => {
    if (!unravelOn) return;
    setFloorPlates((plates) => {
      if (plates.some((p) => Math.abs(p) <= 1e-6)) return plates; // datum present
      return [...plates, 0].sort((a, b) => a - b);
    });
  }, [unravelOn, floorPlates]);

  // The Mullions tool acts on the focused panel's grid lines, so drop its hover
  // highlight + any in-flight drag draft when the selection is lost or we leave the
  // unravel view (the tool can stay armed, ready for the next focused panel).
  useEffect(() => {
    if (!unravelOn || focusedPanel === null) {
      setMullionHover(null);
      setMullionDraft(null);
    }
    // The Unitized cell-framing hover is Panels-tab only, so also drop it when we drill
    // into the Assembly cell zoom (focusedCell set) or leave the focused panel/view.
    if (!unravelOn || focusedPanel === null || focusedCell !== null) {
      setCellEdgeHover(null);
      setCellFrameDraft(null);
    }
  }, [unravelOn, focusedPanel, focusedCell]);

  // Close the help popup on Escape (a predictable, obvious dismissal alongside the
  // close button and the outside-click overlay). Bound only while it is open.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setHelpMenuOpen(false);
        setHelpPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen]);

  // The Statistics dropdown is intentionally "sticky": it does NOT close on Escape
  // or on any canvas click / pointer interaction, so the user can leave the live
  // stats visible while working. The ONLY way to close it is to click the
  // Statistics button again (the toggle in the JSX below).

  // ---------------------------------------------------------------------------
  // CANVAS SIZING (DPR-aware) + RENDER LOOP (render on state change).
  // ---------------------------------------------------------------------------

  useLayoutEffect(() => {
    const resize = () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Re-centre origin the first time we get a real size.
      setViewport((vp) => (vp.originX === 400 && vp.originY === 300 ? defaultViewport(w, h) : vp));
      paint();
    };
    resize();
    window.addEventListener("resize", resize);
    // Observe the canvas wrapper directly so ANY layout change that resizes it —
    // not just a window resize — re-fits the canvas. This is what makes collapsing
    // the left tool panel (which widens the stage) immediately grow the canvas to
    // fill the reclaimed space instead of leaving a stale gap.
    const ro = new ResizeObserver(() => resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", resize);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;

    // Subtractive equal-split preview + LIVE SPACING DIMENSION. The recommendation is
    // an even split of the selected panel into N equal bays. Lines come from the active
    // drag (priority) or the hover, both via the SAME pure generators as the commit.
    // While Shift is held the split is HORIZONTAL (equal-height ROWS, `buildEqualRows`,
    // with a VERTICAL measure dimension); otherwise VERTICAL (equal-width COLUMNS,
    // `buildEqualColumns`, with a HORIZONTAL measure dimension). The `dim` measures ONE
    // bay under the cursor, so the user sees the resulting column width / row height.
    let dividePreview: RenderState["dividePreview"] = null;
    if (subtractiveOn && focusedPanel !== null) {
      const draw = unravelDraws?.find((d) => d.seg.index === focusedPanel);
      if (draw) {
        const lo = Math.min(draw.seg.x0, draw.seg.x1);
        const hi = Math.max(draw.seg.x0, draw.seg.x1);
        const panelH = Math.max(draw.height, 0);
        const draftActive = divideDraft && divideDraft.edge === focusedPanel;
        // HORIZONTAL (equal rows) when Shift is held OR an in-flight drag is on the H axis.
        const horizontal = draftActive ? divideDraft!.axis === "h" : shiftHeld;
        if (horizontal) {
          // Hover gate: only recommend when the cursor is strictly INSIDE the panel
          // height (not on the baseline / top border), mirroring the column gate.
          const ys =
            draftActive
              ? divideDraft!.lines
              : divideHover && divideHover.y > 1e-6 && divideHover.y < panelH - 1e-6
                ? buildEqualRows(divideHover.y, 0, panelH, floorPlates)
                : null;
          if (ys && ys.length > 0) {
            // Rows may be UNEQUAL across the panel when floor-plate guides split it into
            // bands, so measure the row the cursor sits in directly from the resulting
            // lines (baseline 0 + ys + panel top) rather than assuming panelH / N.
            const bounds = [0, ...ys, panelH];
            const cy = cursorModel ? Math.max(0, Math.min(panelH, cursorModel.y)) : panelH / 2;
            let bi = 0;
            while (bi < bounds.length - 2 && cy > bounds[bi + 1]) bi++;
            const cx = cursorModel ? Math.max(lo, Math.min(hi, cursorModel.x)) : (lo + hi) / 2;
            const dim = { x1: cx, y1: bounds[bi], x2: cx, y2: bounds[bi + 1], dist: bounds[bi + 1] - bounds[bi] };
            dividePreview = { edge: focusedPanel, ys, dim };
          }
        } else {
          const xs =
            draftActive
              ? divideDraft!.lines
              : divideHover && divideHover.x > lo + 1e-6 && divideHover.x < hi - 1e-6
                ? buildEqualColumns(divideHover.x, draw.seg.x0, draw.seg.x1)
                : null;
          if (xs && xs.length > 0) {
            // N equal columns => width = panelWidth / N (N = lines + 1).
            const step = (hi - lo) / (xs.length + 1);
            // Dimension the COLUMN the cursor sits in (horizontal measure line under the cursor).
            const cx = cursorModel ? cursorModel.x : (lo + hi) / 2;
            const idx = Math.max(0, Math.min(xs.length, Math.floor((cx - lo) / step)));
            const cy = cursorModel ? Math.max(0, Math.min(panelH, cursorModel.y)) : panelH / 2;
            const dim = { x1: lo + idx * step, y1: cy, x2: lo + (idx + 1) * step, y2: cy, dist: step };
            dividePreview = { edge: focusedPanel, xs, dim };
          }
        }
      }
    }

    // Eraser deletion highlights: resolve all targeted lines (hover + any collected
    // during a drag stroke) into render coordinates. The renderer draws each line in
    // the distinct deletion colour so the user sees exactly what a release will remove.
    const eraseHighlight: Array<{ edge: number; axis: "v" | "h"; offset: number }> = [];
    const eraseFloorPlates: number[] = [];
    if (eraserOn) {
      // Union of collected-during-drag and the current cursor hover target.
      const seen = new Set<string>();
      const allTargets: EraseTarget[] = [...eraseDragCollected];
      if (eraseHover) {
        const key = `${eraseHover.axis}:${eraseHover.edge}:${eraseHover.index}`;
        if (!allTargets.some((t) => `${t.axis}:${t.edge}:${t.index}` === key)) {
          allTargets.push(eraseHover);
        }
      }
      for (const target of allTargets) {
        const key = `${target.axis}:${target.edge}:${target.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (target.axis === "fp") {
          const y = floorPlates[target.index];
          // Never flag the permanent ground datum (y ≈ 0) for deletion.
          if (y !== undefined && Math.abs(y) > 1e-6) eraseFloorPlates.push(y);
        } else {
          const arr = target.axis === "v" ? panelDivisions[target.edge] : panelDividersH[target.edge];
          const offset = arr?.[target.index];
          if (offset !== undefined) eraseHighlight.push({ edge: target.edge, axis: target.axis, offset });
        }
      }
    }

    // Erase tool (perimeter view): the edges flagged for removal (hover + drag-collected,
    // deduped) and the vertices flagged for deletion — those explicitly swept up PLUS any
    // that the targeted edges would orphan (both incident walls gone), previewed in red so
    // the auto-drop is visible before release. Both empty outside the armed perimeter view.
    let eraseEdges: number[] = [];
    let erasePreviewVertices = eraseVertexCollected;
    if (eraserOn && !unravelOn) {
      const edgeSet = new Set(eraseEdgeCollected);
      if (eraseEdge >= 0) edgeSet.add(eraseEdge);
      eraseEdges = [...edgeSet];
      const n = perimeter.vertices.length;
      if (perimeter.closed && n > 0 && edgeSet.size > 0) {
        // Vertex i sits between edge (i-1+n)%n and edge i; both gone → it is orphaned.
        const vset = new Set(eraseVertexCollected);
        for (let i = 0; i < n; i++) {
          if (edgeSet.has((i - 1 + n) % n) && edgeSet.has(i)) vset.add(i);
        }
        erasePreviewVertices = [...vset];
      }
    }

    // Cell tint highlight. In the PANELS phase it follows the HOVERED cell (resolve
    // the hovered index back to its model rect). Once a cell is clicked into (ASSEMBLY,
    // focusedCell set) the SELECTED cell stays tinted — so the zoomed-in cell still
    // reads as the selected one — rather than the highlight disappearing.
    let hoveredCellRect: RenderState["hoveredCell"] = null;
    if (unravelOn && focusedPanel !== null) {
      if (focusedCell !== null) {
        hoveredCellRect = { x0: focusedCell.x0, x1: focusedCell.x1, y0: focusedCell.y0, y1: focusedCell.y1 };
      } else if (hoveredCell >= 0) {
        hoveredCellRect = cellsForEdge(focusedPanel)[hoveredCell] ?? null;
      }
    }

    const state: RenderState = {
      perimeter,
      viewport,
      cursorModel,
      drawing,
      // Suppress the rubber-band while pulling a handle (the handle line is the
      // relevant feedback then, not a segment to the cursor).
      rubberBand: drawing && activeDrawHandle < 0,
      // REVIT-STYLE DIMENSION ENTRY: while a length is being typed, the rubber band
      // ends at the typed distance along the cursor direction (dimPreview) and shows
      // the raw typed string (dimText) verbatim, so a partial like "12." is visible.
      dimPreview,
      dimText: dimInput,
      selectedVertex,
      hoveredVertex,
      // Erase tool armed in the perimeter view → draw the hovered vertex in the
      // delete colour so it reads as "click to remove".
      eraseVertexArmed: eraserOn && !unravelOn,
      // Vertices flagged for deletion during an Erase stroke — swept up plus any the
      // collected edges would orphan — previewed in the delete colour (see above).
      eraseVertices: erasePreviewVertices,
      // Erase tool: the perimeter edges flagged for removal (hover + drag-collected),
      // each drawn in the delete colour so the user sees which segments a release removes.
      eraseEdges,
      // Show handles for the vertex being curve-edited: the selected one in edit
      // mode, or the one whose handle is being pulled while drawing.
      handleVertex: mode === "edit" ? selectedVertex : activeDrawHandle,
      insertPreview,
      gridSpacing,
      unravel: unravelDraws2d,
      hoveredUnravelEdge,
      hoveredUnravelTop,
      // Export selection highlight + live marquee — only meaningful in the unravel
      // view, so gate on it (the renderer also only reads them there).
      exportSelection: unravelOn ? exportSelection : null,
      marquee: unravelOn ? marquee : null,
      // Per-cell hover highlight (Panels phase): the model-space rectangle of the
      // grid cell under the cursor, or null. Drawn tinted so the panel reads as a
      // set of individually navigable cells.
      hoveredCell: hoveredCellRect,
      // The double-click-focused panel doubles as the SELECTED panel (the active
      // Additive / Subtractive target). The renderer draws its width label in the
      // floor-plate grey to signal the selection.
      selectedUnravelPanel: focusedPanel ?? -1,
      // PANELS phase ONLY (one panel focused, not in the deeper Assembly cell zoom):
      // tell the renderer to dimension this panel's grid per column (top) / per row
      // (left). -1 in every other phase so the per-band labels never appear in the
      // full Elevations strip, the Assembly cell zoom, or the perimeter view.
      cellDimEdge: unravelOn && focusedPanel !== null && focusedCell === null ? focusedPanel : -1,
      // ASSEMBLY phase ONLY (a single cell zoomed-into): the focused cell's model
      // rect, so the renderer annotates all four of its edges with a dimension
      // label (top/bottom = width, left/right = height). null in every other phase.
      focusedCellDims:
        unravelOn && focusedCell !== null
          ? { x0: focusedCell.x0, x1: focusedCell.x1, y0: focusedCell.y0, y1: focusedCell.y1 }
          : null,
      // ASSEMBLY phase: which of the focused cell's edges the cursor is hovering, so
      // the renderer strokes that one edge red. null when not near any edge.
      focusedCellEdge: unravelOn && focusedCell !== null ? hoveredCellEdge : null,
      floorPlates,
      // Floor Lines "Hide" — suppress drawing every floor line (and its label / eraser
      // highlight) without deleting them. A view preference from the Floor Lines eye icon.
      floorPlatesHidden: !floorLinesVisible,
      // Centerlines / Framing "Hide" — same view preference, toggled by the eye icon on
      // each tool button; suppresses drawing those elements without deleting them.
      centerlinesHidden: !centerlinesVisible,
      framingHidden: !framingVisible,
      // Dim "Hide" — the Dim button (and its eye) is the single source of truth for the
      // on-canvas dimension labels; no view auto-hides them.
      dimensionsHidden: !dimensionsVisible,
      // Ghosted preview line follows the cursor's elevation while the tool is
      // armed, run through the SAME snap helper as placement so the ghost line
      // (and its elevation label) sits exactly where a click would drop the plate
      // — including the increment magnet and the Shift bypass.
      floorPlatePreview: floorPlateMode && cursorModel ? snapFloorPlateY(cursorModel.y) : null,
      // Subtractive division preview + live spacing dimension (computed above).
      dividePreview,
      // Eraser deletion highlights — panel division lines and floor plates (computed above).
      eraseHighlight,
      eraseFloorPlates,
      // CLEAN view: white panel fill; only the DIMENSION labels are hidden. Floor lines,
      // centerlines, and framing are NEVER auto-hidden by any view — they follow only their
      // per-button eye icons (floorPlatesHidden / centerlinesHidden / framingHidden above).
      cellClean: cellViewMode === "clean",
      // SHADOWS view: clean white glass PLUS raised-frame hard drop shadows (2.5D).
      cellShadows: cellViewMode === "shadows",
    };
    render(ctx, canvas, w, h, dpr, state);
  }, [
    perimeter,
    viewport,
    cursorModel,
    dimPreview,
    dimInput,
    drawing,
    mode,
    activeDrawHandle,
    selectedVertex,
    hoveredVertex,
    insertPreview,
    gridSpacing,
    unravelDraws2d,
    hoveredUnravelEdge,
    hoveredUnravelTop,
    unravelOn,
    exportSelection,
    marquee,
    focusedPanel,
    // Per-cell hover highlight (Panels phase): repaint as the hovered cell changes.
    focusedCell,
    hoveredCell,
    // Assembly phase: repaint as the hovered cell EDGE changes (red highlight).
    hoveredCellEdge,
    cellsForEdge,
    floorPlates,
    floorPlateMode,
    floorLinesVisible,
    centerlinesVisible,
    framingVisible,
    dimensionsVisible,
    // Preview elevation is now run through snapFloorPlateY (reads floorPlates /
    // shiftHeld / viewport), so repaint when the snap result can change.
    snapFloorPlateY,
    // Subtractive division preview repaints as it changes. `shiftHeld` flips the
    // preview AXIS (rows vs columns), so toggling Shift repaints immediately.
    subtractiveOn,
    divideHover,
    divideDraft,
    shiftHeld,
    // Eraser deletion highlight repaints as the targeted line changes. The panel
    // arrays are read to resolve offsets; floorPlates for floor-plate highlights;
    // eraseDragCollected for the in-progress drag stroke.
    eraserOn,
    eraseHover,
    eraseDragCollected,
    eraseVertexCollected,
    eraseEdge,
    eraseEdgeCollected,
    panelDivisions,
    panelDividersH,
    floorPlates,
    // Clean/Shadows views repaint the panels white (floor lines, centerlines, framing,
    // and dimensions follow their per-button toggles, not the view mode).
    cellViewMode,
    // Repaint every on-canvas dimension label when the display unit changes (the
    // renderer's formatters read the active unit from core/units at paint time).
    unitSystem,
  ]);

  useEffect(() => {
    paint();
  }, [paint]);

  // ---------------------------------------------------------------------------
  // DERIVED READOUTS
  // ---------------------------------------------------------------------------

  /** Whether the current shape has enough edges to unravel. */
  const canUnravel = perimeter.vertices.length >= 2;

  /**
   * Toggle the unravel view; on entry, clear transient edit state and fit the strip.
   * `skipFitOnEnter` suppresses the automatic strip-fit when entering, so a caller
   * can immediately animate to a DIFFERENT target (e.g. the Panels nav button zooming
   * straight to the first panel) without the strip-fit running afterwards and
   * cancelling it — the fit here is dispatched from inside the state updater, so it
   * would otherwise win the race against a fit queued synchronously before this call.
   */
  const toggleUnravel = useCallback((skipFitOnEnter = false) => {
    setUnravelOn((on) => {
      const next = !on;
      if (next) {
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
        setHoveredEdge(-1);
        // Entering the elevation view guarantees a ground-level floor plate (model
        // y = 0, the ground floor / level 0) so the user starts with the ground
        // line drawn. Add one only if no ~0 plate already exists (epsilon guards
        // against float dupes). Like the other view-state resets here, this is not
        // a separate history step. Kept sorted bottom→top to match the click handler.
        setFloorPlates((plates) => {
          if (plates.some((p) => Math.abs(p) <= 1e-6)) return plates;
          return [...plates, 0].sort((a, b) => a - b);
        });
      } else {
        // Leaving the view: drop any active hover-link highlight + resize affordance
        // and the double-click zoom focus.
        setHoveredUnravelEdge(-1);
        setHoveredUnravelTop(-1);
        setFocusedPanel(null);
        setFocusedCell(null); // leave the Assembly cell context too (phase consistency)
      }
      if (next && !skipFitOnEnter) fitUnravel(unravelGap, unravelHeights, unravelHeight);
      return next;
    });
  }, [fitUnravel, unravelGap, unravelHeights, unravelHeight]);

  /** Give the selected vertex symmetric handles tangent to its neighbours
   *  (corner → smooth curve), so both adjacent segments bow. */
  const smoothSelected = () => {
    if (selectedVertex < 0) return;
    const v = perimeter.vertices;
    const n = v.length;
    if (n < 2) return;
    const i = selectedVertex;
    const hasPrev = i > 0 || perimeter.closed;
    const hasNext = i < n - 1 || perimeter.closed;
    const prev = v[(i - 1 + n) % n];
    const next = v[(i + 1) % n];
    const cur = v[i];
    // Tangent direction: from prev to next (or whichever neighbour exists).
    const from = hasPrev ? prev : cur;
    const to = hasNext ? next : cur;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const refLen = Math.min(distance(cur, hasPrev ? prev : next), distance(cur, hasNext ? next : prev)) / 3 || 1;
    const off = { x: (dx / len) * refLen, y: (dy / len) * refLen };
    recordHistory();
    setPerimeter((p) => setHandle(p, i, "out", off, true));
  };

  const cornerSelected = () => {
    if (selectedVertex < 0) return;
    recordHistory();
    setPerimeter((p) => clearVertexHandles(p, selectedVertex));
  };

  // Current workflow phase derived from view state:
  //   perimeter  — drawing / editing the building footprint (default)
  //   elevations — the unravelled panel strip (all walls laid flat)
  //   panels     — zoomed into a single panel (double-click from elevations)
  //   assembly   — zoomed into a single grid CELL of the focused panel (deepest)
  const phase = !unravelOn
    ? "perimeter"
    : focusedCell !== null
    ? "assembly"
    : focusedPanel !== null
    ? "panels"
    : "elevations";

  // Does ANY panel in the project carry centerlines (Centerlines tool divisions /
  // dividers)? Gates the Cells tab: with centerlines anywhere the user can jump
  // straight to the cells view; with none there is nothing to navigate into.
  const hasAnyCenterlines =
    Object.values(panelDivisions).some((a) => a.length > 0) ||
    Object.values(panelDividersH).some((a) => a.length > 0);

  // Has ANY panel been assigned a curtain-wall type? `cwType` above only reflects the
  // FOCUSED panel, so when the user picks a CW Type with no panel focused (which
  // applies it to every panel) it stays null. This project-wide check drives the
  // Floor Lines / Centerlines enablement so selecting a CW type unlocks them even
  // without a focused panel.
  const hasAnyCwType = Object.values(panelCwType).some((t) => t != null);

  // Floor Lines gate: floor lines are GLOBAL, so the button is available in the
  // unravel view once a CW type is assigned anywhere (focused panel's, or applied to all).
  const canPlaceLines = unravelOn && hasAnyCwType;

  // Centerlines gate: centerlines are placed on the SELECTED wall border, so the
  // button requires a FOCUSED panel that HAS a CW type. `cwType` is the focused
  // panel's type (null when no panel is focused OR the focused panel has no type),
  // so this stays disabled until the user opens the Wall Border tab / clicks a wall
  // border AND that border carries a CW type.
  const canPlaceCenterlines = cwType !== null;

  // Framing gate: framing offsets are measured FROM centerlines, so the button
  // becomes available only once the FOCUSED panel carries at least one centerline
  // (a vertical division or a horizontal divider). With no centerlines there is
  // nothing to frame, so it stays disabled.
  const canFrame =
    focusedPanel !== null &&
    ((panelDivisions[focusedPanel]?.length ?? 0) > 0 ||
      (panelDividersH[focusedPanel]?.length ?? 0) > 0);

  // Type gate: the (scaffolded) Type tool acts on a panel's FRAMES, so it becomes
  // available only once the FOCUSED panel carries at least one frame — a Stick mullion
  // offset (vertical OR horizontal) or any Unitized per-cell inset. With no frame there
  // is nothing to type, so it stays disabled (which also keeps it disabled in the
  // Building Perimeter tab, where no panel can be focused).
  const canType =
    focusedPanel !== null &&
    ((panelMullionsV[focusedPanel] ?? 0) > 0 ||
      (panelMullionsH[focusedPanel] ?? 0) > 0 ||
      Object.values(panelCellFraming[focusedPanel] ?? {}).some(
        (ins) => ins.top > 0 || ins.right > 0 || ins.bottom > 0 || ins.left > 0,
      ));

  // AUTO-DISARM ON GATE LOSS: a tool that is armed (blue) must un-arm the moment its
  // enablement condition goes false — e.g. losing the focused panel disables the
  // Centerlines tool, which would otherwise stay blue but unclickable. Each effect
  // mirrors clicking the tool off (drops the tool's in-flight previews too).
  useEffect(() => {
    if (!canPlaceLines && floorPlateMode) setFloorPlateMode(false);
  }, [canPlaceLines, floorPlateMode]);
  useEffect(() => {
    if (!canPlaceCenterlines && subtractiveOn) {
      setSubtractiveOn(false);
      setDivideHover(null);
      setDivideDraft(null);
    }
  }, [canPlaceCenterlines, subtractiveOn]);
  useEffect(() => {
    if (!canFrame && mullionsOn) {
      setMullionsOn(false);
      setMullionHover(null);
      setMullionDraft(null);
      setCellEdgeHover(null);
      setCellFrameDraft(null);
    }
  }, [canFrame, mullionsOn]);
  useEffect(() => {
    if (!canType && typeOn) setTypeOn(false);
  }, [canType, typeOn]);
  // Render / Constraint / Export are unravel-view only — un-arm them on returning to
  // the Building Perimeter tab so none lingers while its button is disabled, and drop
  // the export marquee / selection / popup (all only make sense in the unravel view).
  useEffect(() => {
    if (!unravelOn) {
      setRenderOn(false);
      setConstraintOn(false);
      setExportSelectMode(false);
      setExportSelection(new Set());
      setMarquee(null);
      setExportPopup(null);
    }
  }, [unravelOn]);
  // Leaving the Building Perimeter tab (entering an unravel/elevation view) clears the
  // perimeter Draw/Edit/Erase selection so none stays highlighted on another tab.
  // Draw/Edit de-highlight on their own (their active state is gated to phase ===
  // "perimeter"); Erase is not phase-gated, so disarm it explicitly here. Keyed ONLY on
  // the unravelOn transition (not eraserOn) so re-arming Erase inside the unravel view —
  // where it deletes centerlines / floor lines — is not immediately undone.
  useEffect(() => {
    if (unravelOn) setEraserOn(false);
  }, [unravelOn]);

  // Is the current sketch SAVED (a saved project is loaded/active)? A brand-new sketch
  // has activeSavedId == null until "＋ Save current sketch" is used (see the auto-save
  // effect). The downstream tabs (Elevations / Wall Border / Cells) stay disabled until
  // then, so the user commits the footprint to a project before designing on top of it.
  const isSaved = activeSavedId !== null;

  // CONTEXTUAL TOOL HINT — short red guidance shown right of the X/Y cursor
  // readouts in the status bar, coaching new users on what the active tool does.
  // Priority: armed bottom-cluster tools first (mutually exclusive), then the
  // perimeter draw/edit fallback. Empty string ⇒ no hint shown. Keep each entry
  // terse and action-first; wording mirrors the ControlsList ("?" help) so the two
  // never disagree — update both together when a control changes.
  const toolHint = subtractiveOn
    ? "Move cursor to size the split · click to place · hold Shift for horizontal rows"
    : mullionsOn
    ? cwType === "unitized"
      ? "Click-drag a cell edge to inset framing · hold Shift to inset all four edges"
      : "Click-drag a grid line to set the mullion offset (both sides)"
    : eraserOn
    ? unravelOn
      ? "Click a centerline or floor line to delete · drag across several to erase in one stroke"
      : "Click a perimeter vertex to delete it · drag across several to erase in one stroke"
    : floorPlateMode
    ? "Click to place a floor line · hold Shift to bypass snapping"
    : phase === "perimeter" && mode === "draw" && perimeter.vertices.length > 0
    ? "Click to place vertices · click-drag to convert to arc · hold Shift to lock 15° · double-click or Enter to close"
    : phase === "perimeter" && mode === "edit"
    ? "Drag a vertex to move · drag a knob to curve · double-click a vertex for a corner"
    : // Show whenever the FOCUSED wall border still has no CW Type (every time the user
      // clicks into a type-less border, not just the very first one), and as the initial
      // onboarding cue in the elevations overview while NO panel has a type yet.
      unravelOn && cwType === null && (focusedPanel !== null || Object.keys(panelCwType).length === 0)
    ? "Assign a CW Type to start"
    : "";

  return (
    <div className={`app ${panelCollapsed ? "app--panel-collapsed" : ""}`}>
      {/* ===== NAVIGATION HEADER ===== */}
      <header className="nav-header">
        {/* NEW PROJECT — a blank-slate reset (like refreshing the page, but without the
            onboarding hint). The only way to start a new project without reloading. */}
        <button
          className="nav-header__new"
          onClick={newProject}
          title="Create a new project"
          aria-label="New project"
        >
          ＋
        </button>
        <button
          className={`nav-header__btn ${phase === "perimeter" ? "is-active" : ""}`}
          onClick={() => {
            // Exit the unravel view if needed, then frame the footprint — like clicking
            // the minimap. Runs even when ALREADY in Perimeter, so it re-fits the zoom.
            if (unravelOn) toggleUnravel();
            if (perimeter.vertices.length > 0) {
              const { w, h } = sizeRef.current;
              animateViewport(fitViewport(perimeter, w, h, 64));
            }
          }}
          title="Building Perimeter — sketch and edit the building footprint"
        >
          Building Perimeter
        </button>
        <button
          className={`nav-header__btn ${phase === "elevations" ? "is-active" : ""}`}
          onClick={() => {
            // Already on the full strip: just re-fit the zoom to show all elevations.
            if (phase === "elevations") { fitUnravel(unravelGap, unravelHeights, unravelHeight); return; }
            if (phase === "perimeter") { if (canUnravel) toggleUnravel(); }
            // From panels OR assembly, back out to the full strip — clear both the
            // panel focus and any deeper cell focus so the phase resolves to elevations.
            else { setFocusedCell(null); setFocusedPanel(null); fitUnravel(unravelGap, unravelHeights, unravelHeight); }
          }}
          disabled={!isSaved}
          title="Unroll Elevations — unwrapped building perimeter"
        >
          Unroll Elevations
        </button>
        <button
          className={`nav-header__btn ${phase === "panels" ? "is-active" : ""}`}
          disabled={!isSaved}
          onClick={() => {
            if (phase === "panels") return;
            // From the deeper Assembly layer, back out ONE level to the focused panel
            // (clear the cell, re-frame the panel) rather than jumping to the first.
            if (phase === "assembly") {
              if (focusedPanel !== null) { setFocusedCell(null); zoomToPanel(focusedPanel); }
              return;
            }
            // From perimeter/elevations: compute the first (left-most) segment directly
            // — unravelResult is null when unravelOn is false, so recalc from perimeter.
            const firstSeg = unravelPerimeter(perimeter, unravelGap).segments[0];
            if (!firstSeg) return;
            // Enter elevations WITHOUT the strip-fit (skipFitOnEnter) so our panel
            // zoom below isn't cancelled by the strip-fit the toggle would otherwise
            // dispatch from its state updater (which runs after this handler).
            if (!unravelOn) toggleUnravel(true);
            // Zoom straight to the first panel.
            const h0 = effectiveHeight(firstSeg.index);
            const { w, h } = sizeRef.current;
            animateViewport(fitViewport(unravelBoundsPerimeter([firstSeg], () => h0), w, h, 56));
            setFocusedPanel(firstSeg.index);
          }}
          title="Wall Border — individual building facades"
        >
          Wall Border
        </button>
        <button
          className={`nav-header__btn ${phase === "assembly" ? "is-active" : ""}`}
          // Cells is clickable once the sketch is SAVED and the project has ANY centerlines
          // — there is a cell to navigate into. Disabled on an unsaved sketch or with no
          // centerlines anywhere.
          disabled={!isSaved || !hasAnyCenterlines}
          onClick={() => {
            if (phase === "assembly") return;
            // Jump to a cell: prefer the focused panel when it has centerlines, else the
            // first panel that does. Works from ANY phase (recompute the strip directly
            // since unravelResult is null before the view is on).
            const segs = unravelResult?.segments ?? unravelPerimeter(perimeter, unravelGap).segments;
            const edge =
              focusedPanel !== null && panelHasSubtractiveCells(focusedPanel)
                ? focusedPanel
                : segs.find((s) => panelHasSubtractiveCells(s.index))?.index ?? -1;
            if (edge < 0) return;
            // Default to the top-left-most cell (left-most column, top-most row).
            const cell = topLeftCell(cellsForEdge(edge));
            if (!cell) return;
            // Enter the unravel view if needed (skip the strip-fit; our cell zoom follows).
            if (!unravelOn) toggleUnravel(true);
            setFocusedPanel(edge);
            zoomToCell({ edge, ...cell });
          }}
          title="Cells — single panel units"
        >
          Cells
        </button>
        {/* RIGHT GROUP — search bar + settings gear, pushed to the far right of the header. */}
        <div className="nav-header__right">
          <div className="nav-header__search-wrap">
            <input
              className="nav-header__search"
              type="text"
              placeholder="Smart search"
              aria-label="Smart search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <span className="nav-header__search-sizer" aria-hidden="true">
              {searchQuery || "Smart search"}
            </span>
          </div>
          {/* EXPORT — between the Smart Search bar and the Settings gear. Arms the
              wall-selection MARQUEE (unravel/elevation views only): click-drag a box over
              the panels to pick walls, release opens the export dialog. Blue while armed,
              white otherwise; disabled in the Building Perimeter tab. */}
          <button
            className={`nav-header__export ${exportSelectMode ? "is-active" : ""}`}
            onClick={toggleExportSelect}
            disabled={!unravelOn}
            aria-pressed={exportSelectMode}
            title={
              unravelOn
                ? "Export — click-drag a box over the panels to select walls, then export to Revit / AutoCAD / Rhino (Esc cancels)"
                : "Switch to an elevation view to export walls"
            }
          >
            {exportSelectMode ? "Selecting…" : "Export"}
          </button>
        <button
          className={`nav-header__settings ${settingsOpen ? "is-active" : ""}`}
          onClick={() => setSettingsOpen((on) => !on)}
          title="Settings"
          aria-label="Settings"
          aria-pressed={settingsOpen}
        >
          {/* Gear icon (Lucide-style, stroke-based) — inherits the button's color via
              currentColor, so it tints on hover and inverts in the active state. */}
          <svg
            className="nav-header__settings-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        </div>
      </header>

      {/* ===== LEFT: TOOL PANEL ===== */}
      <aside className="panel">
        {/* CREATE — drawing tools: Segment (Line/Arc) and the curve-handle hint,
            grouped under one titled section. The Draw/Edit MODE toggle lives in the
            bottom-right tool cluster (with Eraser/Dim), not here. */}
        <section className="panel__section">
          <div className="panel__section-title">Create</div>

          <div className="panel__row">
            <span className="panel__label">Segment</span>
            <div className="segmented">
              <button
                className={`segmented__btn ${curveType === "line" ? "is-active" : ""}`}
                onClick={() => setCurveType("line")}
                title="Draw straight segments (shortcut: L)"
              >
                Line (L)
              </button>
              <button
                className={`segmented__btn ${curveType === "arc" ? "is-active" : ""}`}
                onClick={() => setCurveType("arc")}
                title="Draw curved segments (shortcut: A) — click-drag to shape the curve"
              >
                Arc (A)
              </button>
            </div>
          </div>
          <div className="panel__hint">
            Click-drag while placing a point to pull out curve handles.
          </div>
        </section>

        {mode === "edit" && selectedVertex >= 0 && (
          <section className="panel__section">
            <div className="panel__section-title">Selected vertex #{selectedVertex}</div>
            <div className="panel__row">
              <button className="btn" onClick={smoothSelected} title="Pull out symmetric curve handles">
                Smooth
              </button>
              <button className="btn" onClick={cornerSelected} title="Remove handles (double-click vertex)">
                Corner
              </button>
            </div>
            <div className="panel__hint">Drag handle knobs to shape · Alt-drag breaks the tangent.</div>
          </section>
        )}

        {/* Live perimeter / unravel statistics formerly shown here now live in the
            "Statistics" dropdown (top of canvas, next to Redo) so they stay visible
            over the canvas without taking panel space. */}

        {/* ===== LOCATION (geo-location of the sketch) =====
            An optional address line to geo-locate the perimeter. Stored with the
            sketch so the planned Mapbox map view can reference it without the user
            re-typing. Blank by default — an untouched sketch has no geolocation. */}
        <section className="panel__section">
          <div className="panel__section-title">Location</div>
          <div className="panel__hint">
            Type an address to geo-locate the sketch (optional — leave blank for none).
          </div>
          <div className="panel__row">
            <input
              className="panel__input"
              type="text"
              value={location.address}
              placeholder="Address (e.g. 123 Main St, City)"
              title="Address used to geo-locate the sketch — optional, leave blank for no location"
              onChange={(e) => setLocation((l) => ({ ...l, address: e.target.value }))}
            />
          </div>
        </section>
      </aside>

      {/* ===== RIGHT: CANVAS + STATUS BAR ===== */}
      <main className="stage">
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={`canvas ${unravelOn && hoveredUnravelTop >= 0 ? "canvas--ns-resize" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            // Suppress the browser's native right-click menu ("Save image as…",
            // "Copy image", "Inspect") over the canvas: right-click-drag is a PAN
            // gesture here, so the context menu would interrupt navigation.
            onContextMenu={(e) => e.preventDefault()}
            onPointerLeave={() => {
              setCursorModel(null);
              setHoveredUnravelEdge(-1);
              setHoveredUnravelTop(-1);
              setHoveredEdge(-1);
              setHoveredCell(-1);
              // Drop the Assembly per-edge red highlight when the cursor leaves.
              setHoveredCellEdge(null);
              // Drop the Subtractive hover preview when the cursor leaves the canvas
              // (an in-progress drag keeps its draft via pointer capture).
              setDivideHover(null);
              // Drop the Eraser deletion highlight too.
              setEraseHover(null);
              setHoveredVertex(-1);
              setEraseEdge(-1);
            }}
            onDoubleClick={onDoubleClick}
          />
          {/* ===== CURSOR CROSSHAIRS =====
              Two thin full-canvas lines tracking the pointer in the Building Perimeter
              view (drawing or editing vertices). Positioned entirely via the native
              pointermove effect above (direct transform writes) for minimal lag.
              Pointer-transparent and low z-index, so it sits over the canvas drawing but
              BEHIND every floating UI panel/control. */}
          {showCrosshair && (
            <div className="crosshair" ref={crosshairRef} aria-hidden="true">
              <div className="crosshair__line crosshair__line--v" ref={crosshairVRef} />
              <div className="crosshair__line crosshair__line--h" ref={crosshairHRef} />
            </div>
          )}
          {/* ===== ONBOARDING HINT =====
              First-run prompt centered on the empty canvas, with a hand-drawn arched
              arrow pointing up toward the Projects panel (top-right). Pointer-transparent
              so it never blocks drawing; it vanishes on the first interaction anywhere
              (see the showHint / pointerdown effect above). */}
          {showHint && (
            <div className="canvas-hint" aria-hidden="true">
              <div className="canvas-hint__text">
                <span>Sketch perimeter</span>
                <span>
                  or load{" "}
                  {/* The arrow is anchored to the word "project" (CSS), so it reads as
                      drawn from it: the tail starts just below the word's centre (around the
                      j/e), dips SOUTH-EAST first, then arcs up to point at the top-right
                      corner. A short, elegant arch. */}
                  <span className="canvas-hint__anchor">
                    project
                    <svg className="canvas-hint__arrow" viewBox="0 0 220 160" fill="none" aria-hidden="true">
                      <path className="canvas-hint__arrow-shaft" d="M18 55 C 55 95, 150 60, 205 14" />
                      {/* Open "V" arrowhead — barbs symmetric about the shaft's end
                          tangent (≈(55,−46)), aimed up-right at the corner. */}
                      <path className="canvas-hint__arrow-head" d="M180 20 L205 14 L194 38" />
                    </svg>
                  </span>
                </span>
              </div>
            </div>
          )}
          {/* ===== FLOATING HISTORY (UNDO/REDO) CONTROLS =====
              Absolutely-positioned cluster at the TOP-LEFT of the canvas (inside
              .canvas-wrap, its positioning context — exactly like the floor-plate
              button below, but pinned to the top instead of the bottom). Sitting
              inside the canvas area keeps it clear of the left tool panel, so it
              never overlaps the panel's controls. Same handlers / disabled rules /
              tooltips as before — only the placement/anchoring moved. */}
          <div className="history-controls">
            <button
              className="history-btn history-btn--icon"
              onClick={undo}
              disabled={undoStack.length === 0}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              ↶
            </button>
            <button
              className="history-btn history-btn--icon"
              onClick={redo}
              disabled={redoStack.length === 0}
              title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              ↷
            </button>
            {/* STATISTICS selector — picks which stats overlay to show on the canvas.
                "None" hides the overlay; "General" shows elevation stats anchored
                below the left-most elevation panel. */}
            <div
              className="stats-anchor"
              // Scroll-wheel cycles the statistics modes WITHOUT opening the menu —
              // mirrors the View button. Only the currently-AVAILABLE modes are in the
              // cycle: the solar diagrams ("Irradiance" + "Insolation") need a wall
              // orientation, so they're skipped outside the unravel/elevation views.
              // No-ops when the selector itself is disabled (no closed perimeter and not
              // in an elevation view).
              onWheel={(e) => {
                if (!unravelOn && !perimeter.closed) return;
                e.stopPropagation();
                const modes: typeof statsMode[] = unravelOn
                  ? ["none", "general", "irradiance", "insolation"]
                  : ["none", "general"];
                // Index off the EFFECTIVE (displayed) mode so cycling in the Building
                // Perimeter view starts from what's shown — a carried-over solar pick
                // reads as "none" there, not an off-list index.
                const idx = modes.indexOf(effectiveStatsMode);
                const next =
                  e.deltaY > 0
                    ? (idx + 1) % modes.length
                    : (idx - 1 + modes.length) % modes.length;
                setStatsMode(modes[next]);
                setStatsMenuOpen(false);
              }}
            >
              <button
                className="history-btn"
                onClick={() => {
                  setStatsMenuOpen((on) => !on);
                  setCwMenuOpen(false);
                  setViewMenuOpen(false);
                  disarmClusterTools();
                }}
                // Enabled in the unravel/elevation views, OR in the Building Perimeter
                // tab once a CLOSED perimeter exists (re-locks if the shape is reopened),
                // so footprint stats are available wherever there's something to measure.
                disabled={!unravelOn && !perimeter.closed}
                title="Select the live statistics to display"
                aria-haspopup="true"
                aria-expanded={statsMenuOpen}
              >
                Statistics: {effectiveStatsMode === "none" ? "None" : effectiveStatsMode === "general" ? "General" : effectiveStatsMode === "irradiance" ? "Irradiance (W/m²)" : "Insolation (kWh/m²)"} ▾
              </button>
              {statsMenuOpen && (
                <div className="view-menu" role="menu">
                  <button
                    className={`view-menu__btn ${effectiveStatsMode === "none" ? "is-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={effectiveStatsMode === "none"}
                    onClick={() => { setStatsMode("none"); setStatsMenuOpen(false); }}
                  >
                    None
                  </button>
                  <button
                    className={`view-menu__btn ${effectiveStatsMode === "general" ? "is-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={effectiveStatsMode === "general"}
                    onClick={() => { setStatsMode("general"); setStatsMenuOpen(false); }}
                  >
                    General
                  </button>
                  {/* The solar diagrams are ELEVATION/wall-border reads (they need a wall
                      orientation), so they're only meaningful in the unravel view; disabled
                      in the Building Perimeter tab. Irradiance = the month×hour W/m² heatmap;
                      Insolation = its monthly kWh/m² energy companion. */}
                  <button
                    className={`view-menu__btn ${effectiveStatsMode === "irradiance" ? "is-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={effectiveStatsMode === "irradiance"}
                    disabled={!unravelOn}
                    title={unravelOn ? undefined : "Available in the elevation views (Unroll Elevations)"}
                    onClick={() => { setStatsMode("irradiance"); setStatsMenuOpen(false); }}
                  >
                    Irradiance (W/m²)
                  </button>
                  <button
                    className={`view-menu__btn ${effectiveStatsMode === "insolation" ? "is-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={effectiveStatsMode === "insolation"}
                    disabled={!unravelOn}
                    title={unravelOn ? undefined : "Available in the elevation views (Unroll Elevations)"}
                    onClick={() => { setStatsMode("insolation"); setStatsMenuOpen(false); }}
                  >
                    Insolation (kWh/m²)
                  </button>
                </div>
              )}
            </div>
            {/* VIEW menu — a purely VISUAL display chooser for the elevation/Panels view
                (NOT a tool: arms nothing, edits nothing). Sits to the RIGHT of Statistics
                in the top-left cluster. Clicking opens a dropdown to pick the cell view
                mode: Material ID tints cells by geometric shape; Orientation Heatmap
                colours by facing direction; Clean is the white-infill presentation view;
                Shadows is reserved (behaviour TBD). The unique-cell count lives in the
                Statistics dropdown. Disabled outside the unravel view. The chevron marks
                it as a menu. */}
            <div
              className="view-anchor"
              onWheel={(e) => {
                if (!unravelOn) return;
                e.stopPropagation();
                const idx = CELL_VIEW_MODES.indexOf(cellViewMode);
                const next =
                  e.deltaY > 0
                    ? (idx + 1) % CELL_VIEW_MODES.length
                    : (idx - 1 + CELL_VIEW_MODES.length) % CELL_VIEW_MODES.length;
                setCellViewMode(CELL_VIEW_MODES[next]);
                setViewMenuOpen(false);
              }}
            >
              <button
                className="view-btn"
                onClick={onViewMenu}
                disabled={!unravelOn}
                aria-haspopup="true"
                aria-expanded={viewMenuOpen}
                title="Select the view mode to display"
              >
                View: {CELL_VIEW_LABELS[cellViewMode]} ▾
              </button>
              {viewMenuOpen && (
                <div className="view-menu" role="menu">
                  {CELL_VIEW_MODES.map((m) => (
                    <button
                      key={m}
                      className={`view-menu__btn ${cellViewMode === m ? "is-active" : ""}`}
                      role="menuitemradio"
                      aria-checked={cellViewMode === m}
                      onClick={() => selectViewMode(m)}
                    >
                      {CELL_VIEW_LABELS[m]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* RENDER · CONSTRAINT — sit at the RIGHT end of the top-left cluster, just
                after the View ("view technical") menu, so the whole technical-view row
                reads as one family. SCAFFOLDED toggle buttons (no behaviour yet): blue
                while armed, white otherwise, and only clickable outside the Building
                Perimeter tab (disabled until the user opens an unravel/elevation view). */}
            <button
              className={`history-btn ${renderOn ? "is-active" : ""}`}
              onClick={() => setRenderOn((on) => !on)}
              disabled={!unravelOn}
              aria-pressed={renderOn}
              title="Render"
            >
              Render
            </button>
            <button
              className={`history-btn ${constraintOn ? "is-active" : ""}`}
              onClick={() => setConstraintOn((on) => !on)}
              disabled={!unravelOn}
              aria-pressed={constraintOn}
              title="Constraint"
            >
              Constraint
            </button>
          </div>
          {/* BOTTOM-LEFT tool cluster — Collapse · CW Type · Floor plate · Centerlines · Framing.
              A flex row (mirrors the top-left .history-controls) so the buttons are
              spaced by a single small gap (--space-1) and stay a tight cluster regardless
              of each button's rendered width. (The Eraser lives by the "?" help button,
              bottom-right; the View button sits next to Statistics, top-left.) */}
          <div className="tool-controls">
            {/* COLLAPSE TOGGLE — collapses / expands the left tool panel. Sits first in
                the cluster so it's always reachable even when the panel is hidden. */}
            <button
              className="panel-collapse-toggle"
              onClick={() => setPanelCollapsed((c) => !c)}
              title="Toggle the left panel"
              aria-label="Toggle the left panel"
              aria-pressed={panelCollapsed}
            >
              {panelCollapsed ? "▸" : "◂"}
            </button>
            {/* CW TYPE — second in the cluster. Assign the curtain-wall system to the
                SELECTED panel. Opens a two-option menu (Stick / Unitized); the chosen one
                relabels the button to "CW Type: <name>" and unlocks the Framing tool for
                that panel. Disabled until a panel is selected, since the system is
                per-panel. Switching a panel's type clears its framing of the other system
                (centerlines kept). */}
            <div className="cw-type-wrap">
              <button
                className="cwtype-btn"
                onClick={onCwType}
                disabled={!unravelOn}
                aria-haspopup="true"
                aria-expanded={cwMenuOpen}
                title="Select curtain wall type"
              >
                {cwType ? `CW Type: ${CW_TYPE_LABELS[cwType]} ▾` : "CW Type ▾"}
              </button>
              {cwMenuOpen && (
                <div className="cw-menu" role="menu">
                  {(Object.keys(CW_TYPE_LABELS) as CwType[]).map((t) => (
                    <button
                      key={t}
                      className={`cw-menu__btn ${cwType === t ? "is-active" : ""}`}
                      role="menuitemradio"
                      aria-checked={cwType === t}
                      onClick={() => selectCwType(t)}
                    >
                      {CW_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* FLOOR LINES — a single-function tool button (no submenu): click ARMS the
                placement tool — while active a ghosted dotted horizontal line tracks the
                cursor and a click drops a floor line; click an existing one to remove; Esc
                or re-click disarms. The eye ICON embedded in the button's right edge toggles
                VISIBILITY of all floor lines (draws / hides without deleting them). Floor
                lines only RENDER in the unravel/elevation view, so the button — and its eye —
                are DISABLED outside it. Stays highlighted while armed. */}
            <div className="floorlines-wrap">
              <button
                className={`floorplate-btn has-vis ${floorPlateMode ? "is-active" : ""}`}
                onClick={onFloorPlace}
                disabled={!canPlaceLines}
                aria-pressed={floorPlateMode}
                title="Place floor lines"
              >
                Floor Lines
              </button>
              <VisToggle
                visible={floorLinesVisible}
                disabled={!canPlaceLines}
                onToggle={() => setFloorLinesVisible((v) => !v)}
                label="floor lines"
              />
            </div>
            {/* CENTERLINES — operates on the panel SELECTED via click, so it is DISABLED
                until a panel is selected (focusedPanel !== null). The armed cluster tools
                (CW Type's Framing / Floor plate / Centerlines) are mutually exclusive —
                arming one disarms the rest. Cluster order: CW Type · Floor plate ·
                Centerlines · Framing (Eraser is bottom-right by the "?"; View is top-left
                by Statistics). */}
            <div className="tool-vis-wrap">
              <button
                className={`subtractive-btn has-vis ${subtractiveOn ? "is-active" : ""}`}
                onClick={onSubtractive}
                disabled={!canPlaceCenterlines}
                aria-pressed={subtractiveOn}
                title="Place centerlines on selected wall border"
              >
                Centerlines
              </button>
              <VisToggle
                visible={centerlinesVisible}
                disabled={!canPlaceCenterlines}
                onToggle={() => setCenterlinesVisible((v) => !v)}
                label="centerlines"
              />
            </div>
            {/* FRAMING — disabled until a CW Type is selected; arms the mullion/framing
                offset tool. Last in the cluster. Mutually exclusive cluster tool. The eye
                ICON embedded in its right edge toggles framing visibility on the canvas. */}
            <div className="tool-vis-wrap">
              <button
                className={`mullions-btn has-vis ${mullionsOn ? "is-active" : ""}`}
                onClick={onMullions}
                disabled={!canFrame}
                aria-pressed={mullionsOn}
                title="Set framing offset from centerlines"
              >
                Framing
              </button>
              <VisToggle
                visible={framingVisible}
                disabled={!canFrame}
                onToggle={() => setFramingVisible((v) => !v)}
                label="framing"
              />
            </div>
            {/* TYPE — to the right of Framing. A SCAFFOLDED cluster tool (no canvas
                behaviour yet): enabled only when the focused wall border has at least one
                frame, armed/blue like the other tools, and disabled in the Building
                Perimeter tab (no panel focused there). Its eye icon toggles a wired no-op
                visibility flag for now. */}
            <div className="tool-vis-wrap">
              <button
                className={`type-btn has-vis ${typeOn ? "is-active" : ""}`}
                onClick={onType}
                disabled={!canType}
                aria-pressed={typeOn}
                title="Set the frame type for the selected wall border"
              >
                Type
              </button>
              <VisToggle
                visible={typeVisible}
                disabled={!canType}
                onToggle={() => setTypeVisible((v) => !v)}
                label="frame types"
              />
            </div>
          </div>
          {/* UNRAVEL · per-panel height inputs. A DOM overlay (NOT canvas-drawn) of
              one <input> per rectangle, positioned by converting each rectangle's
              left edge at its vertical mid to screen via toScreen(viewport). Because
              `viewport` is React state and paint re-runs on it, this JSX re-renders
              on every pan/zoom/resize, so the inputs track the canvas. The container
              is pointer-transparent; only the inputs capture events, so canvas
              pan/zoom elsewhere is unaffected. Cleaned up automatically when leaving
              the view (unravelDraws becomes null). These height inputs are dimension
              fields, so they follow the DIM toggle (dimensionsVisible) — the single
              source of truth — and are no longer auto-hidden by the Clean / Shadows views. */}
          {unravelOn && unravelDraws && unravelDraws.length > 0 && dimensionsVisible && (
            <div className="unravel-overlay">
              {unravelDraws.map(({ seg, height }) => {
                // PANELS phase: the focused panel is now dimensioned per ROW with
                // height labels parked just LEFT of its border (drawn on-canvas by
                // drawUnravel). That is exactly where this rotated height <input>
                // sits, so the two would overlap. Hide ONLY the focused panel's
                // input while we are in the Panels view; every other panel (and the
                // whole Elevations strip) keeps its input. Trade-off: the panel's
                // total height can't be TYPED here in Panels view, but it can still
                // be changed by dragging the panel's top edge (existing affordance).
                if (unravelOn && focusedPanel === seg.index && focusedCell === null) return null;
                const anchor = toScreen(viewport, { x: seg.x0, y: height / 2 });
                const draft = unravelInputDraft[seg.index];
                const focused = focusedUnravelInput === seg.index;
                // Display swap (function before aesthetic): while EDITING (focused
                // or an in-progress draft) show the PLAIN number — in the active
                // display unit — so typing and numeric parsing on commit work
                // normally; while IDLE show the value WITH the active unit tick via
                // fmtLengthTick so it reads like the canvas WIDTH label (2 decimals).
                // `height` is model feet; both the plain value and the tag convert.
                const editing = focused || draft !== undefined;
                const plain = draft !== undefined ? draft : String(Number(toDisplayLength(height).toFixed(3)));
                const value = editing ? plain : fmtLengthTick(height);
                // When this panel is the double-click-SELECTED one (the Additive /
                // Subtractive target), recolour its HEIGHT field to the same faint
                // floor-plate grey the renderer uses for its WIDTH label, so BOTH
                // dimension labels of the selected panel read in the selection grey.
                const isSelected = focusedPanel === seg.index;
                return (
                  <input
                    key={seg.index}
                    className={`unravel-input ${isSelected ? "is-selected" : ""}`}
                    // type=text (not number) so the idle display can carry the `′`
                    // tick; inputMode=decimal keeps the numeric keypad on touch.
                    type="text"
                    inputMode="decimal"
                    value={value}
                    title={`Height of panel (edge #${seg.index}) — enter or blur to apply`}
                    style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
                    onChange={(e) => {
                      // Sanitize to a numeric string (digits, one dot, leading
                      // minus) so the draft stays parseable by parseFloat on
                      // commit — the `′` and any stray glyphs never enter state.
                      const cleaned = e.target.value.replace(/[^0-9.\-]/g, "");
                      setUnravelInputDraft((prev) => ({ ...prev, [seg.index]: cleaned }));
                    }}
                    onFocus={() => setFocusedUnravelInput(seg.index)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      else if (e.key === "Escape") {
                        // Cancel the edit: drop the draft, restore the live value.
                        setUnravelInputDraft((prev) => {
                          const next = { ...prev };
                          delete next[seg.index];
                          return next;
                        });
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    onBlur={() => {
                      setFocusedUnravelInput((cur) => (cur === seg.index ? null : cur));
                      commitPanelInput(seg.index);
                    }}
                  />
                );
              })}
            </div>
          )}
          {/* STATISTICS OVERLAY — floats below and offset from a wall border's LEFT edge
              when statsMode is "general" and the unravel view is active. By default
              (no border selected) it anchors to the LEFT-MOST elevation panel; once a
              wall border is selected (focusedPanel), it re-anchors to that border's left
              edge instead, left-aligned with the same spacing. Tracks the viewport so it
              pans/zooms with the canvas content. */}
          {effectiveStatsMode === "general" && unravelOn && unravelResult && unravelResult.segments.length > 0 && (() => {
            // Anchor segment: the selected wall border if one is focused, else the
            // left-most panel. A stale focus (border no longer present) falls back too.
            const anchorSeg =
              (focusedPanel !== null
                ? unravelResult.segments.find((s) => s.index === focusedPanel)
                : undefined) ?? unravelResult.segments[0];
            const pos = toScreen(viewport, { x: anchorSeg.x0, y: 0 });
            return (
              <div
                className="stats-dropdown stats-dropdown--behind"
                role="region"
                aria-label="Live statistics"
                style={{ position: "absolute", left: pos.x - 8, top: pos.y + 16, pointerEvents: "none" }}
              >
                <div className="stats-dropdown__title">General</div>
                <div className="readout">
                  <span className="readout__key">Segments</span>
                  <span className="readout__val">{unravelResult.segments.length}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Unwrapped length</span>
                  <span className="readout__val">{fmtLength(unravelResult.totalLength, 3)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Total area</span>
                  <span className="readout__val">
                    {fmtArea(
                      unravelResult.segments.reduce((sum, s) => sum + s.length * effectiveHeight(s.index), 0),
                      3,
                    )}
                  </span>
                </div>
                <div className="readout">
                  <span className="readout__key">Unique cells</span>
                  <span className="readout__val">{cellShapeColors.uniqueCount}</span>
                </div>
              </div>
            );
          })()}
          {/* SOLAR RADIATION DIAGRAMS — the Irradiance (W/m²) month×hour heatmap and its
              energy companion, the Insolation (kWh/m²) monthly bar chart, for ONE wall
              border. Both anchor exactly like the General overlay: the SELECTED wall
              border if one is focused, else the LEFT-MOST elevation. The matrix is built
              from the live Solar Study settings (activeSolar: latitude, north offset) and
              that wall's TRUE compass orientation (faceBearings) — same source of truth as
              the Orientation Heatmap, so the diagrams are real per-facade data. They share
              one matrix (the chart reads its monthlyTotals, the heatmap its cell grid).
              Tracks the viewport so it pans/zooms with the canvas; renders BEHIND the minimap. */}
          {(effectiveStatsMode === "irradiance" || effectiveStatsMode === "insolation") &&
            unravelOn &&
            unravelResult &&
            unravelResult.segments.length > 0 &&
            (() => {
              const anchorSeg =
                (focusedPanel !== null
                  ? unravelResult.segments.find((s) => s.index === focusedPanel)
                  : undefined) ?? unravelResult.segments[0];
              const bearing = faceBearings[anchorSeg.index];
              if (bearing === undefined) return null; // no resolvable orientation (open loop)
              const matrix = buildRadiationMatrix(activeSolar, bearing);
              const pos = toScreen(viewport, { x: anchorSeg.x0, y: 0 });
              return (
                <div
                  className="stats-dropdown stats-dropdown--behind"
                  role="region"
                  aria-label={statsMode === "irradiance" ? "Irradiance diagram" : "Insolation chart"}
                  style={{ position: "absolute", left: pos.x - 8, top: pos.y + 16, pointerEvents: "none" }}
                >
                  {statsMode === "irradiance" ? (
                    <RadiationDiagram matrix={matrix} />
                  ) : (
                    <InsolationChart matrix={matrix} />
                  )}
                </div>
              );
            })()}
          {/* PERIMETER STATISTICS OVERLAY — the Building Perimeter tab counterpart of the
              unravel overlay above. Shows footprint stats for the CLOSED perimeter, in the
              same .stats-dropdown style. Anchored at the outline's LEFT-most x and BOTTOM-
              most y (curve-accurate extents, so a bulging curve is respected), offset DOWN
              so the box clears the drawn shape without overlapping it. Tracks the viewport,
              so it pans/zooms with the canvas. */}
          {effectiveStatsMode === "general" && !unravelOn && perimeter.closed && (() => {
            const outline = flattenPerimeter(perimeter);
            if (outline.length === 0) return null;
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (const q of outline) {
              if (q.x < minX) minX = q.x;
              if (q.x > maxX) maxX = q.x;
              if (q.y < minY) minY = q.y;
              if (q.y > maxY) maxY = q.y;
            }
            // Anchor: left-most x (alignment) + bottom-most y (model +Y up → largest screen
            // y), so adding to `top` drops the box below the footprint.
            const pos = toScreen(viewport, { x: minX, y: minY });
            // A closed loop has one wall (edge) per vertex.
            const wallCount = perimeter.vertices.length;
            return (
              <div
                className="stats-dropdown stats-dropdown--behind"
                role="region"
                aria-label="Live statistics"
                style={{ position: "absolute", left: pos.x - 8, top: pos.y + 24, pointerEvents: "none" }}
              >
                <div className="stats-dropdown__title">General</div>
                <div className="readout">
                  <span className="readout__key">Walls</span>
                  <span className="readout__val">{wallCount}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Perimeter</span>
                  <span className="readout__val">{fmtLength(perimeterLength(perimeter), 3)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Footprint area</span>
                  <span className="readout__val">{fmtArea(enclosedArea(perimeter), 3)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Extents</span>
                  <span className="readout__val">
                    {fmtLength(maxX - minX, 2)} × {fmtLength(maxY - minY, 2)}
                  </span>
                </div>
              </div>
            );
          })()}
          {/* Saved-perimeter mini-window overlay (anchored top-right of the canvas). */}
          <MiniWindow
            saved={saved}
            activeId={activeSavedId}
            onLoad={loadSavedEntry}
            onDelete={deleteSavedEntry}
            onDuplicate={duplicateSavedEntry}
            onRename={renameSavedEntry}
            onReorder={reorderSaved}
            onLocationChange={changeSavedLocation}
            onSolarChange={changeSavedSolar}
            // Footer "+" saves the current sketch as a NEW preview (mirrors Ctrl+S);
            // gated by `saveable` (needs ≥2 vertices) just like the old panel button.
            onSave={saveCurrent}
            canSave={saveable}
            // The Save footer only belongs to the Building Perimeter tab (saving a new
            // sketch). Hide it entirely in the unravel/elevation views.
            showSave={!unravelOn}
            stageRef={wrapRef}
            // Hover-link: in the UNRAVEL view the hovered strip lights its matching
            // wall PANEL; with nothing hovered it falls back to the FOCUSED border (the
            // one zoomed into — kept lit so arrow-key navigation between borders shows
            // the current focus on the minimap, as if moused over). In PERIMETER (edit)
            // mode the hovered footprint edge lights its matching edge LINE instead
            // (highlightAsLine below). MiniWindow applies it to the active entry only,
            // whose geometry matches the live shape.
            highlightEdge={unravelOn ? (hoveredUnravelEdge >= 0 ? hoveredUnravelEdge : focusedPanel ?? -1) : mode === "edit" ? hoveredEdge : -1}
            // Perimeter-mode highlight draws the edge as a LINE on the footprint,
            // not a filled wall panel (that panel fill is the unravel-mode behaviour).
            highlightAsLine={!unravelOn}
            // Per-panel heights of the LIVE shape -> the active (matching)
            // thumbnail's per-wall heights; the global default applies to ALL
            // thumbnails. Not gated on unravelOn: heights persist in state once
            // set, so the active preview reflects them live as they change.
            heights={unravelHeights}
            defaultHeight={unravelHeight}
            // The live editor shape — the active thumbnail renders THIS, so footprint
            // (perimeter mode) and height (unravel mode) edits track in the preview
            // immediately instead of snapping back to the stored snapshot.
            livePerimeter={perimeter}
          />
          {/* EXPORT popup: opens on a non-empty marquee release. Portals into the
              canvas-wrap (stageRef), previews ONLY the selected walls in 3D, and
              downloads a unit-preserving DXF for Revit / AutoCAD / Rhino. */}
          {exportPopup && (
            <ExportPopup
              perimeter={perimeter}
              edges={exportPopup}
              heights={unravelHeights}
              defaultHeight={unravelHeight}
              facadeRecords={{
                cells: unravelCells,
                divisions: panelDivisions,
                dividersH: panelDividersH,
                mullionsV: panelMullionsV,
                mullionsH: panelMullionsH,
                cellFraming: panelCellFraming,
              }}
              unravelGap={unravelGap}
              stageRef={wrapRef}
              onClose={() => {
                // Closing the popup (× or Esc) drops the marquee selection too, so the
                // highlighted elevations clear rather than lingering selected on-canvas.
                setExportPopup(null);
                setExportSelection(new Set());
              }}
            />
          )}
          {/* OVERVIEW MAP — small draggable navigator at the BOTTOM-LEFT of the
              canvas, ABOVE the Floor plate / Subtractive / Additive cluster. Mirrors
              whatever the main canvas shows — the WHOLE footprint in draw/edit, or the
              WHOLE unrolled panel strip in the unravel view — fit-to-view plus a
              rectangle marking the main canvas's current view, so the user can glance
              the full scope while zoomed in. The overview shares the main view's model
              space in each mode, so the indicator is meaningful in both. */}
          <OverviewMap
            perimeter={perimeter}
            viewport={viewport}
            mainSize={{ w: sizeRef.current.w, h: sizeRef.current.h }}
            gridSpacing={gridSpacing}
            unravelOn={unravelOn}
            unravelDraws={unravelDraws}
            stageRef={wrapRef}
          />
          {/* BOTTOM-RIGHT TOOL CLUSTER — floats just LEFT of the "?" help button
              (anchored in .canvas-wrap). Order: Draw · Edit · Erase · Dim.
              • Draw / Edit are the perimeter MODE toggle (relocated here from the left
                Create panel) — Draw places vertices, Edit selects/drags/inserts them.
              • Erase works in BOTH views: in the building view it deletes the perimeter
                VERTEX under the cursor (enabled once the first vertex exists); in the
                unravel view it deletes division lines on the focused panel AND floor
                plates. While armed, hovering highlights the target; a click removes it
                (one undo step each). Mutually exclusive with Centerlines/Framing/Floor plate.
              • Dim is a placeholder button (the word does nothing yet, stays white); only
                its EYE icon toggles the on-canvas DIMENSION visibility (the single source
                of truth, unravel views). Disabled in the Building Perimeter tab. */}
          <div className="bottomright-tools">
            <button
              className={`eraser-btn ${phase === "perimeter" && mode === "draw" && !eraserOn ? "is-active" : ""}`}
              onClick={() => {
                setMode("draw");
                if (eraserOn) onEraser();
              }}
              disabled={phase !== "perimeter" || perimeter.closed}
              aria-pressed={phase === "perimeter" && mode === "draw" && !eraserOn}
              title="Draw — place vertices"
            >
              Draw
            </button>
            <button
              className={`eraser-btn ${phase === "perimeter" && mode === "edit" && !eraserOn ? "is-active" : ""}`}
              onClick={() => {
                setMode("edit");
                if (eraserOn) onEraser();
              }}
              disabled={phase !== "perimeter"}
              aria-pressed={phase === "perimeter" && mode === "edit" && !eraserOn}
              title="Edit — select / drag / insert / delete vertices"
            >
              Edit
            </button>
            <button
              className={`eraser-btn ${eraserOn ? "is-active" : ""}`}
              onClick={onEraser}
              aria-pressed={eraserOn}
              title="Erase — delete perimeter vertices (building view) or centerlines / floor lines (unravel view)"
            >
              Erase
            </button>
            {/* DIM — clicking the word does NOTHING yet (its tool action is undefined);
                the button stays white. Only its EYE icon controls the on-canvas DIMENSION
                visibility (panel width / per-column-row / cell labels + the height input
                fields) across the Elevations, Wall Border, and Cells tabs — the single
                source of truth, so no view (Clean / Shadows) auto-hides dimensions.
                Dimensions are VISIBLE by default. Disabled in the Building Perimeter tab
                (dimensions are an unravel-view overlay). */}
            <div className="tool-vis-wrap">
              <button
                className="eraser-btn has-vis"
                disabled={!unravelOn}
                title="Dimensions — use the eye icon to show / hide"
              >
                Dim
              </button>
              <VisToggle
                visible={dimensionsVisible}
                disabled={!unravelOn}
                onToggle={() => setDimensionsVisible((v) => !v)}
                label="dimensions"
              />
            </div>
          </div>
          {/* HELP "?" button — floats at the BOTTOM-RIGHT of the canvas (anchored in
              .canvas-wrap like the floor-plate / history clusters). Clicking it opens a
              small submenu ABOVE itself to choose which reference to read; picking one
              opens a panel with the same chrome as the other floating overlays. The
              submenu and a panel never show together. */}
          {helpMenuOpen && (
            <div
              className="help-backdrop"
              onPointerDown={() => setHelpMenuOpen(false)}
              aria-hidden="true"
            />
          )}
          {helpMenuOpen && (
            <div className="help-menu" role="menu" aria-label="Help topics">
              <button
                className="help-menu__btn"
                role="menuitem"
                onClick={() => { setHelpPanel("controls"); setHelpMenuOpen(false); }}
              >
                Control List
              </button>
              <button
                className="help-menu__btn"
                role="menuitem"
                onClick={() => { setHelpPanel("stats"); setHelpMenuOpen(false); }}
              >
                Statistics Info
              </button>
              <button
                className="help-menu__btn"
                role="menuitem"
                onClick={() => { setHelpPanel("views"); setHelpMenuOpen(false); }}
              >
                View Modes Info
              </button>
            </div>
          )}
          <button
            className={`help-btn ${helpOpen ? "is-active" : ""}`}
            onClick={() => { setHelpMenuOpen((on) => !on); setHelpPanel(null); }}
            title="Help & reference"
            aria-label="Help and reference"
            aria-haspopup="menu"
            aria-expanded={helpMenuOpen}
          >
            ?
          </button>
          {/* The selected reference panel. The title (top-left, UPPERCASED by CSS) names
              the topic; the body renders the matching reference list. Closed by the ×
              button, the backdrop, or Escape (handled in an effect). The backdrop is a
              transparent full-canvas click-catcher so an outside click dismisses the
              panel without darkening the workspace. */}
          {helpPanel && (
            <>
              <div
                className="help-backdrop"
                onPointerDown={closeHelp}
                aria-hidden="true"
              />
              <div
                className="help-popup"
                role="dialog"
                aria-label={HELP_PANEL_TITLE[helpPanel]}
              >
                <div className="help-popup__titlebar">
                  <span className="help-popup__title">{HELP_PANEL_TITLE[helpPanel]}</span>
                  <button
                    className="help-popup__close"
                    onClick={closeHelp}
                    title="Close (Esc)"
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
                <div className="help-popup__body">
                  {helpPanel === "controls" && <ControlsList />}
                  {helpPanel === "stats" && <StatisticsInfo />}
                  {helpPanel === "views" && <ViewModesInfo />}
                </div>
              </div>
            </>
          )}
          {/* SETTINGS popup — same chrome as the Solar Study popup; holds the Units
              category. Anchored in .canvas-wrap (its positioning context) like the
              other overlays. Saving applies the display unit app-wide (geometry stays
              in feet — applyUnitSystem only changes formatting/parsing). */}
          {settingsOpen && (
            <>
              <div className="modal-backdrop" onClick={handleSettingsBackdrop} />
              <Settings
                onClose={() => setSettingsOpen(false)}
                stageRef={wrapRef}
                isFlashing={settingsFlashing}
                unitSystem={unitSystem}
                onSave={applyUnitSystem}
              />
            </>
          )}
        </div>
        <div className="statusbar">
          <span className="statusbar__item">
            X {cursorModel ? toDisplayLength(cursorModel.x).toFixed(3) : "—"}
          </span>
          <span className="statusbar__item">
            Y {cursorModel ? toDisplayLength(cursorModel.y).toFixed(3) : "—"}
          </span>
          {/* Contextual tool hint (red) — coaches new users on the active tool.
              See `toolHint` above for the per-tool text. */}
          {toolHint && <span className="statusbar__hint">{toolHint}</span>}
          <span className="statusbar__spacer" />
          {/* Zoom is px per model FOOT; show px per active display unit (× feet-per-unit). */}
          <span className="statusbar__item">
            Zoom {(viewport.scale * fromDisplayLength(1)).toFixed(0)} px/{lengthAbbr()}
          </span>
        </div>
      </main>
    </div>
  );
}

/**
 * The full controls / keybindings reference. Extracted so the list lives in ONE
 * place — it is rendered inside the help popup (the "?" button at the canvas
 * bottom-right). Previously this lived inline in the left tool panel; moving it
 * here keeps the panel focused on active controls and avoids duplicating the docs.
 */
function ControlsList() {
  return (
    <ul className="help">
      <li><b>Draw / Edit</b> (bottom-right cluster, left of <b>Erase</b> · <b>Dim</b>) toggle the perimeter mode — <b>Draw</b> places vertices (disabled once the perimeter is closed), <b>Edit</b> selects / drags / inserts / deletes them</li>
      <li><b>Click</b> place vertex</li>
      <li><b>Type a number</b> (after the first vertex) sets the next segment's exact <b>length</b> — the cursor aims the direction, the rubber band snaps to the typed length · <b>Enter</b> places the vertex at that length · <b>.</b> for decimals · <b>Backspace</b> edits · <b>Esc</b> cancels the entry · hold <b>Shift</b> to also lock the angle to 15°</li>
      <li><b>Click-drag</b> pull out curve handles</li>
      <li><b>A / L</b> arc / line segments</li>
      <li><b>Click first vertex / Double-click / Enter</b> close</li>
      <li><b>Esc</b> cancel polyline</li>
      <li><b>Backspace</b> remove last (draw) / delete selected (edit)</li>
      <li><b>Shift</b> constrain to 15°</li>
      <li><b>Crosshairs</b> light-grey guide lines track the cursor across the canvas once you've started a perimeter (drawing or editing its vertices)</li>
      <li><b>Edit:</b> drag vertex · drag knobs · Alt-drag curve · click segment to insert</li>
      <li><b>Double-click vertex</b> make corner</li>
      <li><b>Shift-click a vertex</b> delete it (perimeter view) · or arm <b>Erase</b> and click (or click-drag across) vertices to remove them (the targeted vertices turn red)</li>
      <li><b>Wheel / pinch</b> zoom (at cursor) · <b>Middle-drag / Right-drag</b> pan</li>
      <li><b>Ctrl+Z / Ctrl+Y</b> undo / redo (Ctrl+Shift+Z also redoes)</li>
      <li><b>Ctrl+S</b> save perimeter → mini-window (top-right)</li>
      <li><b>Statistics</b> (top, next to Redo) opens a dropdown (chevron ▾) of live stats for the current view · enabled only once a <b>closed perimeter</b> exists (re-locks if the shape is reopened) · the dropdown is <b>sticky</b> (stays open as you work; Esc or re-click to close) · pick <b>None</b>, <b>General</b>, <b>Irradiance (W/m²)</b>, or <b>Insolation (kWh/m²)</b> · <b>scroll the wheel over the button</b> to cycle the modes without opening the menu (the two solar diagrams are skipped outside the elevation views) · the selection is <b>shared across views, but only for stats that read on both sides</b> — <b>General</b> carries between the <b>Building Perimeter</b> and the elevation views, while Irradiance / Insolation are wall reads, so the <b>Building Perimeter shows None</b> for them (your pick is remembered and restored on return) · in the unravel view the readout anchors under the <b>left-most</b> elevation, re-anchoring to the <b>selected wall border</b> once you click one · <i>what each mode shows and how it's computed is in the "?" menu's <b>Statistics Info</b></i></li>
      <li><b>Render</b> · <b>Constraint</b> (top row, just left of the Projects minimap, in line with Undo/Redo) toggle blue when selected / white when deselected like the other tool buttons · enabled only once you leave the <b>Building Perimeter</b> tab (in the elevation/unravel views)</li>
      <li><b>Export</b> (nav header, between Smart Search and Settings) arms the <b>wall-selection marquee</b> in the elevation/unravel views (blue while armed; disabled in the Building Perimeter tab) · <b>click-drag</b> a box over the panels to select every wall it touches (selected walls highlight <b>green</b>) · <b>release</b> opens the export dialog · <b>Esc</b> cancels</li>
      <li><b>Export dialog</b> shows a 3D preview of <b>only the selected walls</b> (<b>drag</b> to orbit · drag the title bar to move) · <b>Revit / AutoCAD / Rhino</b> buttons download a <b>DXF</b> that preserves real dimensions in <b>feet</b> · click outside to flash · <b>Esc</b> / <b>×</b> to close</li>
      <li><b>Unroll Elevations</b> (top tab) unravels the geometry — unrolls edges clockwise into equal-length strips · the <b>Unroll Elevations</b>, <b>Wall Border</b>, and <b>Cells</b> tabs stay disabled until the sketch is saved (<b>＋ Save current sketch</b> in the Projects panel)</li>
      <li><b>Floor Lines</b> (bottom-left, unravel view) — enabled once the selected panel has a <b>CW Type</b> · <b>click</b> arms the tool to drop horizontal level lines (click the canvas to add, click a line to remove; Esc or re-click to finish) · the <b>eye icon</b> on the button's right edge shows / hides all floor lines without deleting them · the ground <b>0′</b> line is permanent (always present, can't be deleted)</li>
      <li><b>Floor-plate snap</b> after the first plate above ground, new plates snap to multiples of that floor-to-floor height · <b>Shift</b> bypasses the snap (free / grid placement)</li>
      <li><b>Unravel:</b> drag a panel top to resize</li>
      <li><b>Layer navigation:</b> a <b>single click</b> on a panel/cell drills one layer DEEPER (Unroll Elevations → Wall Border → Cells) · <b>click a different panel</b> (while in Wall Border/Cells) switches focus straight to it · <b>click the empty canvas</b> to step one layer BACK (Cells → Wall Border → Unroll Elevations) · it stops at Unroll Elevations — use the <b>Building Perimeter</b> tab to return to the footprint · the top tabs jump directly to a layer · Esc also steps back one layer</li>
      <li><b>Hover a cell</b> (Panels view, a split panel zoomed-in) highlights the individual grid cell under the cursor, showing the panel is subdivided into navigable cells</li>
      <li><b>Wall Border view</b> dimensions the focused panel's grid: a <b>width</b> label per column along the top, and a <b>height</b> label per row along the left (the panel's height field is hidden here — drag the top edge to resize)</li>
      <li><b>Cells</b> (top nav) jumps straight to the cells view — the top-left-most cell of the focused panel, or of the first panel with centerlines · enabled once the sketch is saved and <b>any</b> panel has centerlines (Centerlines tool), from any tab</li>
      <li><b>Click a cell</b> (Wall Border or Cells view) zooms into that grid cell, going one layer deeper</li>
      <li><b>Cells view</b> dimensions the selected cell on all four sides: a <b>width</b> label on the top and bottom edges, a <b>height</b> label on the left and right edges</li>
      <li><b>Hover an edge</b> (Assembly view) of the selected cell highlights that edge <b>red</b> (top / right / bottom / left, one at a time) to mark it as selected</li>
      <li><b>Click a panel</b> (Unroll Elevations) selects + zooms it (its width/height labels turn grey) and enables the <b>CW Type</b> button (bottom-left cluster) — the only cluster button available until a type is assigned · click the empty canvas (or Esc) to step back out</li>
      <li><b>← / → arrow keys</b> (while zoomed into a wall border) jump to the <b>previous / next border</b> along the strip — the same animated zoom-in as clicking the neighbouring panel, wrapping around the loop · the focused border also lights <b>red on the 3D minimap</b> (as if moused over) so you can track which wall is in focus</li>
      <li><b>CW Type</b> (first in the bottom-left cluster) assigns the curtain-wall system <b>per panel</b> — select a panel, then click (chevron ▾ marks the menu) to choose <b>Stick System</b> or <b>Unitized System</b> · the button shows the selected panel's "CW Type: <i>name</i>" · assigning a type <b>unlocks the rest of the row — Floor Lines, Centerlines, Framing</b> (all stay disabled until a panel's CW Type is set) · a panel holds only ONE system, so switching its type <b>clears that panel's framing of the other system</b> (its centerlines are kept)</li>
      <li><b>Framing</b> (last in the bottom-left cluster) becomes available once the selected panel has a CW Type, and acts in the <b>Wall Border</b> tab · with the <b>Stick System</b>, hover a panel's <b>vertical</b> or <b>horizontal</b> grid lines (the hovered set highlights, since they adjust together) then <b>click-drag</b> to set a framing (mullion) offset to <b>either side</b> in <b>0.25′</b> increments — dragging one vertical line offsets ALL vertical lines in that panel the same (likewise for horizontal) · with the tool armed, <b>clicking a different wall border</b> (away from this panel's lines) reframes to it with <b>Framing still in hand</b>, so you can move between borders and keep editing without disarming and re-selecting · <b>clicking the empty white canvas</b> (off any panel) deselects the tool · the <b>eye icon</b> on the button's right edge shows / hides all framing on the canvas without deleting it</li>
      <li>with the <b>Unitized System</b>, hover a cell's centerlines to highlight the <b>single nearest edge</b> of the cell under the cursor, then <b>click-drag</b> to inset that one edge <b>into the cell</b> in <b>0.25′</b> increments · hold <b>Shift</b> while dragging to inset <b>all four edges</b> of that cell together · each framed edge draws the solid frame face inset into the cell AND turns the affected <b>centerline segment solid</b> on top of the dashed centerline (the framed mullion) · the edit <b>mirrors live to every same-shape (Material ID) cell</b> across all elevations/panels — editing one cell updates all identical cells project-wide (see the <b>View</b> button's Material ID colours / <b>Unique cells</b> count for the groups)</li>
      <li><b>Type</b> (right of Framing) becomes available once the selected wall border has <b>at least one frame</b> created · arms/blue like the other cluster tools and is disabled in the <b>Building Perimeter</b> tab · the <b>eye icon</b> on its right edge will show / hide the frame types on the canvas <i>(scaffolded — assignment + rendering are not wired up yet)</i></li>
      <li><b>Centerlines</b> (enabled once the selected panel has a <b>CW Type</b>) arms the divide tool: hover recommends splitting the panel into <b>equal-width columns</b> (move the cursor to pick the iteration — fewer/wider or more/narrower columns) with a live dimension showing the column width · <b>click</b> places that even split · <b>hold Shift</b> flips the split to <b>equal-height rows</b> (horizontal, with a live row-height dimension); if <b>floor plates</b> cross the panel the rows snap to them — an array line lands on every floor plate and each band between plates is evenly subdivided · with the tool armed, <b>clicking a different wall border</b> reframes to it with <b>Centerlines still in hand</b>, so you can move between borders and keep editing without disarming and re-selecting · <b>clicking the empty white canvas</b> (off any panel) deselects the tool · the <b>eye icon</b> on the button's right edge shows / hides all centerlines on the canvas without deleting them · Esc or re-click the button to finish</li>
      <li><b>Erase</b> (bottom-right cluster, just left of the <b>?</b> help button) arms the delete tool and works in BOTH views · <b>Building Perimeter view:</b> hover a perimeter <b>vertex</b> (it turns <b>red</b>) and <b>click</b> to delete it, or <b>click-drag</b> across several vertices to remove them all in one stroke (committed as one undo step; dropping below 3 points reopens the shape) · hover a perimeter <b>edge</b> away from its corners (closed shape only) to highlight that segment <b>red</b> and <b>click</b> to remove it — <b>reopening the loop there while keeping both vertices</b> — or <b>click-drag</b> along the boundary to erase several segments at once · any vertex left <b>alone</b> by losing both its walls (e.g. between two erased edges) is <b>auto-deleted</b> too (it pre-highlights red) ·<b>Unravel view:</b> <b>hover</b> near a panel's centerline <em>or</em> a floor plate to highlight it, <b>click</b> deletes it, and <b>click-drag</b> across multiple lines erases them all in one stroke (a fast drag still catches every line on the path), committed as one undo step · erasing a panel's centerline also <b>clears that panel's framing</b> on that axis (the same way adding a centerline does — re-apply framing afterwards), so no frame bars linger along the border without their centerlines · the default <b>0′ ground floor line</b> can't be deleted · Esc or re-click the button to finish · mutually exclusive with Centerlines/Framing/Floor Lines</li>
      <li><b>Dim</b> (bottom-right cluster, right of Erase) — clicking the word does nothing yet; its <b>eye icon</b> is the single source of truth for the on-canvas <b>dimensions</b> (the panel width / per-column-row / cell labels and the height input fields across the <b>Elevations</b>, <b>Wall Border</b>, and <b>Cells</b> tabs) · click the eye to show / hide them all (visible by default) · disabled in the <b>Building Perimeter</b> tab · <b>no view (Clean / Shadows) auto-hides dimensions</b> — only the Dim eye does</li>
      <li><b>View</b> (top-left, right of Statistics; unravel view only) <b>click</b> opens a dropdown (chevron ▾) to pick the display mode — purely visual, arms no tool · <b>scroll the wheel over the button</b> to cycle the modes without opening the menu · modes are <b>Technical</b>, <b>Material ID</b>, <b>Orientation Heatmap</b>, <b>Clean</b>, and <b>Shadows</b> · <b>no view ever auto-hides floor lines, centerlines, framing, or dimensions</b> — those four are shown/hidden ONLY by their per-button toggles (the eye icons and the <b>Dim</b> button) · <i>what each mode shows and how it's computed is in the "?" menu's <b>View Modes Info</b></i></li>
      <li><b>Hover an edge</b> (edit mode) highlights that edge's line on the active mini-window thumbnail · in unravel, hovering a panel lights its wall instead</li>
      <li><b>Projects panel:</b> click load (fits the shape to the view) · drag preview to rotate · double-click preview for top-down plan view · drag title to move · ☀ toggle a larger <b>Solar Study</b> popup · ✎ rename · <b>⧉ duplicate</b> the whole project (perimeter, elevations, framing — everything) into a new <i>Option</i> · <b>× delete</b> — <b>undoable</b> with Ctrl+Z (Ctrl+Y redoes) · <b>＋ footer</b> (Building Perimeter tab only) saves the current sketch as a new project</li>
      <li><b>Solar Study</b> (☀ popup) draws a 3D <b>sun-path dome</b> around the massing from real solar geometry · drag to rotate · double-click for an aerial top-down view (synced with the thumbnail) · <b>Orientation dial</b> — drag the needle (or type degrees) to set the drawing's North relative to the cardinal directions · <b>Date</b> and <b>Solar time</b> sliders move the sun along its path (with a live altitude / azimuth readout) · <b>Latitude</b> field (temporary Omaha, NE default until the address is geocoded) · Location field inherits the sketch's address · settings are saved with the sketch</li>
      <li><b>Overview map</b> (bottom-left) shows the whole shape — the footprint in draw/edit, the unrolled panel strip in unravel — with a rectangle marking your current view · drag the grip strip to move</li>
      <li><b>Location</b> (left panel) type an address to geo-locate the sketch · optional — blank by default · saved with the sketch</li>
      <li><b>New project</b> (＋ at the top-left of the nav header, left of <b>Building Perimeter</b>) clears the canvas to a fresh, blank project — like refreshing the page but without the onboarding hint · your <b>saved projects are kept</b></li>
      <li><b>Settings</b> (⚙ at the top-right of the nav header) opens a draggable Settings popup (drag its title bar to move · Esc or × to close) with a category rail on the left (<b>Units</b>) · under Units, a <b>Feet ′ / Metric m</b> length-unit switch · click <b>Save</b> (bottom-right) to apply the unit to every dimension across the app (drawings, statistics, minimap, elevations, walls, cells) — the geometry is unchanged, only the units shown</li>
      <li><b>Collapse panel</b> (◂ / ▸ at the bottom-left corner) hides or shows the left tool panel to give the canvas more room</li>
      <li><b>Edit a loaded entry</b> footprint and elevation-view edits auto-save to that entry (no manual save) · the mini-window's <b>＋ footer</b> always creates a new entry instead</li>

    </ul>
  );
}

/**
 * VIEW MODES INFO panel ("?" menu → View Modes Info). One entry per View-button display
 * mode: a plain-language sentence on WHAT it shows, then an italic "How:" clause on how
 * it's computed. Kept in sync with the View dropdown (CELL_VIEW_LABELS) + the renderer.
 */
function ViewModesInfo() {
  return (
    <ul className="help">
      <li><b>Technical</b> the default drafting view — centerlines, framing, and dimensions on a plain background, no cell tinting. <span className="help__how">How: draws the authored geometry as-is; what's visible is governed only by the Floor Lines / Centerlines / Framing eye toggles and the Dim button.</span></li>
      <li><b>Material ID</b> tints every grid cell by its geometric <b>shape</b>, so identical cells across the whole project share one colour and number. <span className="help__how">How: each cell's width × height is rounded to ~0.001′ and bucketed into a shape group; the group index maps to a hue via the golden angle (137.5°), and identical cells fan out in saturation. The Statistics <b>Unique cells</b> count is the number of distinct groups.</span></li>
      <li><b>Orientation Heatmap</b> colours each cell by the <b>compass direction</b> its glass faces and prints that facade's <b>live direct-sun hit %</b> beneath the cardinal. <span className="help__how">How: the facade's outward normal (from the perimeter's winding) is rotated by the Solar Study's North into a true bearing, then mapped onto a cold→hot ramp (N blue · E cyan · S yellow · W red). The % is the cosine of the sun's angle of incidence on the wall — cos(altitude)·cos(sun-azimuth − wall-bearing) at the Solar Study's current day + hour — shown as 100% (sun square-on) down to 0% (grazing or sun behind the wall), or "—" when the sun is below the horizon.</span></li>
      <li><b>Clean</b> a presentation view — the glass panels fill <b>white</b> behind the framing. <span className="help__how">How: the same geometry as Technical with cell infill forced white; the per-button visibility toggles still apply.</span></li>
      <li><b>Shadows</b> a 2.5D presentation — every framing bar reads as raised and casts a hard <b>drop shadow</b> onto the adjacent glass. <span className="help__how">How: built on Clean — each frame bar projects a shadow quad onto neighbouring glass only (never onto frame infill), its length scaling with zoom; the geometry is drawn monochrome while hover highlights stay coloured.</span></li>
    </ul>
  );
}

/**
 * STATISTICS INFO panel ("?" menu → Statistics Info). One entry per Statistics-dropdown
 * mode: a plain-language sentence on WHAT it shows, then an italic "How:" clause on how
 * it's computed. Kept in sync with the Statistics dropdown + core/radiation.ts.
 */
function StatisticsInfo() {
  return (
    <ul className="help">
      <li><b>General</b> live geometric totals for the current view. <span className="help__how">How: read straight off the drawn geometry — the <b>Building Perimeter</b> shows wall count, perimeter length, footprint area (shoelace formula), and bounding extents; the <b>unravel</b> views show segment count, unwrapped length, total facade area (Σ length × height), and the unique-cell count.</span></li>
      <li><b>Irradiance (W/m²)</b> a Ladybug-style <b>month × hour</b> heatmap of clear-sky solar power landing on the selected wall. <span className="help__how">How: for each month's representative day and each hour, the sun's altitude/azimuth (spherical astronomy from the Solar Study's latitude + North) drive a Hottel clear-sky beam transmittance; wall irradiance = direct-normal·cos(incidence) (beam, only when the sun faces the wall) + isotropic sky-diffuse + ground-reflected, coloured cold→hot. Clear-sky only (no weather file yet).</span></li>
      <li><b>Insolation (kWh/m²)</b> the energy companion — a <b>monthly bar chart</b> of the solar energy that same wall receives. <span className="help__how">How: integrates the Irradiance over each representative day and scales by the days in the month → kWh/m² per month; summed over the year it gives the annual <b>kWh/m²·yr</b> total shown on both diagrams.</span></li>
    </ul>
  );
}

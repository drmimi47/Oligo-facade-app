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
  enclosedArea,
  perimeterLength,
  distance,
  angleDeg,
  snapPoint,
  constrainAngle,
  pointFromPolar,
  hitVertex,
  hitSegment,
  hitHandle,
  type Perimeter,
  type Point,
} from "./core/geometry";
import {
  addVertex,
  close as closePerimeter,
  moveVertex,
  insertVertexOnSegment,
  deleteVertex,
  popVertex,
  setHandle,
  makeSegmentArc,
  clearVertexHandles,
} from "./core/perimeterOps";
import { defaultViewport, toScreen, toModel, pixelsToModel, zoomAt, pan, fitViewport, type Viewport } from "./core/viewport";
import { render, type RenderState, type UnravelDraw } from "./core/renderer";
import { unravelPerimeter, unravelBoundsPerimeter, type UnravelSegment } from "./core/unravel";
import { DEFAULT_WALL_HEIGHT_FT } from "./core/extrude3d";
import {
  loadSaved,
  persistSaved,
  makeSavedPerimeter,
  clonePerimeter,
  canSave,
  type SavedPerimeter,
} from "./core/savedPerimeters";
import MiniWindow from "./MiniWindow";

/** Pixel tolerance for hit-testing vertices/segments. */
const HIT_TOLERANCE_PX = 9;
/** Pixel tolerance for "click the first vertex to close". */
const CLOSE_TOLERANCE_PX = 12;
/** Pointer travel (px) before a press-drag counts as a handle pull rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** Pixel tolerance for grabbing a rectangle's TOP edge to resize its height. */
const TOP_EDGE_TOLERANCE_PX = 6;
/** Minimum per-panel height (model units) — keeps every rectangle visibly sized. */
const MIN_UNRAVEL_HEIGHT = 0.5;

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
  unravelHeight: number;
}

export default function PolylineTool() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // --- DATA MODEL (source of truth) ---
  const [perimeter, setPerimeter] = useState<Perimeter>(emptyPerimeter);

  // --- VIEWPORT ---
  const [viewport, setViewport] = useState<Viewport>(() => defaultViewport(800, 600));

  // --- TOOL / PRECISION SETTINGS ---
  const [mode, setMode] = useState<Mode>("draw");
  const [curveType, setCurveType] = useState<CurveType>("line");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSpacing, setGridSpacing] = useState(1);
  const [showGrid, setShowGrid] = useState(false);

  // --- UNRAVEL VIEW (unwrap edges into rectangles / "spaces") ---
  const [unravelOn, setUnravelOn] = useState(false);
  const [unravelGap, setUnravelGap] = useState(3);
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
  // PER-PANEL cell split count, keyed by ORIGINAL edge index (default 1 = no
  // split). Double-clicking a panel zooms to it; right-clicking opens a menu to
  // split it into N equal-width vertical cells (facade bays). Drawn as N-1
  // division lines inside the rectangle.
  const [unravelCells, setUnravelCells] = useState<Record<number, number>>({});
  // The panel (edge index) currently zoomed-to via double-click, or null. Esc
  // restores the full-strip fit and clears this.
  const [focusedPanel, setFocusedPanel] = useState<number | null>(null);
  // Right-click "split into cells" menu: target edge + position (canvas-wrap px),
  // or null when closed. `cellMenuDraft` backs the custom-count input.
  const [cellMenu, setCellMenu] = useState<{ edge: number; x: number; y: number } | null>(null);
  const [cellMenuDraft, setCellMenuDraft] = useState("");

  // --- TRANSIENT INTERACTION STATE ---
  const [cursorModel, setCursorModel] = useState<Point | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [selectedVertex, setSelectedVertex] = useState(-1);
  const [hoveredVertex, setHoveredVertex] = useState(-1);
  const [insertPreview, setInsertPreview] = useState<Point | null>(null);
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

  // Numeric entry for the next segment (direct length/angle input).
  const [numLength, setNumLength] = useState("");
  const [numAngle, setNumAngle] = useState("");

  // --- SAVED PERIMETERS (persisted to localStorage) ---
  // Initialised lazily from localStorage so saves survive a reload (load-on-mount
  // happens once during the initial render, not in an effect that could flash).
  const [saved, setSaved] = useState<SavedPerimeter[]>(() => loadSaved());
  // Which saved entry (if any) is currently loaded into the editor — used to
  // highlight it in the mini-window and to target the "Update" action.
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);

  // Drag state lives in a ref (no re-render needed mid-drag for tracking).
  //  - pan:        middle-drag the viewport
  //  - vertex:     move an anchor
  //  - handle:     drag a Bézier control knob (mirror = keep tangent smooth)
  //  - drawHandle: press-drag right after placing a vertex to pull out handles
  //  - unravelHeight: drag a rectangle's top edge to stretch THAT panel's height
  type Drag =
    | { kind: "pan"; lastX: number; lastY: number }
    | { kind: "vertex"; index: number }
    | { kind: "handle"; index: number; which: "in" | "out"; mirror: boolean }
    | { kind: "drawHandle"; index: number; anchor: Point; moved: boolean }
    | { kind: "unravelHeight"; edge: number };
  const dragRef = useRef<Drag | null>(null);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });

  // --- UNDO / REDO ---
  const [undoStack, setUndoStack] = useState<DocSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<DocSnapshot[]>([]);
  // Always-current document snapshot, refreshed every render, so the capture and
  // undo/redo helpers read fresh values without stale-closure bugs.
  const docRef = useRef<DocSnapshot>({ perimeter, unravelHeights, unravelCells, unravelHeight });
  docRef.current = { perimeter, unravelHeights, unravelCells, unravelHeight };
  // Pre-interaction snapshot for a drag / field edit, pushed on the FIRST actual
  // change (so a no-op press/focus never creates an empty undo step).
  const pendingRef = useRef<DocSnapshot | null>(null);

  const pushUndo = useCallback((snap: DocSnapshot) => {
    setUndoStack((s) => {
      const n = [...s, snap];
      return n.length > HISTORY_LIMIT ? n.slice(n.length - HISTORY_LIMIT) : n;
    });
    setRedoStack([]); // a fresh edit invalidates the redo branch
  }, []);
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
    setUnravelHeight(d.unravelHeight);
    setSelectedVertex(-1);
    setHoveredVertex(-1);
    setInsertPreview(null);
    setUnravelInputDraft({});
    pendingRef.current = null;
  }, []);

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, docRef.current]);
    applyDoc(prev);
  }, [undoStack, redoStack, applyDoc]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, docRef.current]);
    applyDoc(next);
  }, [undoStack, redoStack, applyDoc]);

  const drawing = mode === "draw" && !perimeter.closed;

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
    return unravelResult.segments.map((seg) => ({
      seg,
      height: effectiveHeight(seg.index),
      cells: unravelCells[seg.index] ?? 1,
    }));
  }, [unravelResult, effectiveHeight, unravelCells]);

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
        setPanelHeight(edge, clampHeight(parseFloat(raw)));
      }
      setUnravelInputDraft((prev) => {
        const next = { ...prev };
        delete next[edge];
        return next;
      });
    },
    [unravelInputDraft, clampHeight, setPanelHeight, recordHistory],
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
      // Angle constraint while drawing with Shift: lock to 45° increments
      // relative to the previous vertex. Snap-then-constrain keeps it on grid
      // directions where possible while guaranteeing the angle lock.
      if (e.shiftKey && drawing && perimeter.vertices.length > 0) {
        const last = perimeter.vertices[perimeter.vertices.length - 1];
        p = constrainAngle(last, p, 45);
      }
      return p;
    },
    [viewport, snapEnabled, gridSpacing, drawing, perimeter.vertices],
  );

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
   * ORIGINAL edge index, or -1. Used for hover, double-click-to-zoom, and the
   * right-click split menu.
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
      setViewport(fitViewport(unravelBoundsPerimeter([seg], () => h0), w, h, 56));
      setFocusedPanel(edge);
    },
    [unravelResult, effectiveHeight],
  );

  /** Set a panel's cell-split count (>= 1), keyed by original edge index. */
  const setPanelCells = useCallback(
    (edge: number, n: number) => {
      recordHistory();
      setUnravelCells((prev) => ({ ...prev, [edge]: Math.max(1, Math.round(n) || 1) }));
    },
    [recordHistory],
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
      setViewport(fitViewport(unravelBoundsPerimeter(res.segments, heightOf), w, h, 48));
    },
    [perimeter],
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

      // Any press on the canvas dismisses an open cell-split menu.
      if (cellMenu) setCellMenu(null);

      // Middle button or space-less: pan with middle mouse.
      if (e.button === 1) {
        dragRef.current = { kind: "pan", lastX: sx, lastY: sy };
        return;
      }
      if (e.button !== 0) return;
      // Unravel view: left-click does not draw/edit, but the TOP edge of a
      // rectangle can be dragged to stretch THAT panel's height.
      if (unravelOn) {
        const mu = toModel(viewport, sx, sy); // raw model point (no draw snap/constrain)
        const edge = hitUnravelTop(mu);
        if (edge >= 0) {
          beginHistory(); // capture pre-resize state; pushed on first drag move
          dragRef.current = { kind: "unravelHeight", edge };
          setHoveredUnravelTop(edge);
        }
        return;
      }

      const m = eventToModel(e);
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);

      if (drawing) {
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
      // 2. Hit a vertex: select + drag it. Alt-drag instead pulls out fresh
      //    symmetric handles, turning a corner into a smooth curve.
      const vi = hitVertex(perimeter, m, tolModel);
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
      cellMenu,
      recordHistory,
      beginHistory,
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
        setViewport((vp) => pan(vp, dx, dy));
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

      // Unravel hover-link: hit-test the cursor against the edge RECTANGLES (each
      // spans x0→x1 on x and y = 0..height on y). A rectangle is "hovered" when
      // the cursor falls inside its x range and its y range (0..height), with a
      // small screen-pixel tolerance. The matched rectangle's ORIGINAL edge index
      // highlights the rectangle here and the linked edge in the mini-window.
      if (unravelOn) {
        const segs = unravelResult?.segments;
        if (segs && segs.length > 0) {
          // Top-edge resize hover takes PRECEDENCE near a rectangle's top so the
          // resize affordance wins over the body hover-highlight.
          const top = hitUnravelTop(m);
          setHoveredUnravelTop(top);
          // Rectangle body hover (reuses the shared panel hit-test).
          setHoveredUnravelEdge(hitUnravelPanel(m));
        } else {
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
        }
        return;
      }

      // Hover feedback (edit mode only; not in the read-only unravel view).
      if (mode === "edit" && !unravelOn) {
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        const vi = hitVertex(perimeter, m, tolModel);
        setHoveredVertex(vi);
        if (vi < 0) {
          const seg = hitSegment(perimeter, m, tolModel);
          setInsertPreview(seg ? seg.point : null);
        } else {
          setInsertPreview(null);
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
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      canvasRef.current?.releasePointerCapture(e.pointerId);
      const drag = dragRef.current;
      // A plain click in Arc mode (no handle pulled) auto-curves the segment
      // that was just committed (between the previous vertex and the new one).
      if (drag?.kind === "drawHandle" && !drag.moved && curveType === "arc" && drag.index >= 1) {
        setPerimeter((p) => makeSegmentArc(p, drag.index - 1));
      }
      dragRef.current = null;
      setActiveDrawHandle(-1);
    },
    [curveType],
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (unravelOn) {
        // Double-click a panel zooms it to fill the screen at an appropriate level.
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mu = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
        const edge = hitUnravelPanel(mu);
        if (edge >= 0) zoomToPanel(edge);
        return;
      }
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
    [drawing, mode, perimeter, viewport, eventToModel, unravelOn, hitUnravelPanel, zoomToPanel, recordHistory],
  );

  /** Right-click a panel in the unravel view to open the cell-split menu. */
  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (!unravelOn) return;
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const rect = canvas.getBoundingClientRect();
      const mu = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
      const edge = hitUnravelPanel(mu);
      if (edge < 0) {
        setCellMenu(null);
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      setCellMenu({ edge, x: e.clientX - wrapRect.left, y: e.clientY - wrapRect.top });
      setCellMenuDraft(String(unravelCells[edge] ?? 1));
    },
    [unravelOn, viewport, hitUnravelPanel, unravelCells],
  );

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const anchorX = e.clientX - rect.left;
    const anchorY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setViewport((vp) => zoomAt(vp, anchorX, anchorY, factor));
  }, []);

  // ---------------------------------------------------------------------------
  // SAVE / LOAD / DELETE / RENAME / UPDATE saved perimeters.
  // The live model is deep-copied on save (clonePerimeter) so later edits to the
  // editor never mutate a stored entry. Declared before the keyboard effect so
  // the Ctrl+S handler can reference saveCurrent.
  // ---------------------------------------------------------------------------

  // Whether the current editor perimeter is substantial enough to save.
  const saveable = canSave(perimeter);

  /** Capture the current perimeter as a new saved entry. */
  const saveCurrent = useCallback(() => {
    if (!canSave(perimeter)) return; // guard empty/degenerate
    setSaved((list) => {
      const entry = makeSavedPerimeter(perimeter, list);
      setActiveSavedId(entry.id);
      return [...list, entry];
    });
  }, [perimeter]);

  /** Load a saved perimeter back into the editor (replaces the live one). */
  const loadSavedEntry = useCallback(
    (s: SavedPerimeter) => {
      recordHistory(); // loading replaces the live shape — make it undoable
      setPerimeter(clonePerimeter(s.perimeter)); // detach from the stored copy
      setActiveSavedId(s.id);
      // Closed shapes are most useful to edit; open polylines can keep drawing.
      setMode(s.perimeter.closed ? "edit" : "draw");
      setSelectedVertex(-1);
      setHoveredVertex(-1);
      setInsertPreview(null);
    },
    [recordHistory],
  );

  const deleteSavedEntry = useCallback((id: string) => {
    setSaved((list) => list.filter((s) => s.id !== id));
    setActiveSavedId((cur) => (cur === id ? null : cur));
  }, []);

  const renameSavedEntry = useCallback((id: string, name: string) => {
    setSaved((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  /** Overwrite an existing saved entry with the current editor shape. */
  const updateSavedEntry = useCallback(
    (id: string) => {
      if (!canSave(perimeter)) return;
      setSaved((list) => list.map((s) => (s.id === id ? { ...s, perimeter: clonePerimeter(perimeter) } : s)));
      setActiveSavedId(id);
    },
    [perimeter],
  );

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
        // In the unravel view, Esc first dismisses the cell menu, then exits a
        // double-click zoom (restoring the full-strip fit).
        if (unravelOn && (cellMenu || focusedPanel !== null)) {
          setCellMenu(null);
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
    cellMenu,
    focusedPanel,
    fitUnravel,
    unravelGap,
    unravelHeights,
    unravelHeight,
    undo,
    redo,
    recordHistory,
  ]);

  // ---------------------------------------------------------------------------
  // DIRECT NUMERIC ENTRY: place next vertex by length + angle from last vertex.
  // ---------------------------------------------------------------------------

  const commitNumeric = useCallback(() => {
    if (!drawing) return;
    const len = parseFloat(numLength);
    const ang = parseFloat(numAngle);
    if (!Number.isFinite(len) || !Number.isFinite(ang)) return;
    const from =
      perimeter.vertices.length > 0
        ? perimeter.vertices[perimeter.vertices.length - 1]
        : { x: 0, y: 0 };
    const next = pointFromPolar(from, len, ang);
    recordHistory();
    setPerimeter((p) => addVertex(p, next));
    setNumLength("");
    setNumAngle("");
  }, [drawing, numLength, numAngle, perimeter.vertices, recordHistory]);

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
    return () => window.removeEventListener("resize", resize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    const state: RenderState = {
      perimeter,
      viewport,
      cursorModel,
      drawing,
      // Suppress the rubber-band while pulling a handle (the handle line is the
      // relevant feedback then, not a segment to the cursor).
      rubberBand: drawing && activeDrawHandle < 0,
      selectedVertex,
      hoveredVertex,
      // Show handles for the vertex being curve-edited: the selected one in edit
      // mode, or the one whose handle is being pulled while drawing.
      handleVertex: mode === "edit" ? selectedVertex : activeDrawHandle,
      insertPreview,
      gridSpacing,
      showGrid,
      unravel: unravelDraws,
      hoveredUnravelEdge,
      hoveredUnravelTop,
    };
    render(ctx, canvas, w, h, dpr, state);
  }, [
    perimeter,
    viewport,
    cursorModel,
    drawing,
    mode,
    activeDrawHandle,
    selectedVertex,
    hoveredVertex,
    insertPreview,
    gridSpacing,
    showGrid,
    unravelDraws,
    hoveredUnravelEdge,
    hoveredUnravelTop,
  ]);

  useEffect(() => {
    paint();
  }, [paint]);

  // ---------------------------------------------------------------------------
  // DERIVED READOUTS
  // ---------------------------------------------------------------------------

  const totalLength = perimeterLength(perimeter);
  const area = enclosedArea(perimeter);

  // Live segment readout while drawing.
  let segLen = 0;
  let segAng = 0;
  if (drawing && cursorModel && perimeter.vertices.length > 0) {
    const last = perimeter.vertices[perimeter.vertices.length - 1];
    segLen = distance(last, cursorModel);
    segAng = angleDeg(last, cursorModel);
  }

  const reset = () => {
    recordHistory(); // make Reset undoable (restores geometry + per-panel heights/cells)
    setPerimeter(emptyPerimeter());
    setMode("draw");
    setSelectedVertex(-1);
    setHoveredVertex(-1);
    setInsertPreview(null);
    setActiveSavedId(null);
    setUnravelOn(false);
    setHoveredUnravelEdge(-1);
    setHoveredUnravelTop(-1);
    setUnravelHeights({});
    setUnravelCells({});
    setFocusedPanel(null);
    setCellMenu(null);
  };

  /** Whether the current shape has enough edges to unravel. */
  const canUnravel = perimeter.vertices.length >= 2;

  /** Toggle the unravel view; on entry, clear transient edit state and fit the strip. */
  const toggleUnravel = useCallback(() => {
    setUnravelOn((on) => {
      const next = !on;
      if (next) {
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
      } else {
        // Leaving the view: drop any active hover-link highlight + resize affordance,
        // the double-click zoom focus, and the cell-split menu.
        setHoveredUnravelEdge(-1);
        setHoveredUnravelTop(-1);
        setFocusedPanel(null);
        setCellMenu(null);
      }
      if (next) fitUnravel(unravelGap, unravelHeights, unravelHeight);
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

  return (
    <div className="app">
      {/* ===== LEFT: TOOL PANEL ===== */}
      <aside className="panel">
        <h1 className="panel__title">Perimeter Tool</h1>

        <section className="panel__section">
          <div className="panel__row">
            <button className="btn" onClick={undo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">
              ↶ Undo
            </button>
            <button
              className="btn"
              onClick={redo}
              disabled={redoStack.length === 0}
              title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
            >
              ↷ Redo
            </button>
          </div>
        </section>

        <section className="panel__section">
          <div className="panel__row">
            <span className="panel__label">Mode</span>
            <div className="segmented">
              <button
                className={`segmented__btn ${mode === "draw" ? "is-active" : ""}`}
                onClick={() => setMode("draw")}
                disabled={perimeter.closed}
                title="Place vertices"
              >
                Draw
              </button>
              <button
                className={`segmented__btn ${mode === "edit" ? "is-active" : ""}`}
                onClick={() => setMode("edit")}
                title="Select / drag / insert / delete vertices"
              >
                Edit
              </button>
            </div>
          </div>

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
                title="Draw curved segments (shortcut: A). Click-drag to shape the curve."
              >
                Arc (A)
              </button>
            </div>
          </div>
          <div className="panel__hint">
            Click-drag while placing a point to pull out curve handles.
          </div>
        </section>

        <section className="panel__section">
          <div className="panel__section-title">Snap &amp; Grid</div>
          <label className="panel__row panel__row--checkbox">
            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
            <span>Snap to grid</span>
          </label>
          <label className="panel__row panel__row--checkbox">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            <span>Show grid</span>
          </label>
          <label className="panel__row">
            <span className="panel__label">Spacing</span>
            <input
              className="panel__input"
              type="number"
              min={0.01}
              step={0.25}
              value={gridSpacing}
              onChange={(e) => setGridSpacing(Math.max(0.01, parseFloat(e.target.value) || 0.01))}
            />
            <span className="panel__unit">u</span>
          </label>
        </section>

        <section className="panel__section">
          <div className="panel__section-title">Next segment (numeric)</div>
          <div className="panel__hint">Type length &amp; angle, press Add to place the next vertex.</div>
          <label className="panel__row">
            <span className="panel__label">Length</span>
            <input
              className="panel__input"
              type="number"
              step={0.1}
              value={numLength}
              placeholder="0.0"
              disabled={!drawing}
              onChange={(e) => setNumLength(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitNumeric()}
            />
            <span className="panel__unit">u</span>
          </label>
          <label className="panel__row">
            <span className="panel__label">Angle</span>
            <input
              className="panel__input"
              type="number"
              step={1}
              value={numAngle}
              placeholder="0.0"
              disabled={!drawing}
              onChange={(e) => setNumAngle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitNumeric()}
            />
            <span className="panel__unit">°</span>
          </label>
          <button className="btn" onClick={commitNumeric} disabled={!drawing}>
            Add vertex
          </button>
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

        <section className="panel__section">
          <div className="panel__section-title">Perimeter</div>
          <div className="readout">
            <span className="readout__key">Vertices</span>
            <span className="readout__val">{perimeter.vertices.length}</span>
          </div>
          <div className="readout">
            <span className="readout__key">Closed</span>
            <span className="readout__val">{perimeter.closed ? "yes" : "no"}</span>
          </div>
          <div className="readout">
            <span className="readout__key">Total length</span>
            <span className="readout__val">{totalLength.toFixed(3)} u</span>
          </div>
          <div className="readout">
            <span className="readout__key">Enclosed area</span>
            <span className="readout__val">{area.toFixed(3)} u²</span>
          </div>
        </section>

        <section className="panel__section">
          <div className="panel__section-title">Unwrap (elevation)</div>
          <button
            className={`btn ${unravelOn ? "btn--primary" : ""}`}
            onClick={toggleUnravel}
            disabled={!canUnravel}
            title={
              canUnravel
                ? "Unravel the edges clockwise into horizontal strips (lengths preserved)"
                : "Need at least 2 vertices to unravel"
            }
          >
            {unravelOn ? "Exit unravel" : "Unravel ⟳ (CW)"}
          </button>
          <label className="panel__row">
            <span className="panel__label">Gap</span>
            <input
              className="panel__input"
              type="number"
              min={0}
              step={0.25}
              value={unravelGap}
              disabled={!canUnravel}
              onChange={(e) => {
                const g = Math.max(0, parseFloat(e.target.value) || 0);
                setUnravelGap(g);
                if (unravelOn) fitUnravel(g, unravelHeights, unravelHeight);
              }}
            />
            <span className="panel__unit">u</span>
          </label>
          <label className="panel__row">
            <span className="panel__label">Height</span>
            <input
              className="panel__input"
              type="number"
              min={0.5}
              step={1}
              value={unravelHeight}
              disabled={!canUnravel}
              title="DEFAULT height applied to ALL panels (1u = 1ft). Editing it makes every rectangle uniform — it clears per-panel overrides. Width stays fixed to each edge's length."
              onFocus={beginHistory}
              onChange={(e) => {
                // One undo step per edit session: push the pre-edit snapshot once.
                flushHistory();
                // Clamp to a sensible minimum so a rectangle always has visible area.
                const hgt = Math.max(MIN_UNRAVEL_HEIGHT, parseFloat(e.target.value) || MIN_UNRAVEL_HEIGHT);
                setUnravelHeight(hgt);
                // Global edit = "make them all uniform": wipe per-panel overrides.
                setUnravelHeights({});
                if (unravelOn) fitUnravel(unravelGap, {}, hgt);
              }}
            />
            <span className="panel__unit">u</span>
          </label>
          {unravelOn && unravelResult && (
            <>
              <div className="readout">
                <span className="readout__key">Segments</span>
                <span className="readout__val">{unravelResult.segments.length}</span>
              </div>
              <div className="readout">
                <span className="readout__key">Unwrapped length</span>
                <span className="readout__val">{unravelResult.totalLength.toFixed(3)} u</span>
              </div>
              <div className="readout">
                <span className="readout__key">Total area</span>
                <span className="readout__val">
                  {unravelResult.segments
                    .reduce((sum, s) => sum + s.length * effectiveHeight(s.index), 0)
                    .toFixed(3)}{" "}
                  u²
                </span>
              </div>
            </>
          )}
          <div className="panel__hint">
            Each edge becomes a rectangle ("space"): its WIDTH is the edge's exact length
            (fixed by geometry — curved edges use their arc length, dashed). HEIGHT is
            PER-PANEL — drag a rectangle's top edge or type in its on-rectangle field to
            resize just that one. The Height above is the default for unset panels (editing
            it makes them all uniform). Laid out clockwise, separated by Gap.
          </div>
        </section>

        <section className="panel__section">
          <div className="panel__section-title">Library</div>
          <button
            className="btn btn--primary"
            onClick={saveCurrent}
            disabled={!saveable}
            title={
              saveable
                ? "Save the current perimeter (Ctrl+S). It appears in the mini-window."
                : "Need at least 2 vertices to save"
            }
          >
            Save perimeter (Ctrl+S)
          </button>
          {activeSavedId && saveable && (
            <button
              className="btn"
              onClick={() => updateSavedEntry(activeSavedId)}
              title="Overwrite the loaded saved entry with the current shape"
            >
              Update loaded entry
            </button>
          )}
          <div className="panel__hint">
            Saved shapes appear in the mini-window (top-right). Click one to load it.
          </div>
        </section>

        <section className="panel__section">
          <button className="btn btn--danger" onClick={reset}>
            Reset
          </button>
        </section>

        <section className="panel__section panel__section--help">
          <div className="panel__section-title">Controls</div>
          <ul className="help">
            <li><b>Click</b> place vertex</li>
            <li><b>Click-drag</b> pull out curve handles</li>
            <li><b>A / L</b> arc / line segments</li>
            <li><b>Click first vertex / Double-click / Enter</b> close</li>
            <li><b>Esc</b> cancel polyline</li>
            <li><b>Backspace</b> remove last (draw) / delete selected (edit)</li>
            <li><b>Shift</b> constrain to 45°</li>
            <li><b>Edit:</b> drag vertex · drag knobs · Alt-drag curve · click segment to insert</li>
            <li><b>Double-click vertex</b> make corner</li>
            <li><b>Wheel</b> zoom · <b>Middle-drag</b> pan</li>
            <li><b>Ctrl+Z / Ctrl+Y</b> undo / redo (Ctrl+Shift+Z also redoes)</li>
            <li><b>Ctrl+S</b> save perimeter → mini-window (top-right)</li>
            <li><b>Unravel ⟳</b> unroll edges clockwise into equal-length strips</li>
            <li><b>Unravel:</b> drag a panel top to resize · double-click a panel to zoom · right-click to split into cells · Esc to exit zoom</li>
            <li><b>Mini-window:</b> click load · drag title to move · ✎ rename · ⤓ update · × delete</li>
          </ul>
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
            onPointerLeave={() => {
              setCursorModel(null);
              setHoveredUnravelEdge(-1);
              setHoveredUnravelTop(-1);
            }}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
          />
          {/* UNRAVEL · per-panel height inputs. A DOM overlay (NOT canvas-drawn) of
              one <input> per rectangle, positioned by converting each rectangle's
              left edge at its vertical mid to screen via toScreen(viewport). Because
              `viewport` is React state and paint re-runs on it, this JSX re-renders
              on every pan/zoom/resize, so the inputs track the canvas. The container
              is pointer-transparent; only the inputs capture events, so canvas
              pan/zoom elsewhere is unaffected. Cleaned up automatically when leaving
              the view (unravelDraws becomes null). */}
          {unravelOn && unravelDraws && unravelDraws.length > 0 && (
            <div className="unravel-overlay">
              {unravelDraws.map(({ seg, height }) => {
                const anchor = toScreen(viewport, { x: seg.x0, y: height / 2 });
                const draft = unravelInputDraft[seg.index];
                const value = draft !== undefined ? draft : String(Number(height.toFixed(3)));
                return (
                  <input
                    key={seg.index}
                    className="unravel-input"
                    type="number"
                    min={MIN_UNRAVEL_HEIGHT}
                    step={1}
                    value={value}
                    title={`Height of panel (edge #${seg.index}). Enter or blur to apply.`}
                    style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
                    onChange={(e) =>
                      setUnravelInputDraft((prev) => ({ ...prev, [seg.index]: e.target.value }))
                    }
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
                    onBlur={() => commitPanelInput(seg.index)}
                  />
                );
              })}
            </div>
          )}
          {/* UNRAVEL · right-click "split into cells" menu. Positioned in canvas-wrap
              px at the click point; dismissed by Esc or any canvas press. Choosing a
              count sets that panel's per-edge cell split (drawn as division lines). */}
          {cellMenu && (
            <div
              className="cell-menu"
              style={{ left: `${cellMenu.x}px`, top: `${cellMenu.y}px` }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="cell-menu__title">Split panel #{cellMenu.edge} into…</div>
              <div className="cell-menu__grid">
                {[1, 2, 3, 4, 6, 8].map((n) => (
                  <button
                    key={n}
                    className={`cell-menu__btn ${(unravelCells[cellMenu.edge] ?? 1) === n ? "is-active" : ""}`}
                    onClick={() => {
                      setPanelCells(cellMenu.edge, n);
                      setCellMenu(null);
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="cell-menu__custom">
                <input
                  className="panel__input"
                  type="number"
                  min={1}
                  step={1}
                  autoFocus
                  value={cellMenuDraft}
                  aria-label="Custom cell count"
                  onChange={(e) => setCellMenuDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setPanelCells(cellMenu.edge, parseInt(cellMenuDraft, 10));
                      setCellMenu(null);
                    } else if (e.key === "Escape") {
                      setCellMenu(null);
                    }
                  }}
                />
                <button
                  className="btn"
                  onClick={() => {
                    setPanelCells(cellMenu.edge, parseInt(cellMenuDraft, 10));
                    setCellMenu(null);
                  }}
                >
                  Set
                </button>
              </div>
            </div>
          )}
          {/* Saved-perimeter mini-window overlay (anchored top-right of the canvas). */}
          <MiniWindow
            saved={saved}
            activeId={activeSavedId}
            onLoad={loadSavedEntry}
            onDelete={deleteSavedEntry}
            onRename={renameSavedEntry}
            onUpdate={updateSavedEntry}
            canUpdate={saveable}
            stageRef={wrapRef}
            // Hover-link: only highlight while unravelling (the edge index comes
            // from the live unravel layout). MiniWindow applies it to the active
            // entry only, whose geometry matches the live shape.
            highlightEdge={unravelOn ? hoveredUnravelEdge : -1}
            // Per-panel heights of the LIVE shape -> the active (matching)
            // thumbnail's per-wall heights; the global default applies to ALL
            // thumbnails. Not gated on unravelOn: heights persist in state once
            // set, so the active preview reflects them live as they change.
            heights={unravelHeights}
            defaultHeight={unravelHeight}
          />
        </div>
        <div className="statusbar">
          <span className="statusbar__item">
            X {cursorModel ? cursorModel.x.toFixed(3) : "—"}
          </span>
          <span className="statusbar__item">
            Y {cursorModel ? cursorModel.y.toFixed(3) : "—"}
          </span>
          <span className="statusbar__sep" />
          <span className="statusbar__item">
            Seg {drawing && cursorModel && perimeter.vertices.length > 0 ? segLen.toFixed(3) : "—"} u
          </span>
          <span className="statusbar__item">
            ∠ {drawing && cursorModel && perimeter.vertices.length > 0 ? segAng.toFixed(1) : "—"}°
          </span>
          <span className="statusbar__sep" />
          <span className="statusbar__item">Snap {snapEnabled ? "on" : "off"}</span>
          <span className="statusbar__item">Grid {gridSpacing} u</span>
          <span className="statusbar__item statusbar__item--accent">{curveType === "arc" ? "Arc" : "Line"}</span>
          {unravelOn && <span className="statusbar__item statusbar__item--accent">Unravel (CW)</span>}
          {shiftHeld && <span className="statusbar__item statusbar__item--accent">45° lock</span>}
          <span className="statusbar__spacer" />
          <span className="statusbar__item">Zoom {viewport.scale.toFixed(0)} px/u</span>
        </div>
      </main>
    </div>
  );
}

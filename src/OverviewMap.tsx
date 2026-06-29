/**
 * OverviewMap.tsx
 *
 * A small, always-visible NAVIGATOR overlay anchored inside the canvas stage
 * (bottom-left, above the Floor plate / Subtractive / Additive button cluster).
 * It shows a FIT-TO-BOX, centred picture of WHATEVER THE MAIN CANVAS SHOWS — the
 * WHOLE footprint perimeter in the draw/edit view, or the WHOLE unrolled PANEL STRIP
 * in the unravel/elevation view — so the user can glance the entire scope even while
 * the main canvas is zoomed in hard on one part of a very large shape/elevation.
 *
 * It reuses the proven layers — NO geometry or drawing is duplicated:
 *   - `fitViewport(perimeter, w, h, padding)` (core/viewport.ts) frames the shape
 *     into the overview's own pixel box (degenerate spans floored to an epsilon,
 *     so empty / single-point / straight-line inputs never produce a NaN scale).
 *   - the pure `render()` (core/renderer.ts) paints the perimeter with a NEUTRAL
 *     RenderState (no transient edit/unravel feedback), so the overview reads
 *     visually consistent with the main canvas and honours the same CSS tokens.
 *
 * CURRENT-VIEW INDICATOR: a rectangle marks the portion of the model currently
 * visible in the MAIN canvas. The main view's visible model rectangle is found by
 * unprojecting the main canvas corners (`toModel(mainViewport, 0,0)` →
 * `toModel(mainViewport, mainW, mainH)`); those two model points are then
 * projected through the overview's OWN fit viewport (`toScreen`) and stroked. This
 * is the feature's main payoff: at a glance the user sees WHERE they are looking
 * inside the whole shape.
 *
 * DRAGGABLE: the title bar repositions the window (pointer capture + clamped to
 * the stage bounds), mirroring MiniWindow. Until dragged it sits at its CSS
 * anchor; after a drag it stays where dropped.
 *
 * All visual values come from the `=== OVERVIEW MAP ===` token group in
 * styles.css; nothing visual is hardcoded here.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Perimeter } from "./core/geometry";
import { fitViewport, toModel, toScreen, type Viewport } from "./core/viewport";
import { unravelBoundsPerimeter } from "./core/unravel";
import { render, type RenderState, type UnravelDraw } from "./core/renderer";

/** Read a CSS custom property off an element, with a fallback (mirrors renderer). */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}
function cssNum(el: HTMLElement, name: string, fallback: number): number {
  const v = parseFloat(cssVar(el, name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

interface OverviewMapProps {
  /** The LIVE editor perimeter — the overview reflects edits immediately. */
  perimeter: Perimeter;
  /** The MAIN canvas viewport, used to compute the current-view indicator rect. */
  viewport: Viewport;
  /** The MAIN canvas pixel size (CSS px) — its visible model rect is derived from this. */
  mainSize: { w: number; h: number };
  /** Snap grid spacing — passed through to the neutral RenderState (drives no drawing). */
  gridSpacing: number;
  /**
   * Whether the main canvas is in the UNRAVEL / elevation view. When true the
   * overview frames the unrolled PANEL STRIP (from {@link unravelDraws}) instead of
   * the footprint, mirroring whatever the main canvas shows — so the same view
   * model space is used and the current-view indicator stays meaningful in BOTH views.
   */
  unravelOn: boolean;
  /**
   * The resolved unravel panels (segment + height + cells + divisions) to draw in
   * the overview while {@link unravelOn}. Null/empty falls back to the footprint.
   */
  unravelDraws: UnravelDraw[] | null;
  /** Bounds the window is dragged within (the canvas stage in CSS px). */
  stageRef: React.RefObject<HTMLElement>;
}

export default function OverviewMap({
  perimeter,
  viewport,
  mainSize,
  gridSpacing,
  unravelOn,
  unravelDraws,
  stageRef,
}: OverviewMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  // Position: null means "anchored bottom-left by CSS"; once the user drags it we
  // switch to explicit left/top coordinates (CSS px within the stage).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);
  // Handle of the in-flight "reset to default" animation (rAF id), so a new drag /
  // unmount can cancel it cleanly.
  const resetAnimRef = useRef<number | null>(null);

  // --- Drag anywhere on the overview to reposition (clamped to the stage). ---
  const onPointerDown = (e: React.PointerEvent) => {
    const win = winRef.current;
    const stage = stageRef.current;
    if (!win || !stage) return;
    // Grabbing the window cancels any running snap-back animation so the drag wins.
    if (resetAnimRef.current !== null) {
      cancelAnimationFrame(resetAnimRef.current);
      resetAnimRef.current = null;
    }
    const winRect = win.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    dragRef.current = { offX: e.clientX - winRect.left, offY: e.clientY - winRect.top };
    // Seed explicit position from the current rendered spot so the first move
    // doesn't jump from the CSS-anchored (bottom-left) location.
    setPos({ x: winRect.left - stageRect.left, y: winRect.top - stageRect.top });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const win = winRef.current;
    const stage = stageRef.current;
    if (!drag || !win || !stage) return;
    const stageRect = stage.getBoundingClientRect();
    let x = e.clientX - stageRect.left - drag.offX;
    let y = e.clientY - stageRect.top - drag.offY;
    // Clamp so the window stays fully within the stage.
    const maxX = Math.max(0, stageRect.width - win.offsetWidth);
    const maxY = Math.max(0, stageRect.height - win.offsetHeight);
    x = Math.min(Math.max(0, x), maxX);
    y = Math.min(Math.max(0, y), maxY);
    setPos({ x, y });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // --- Double-click: SMOOTHLY animate back to the default (CSS-anchored) position
  // instead of teleporting. We measure the anchored spot by momentarily clearing the
  // inline offsets and reading the laid-out rect (synchronous — no paint between, so no
  // flash), then tween `pos` from where it sits now to that target with rAF, and finally
  // drop back to `pos = null` so CSS owns the resting position again. ---
  const resetToDefault = () => {
    const win = winRef.current;
    const stage = stageRef.current;
    // No element to measure → fall back to the instant reset.
    if (!win || !stage) {
      setPos(null);
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    const startRect = win.getBoundingClientRect();
    const start = { x: startRect.left - stageRect.left, y: startRect.top - stageRect.top };
    // Measure the DEFAULT anchored position: clear the inline offsets, read, restore.
    const prev = {
      left: win.style.left, top: win.style.top, right: win.style.right, bottom: win.style.bottom,
    };
    win.style.left = ""; win.style.top = ""; win.style.right = ""; win.style.bottom = "";
    const defRect = win.getBoundingClientRect();
    const target = { x: defRect.left - stageRect.left, y: defRect.top - stageRect.top };
    win.style.left = prev.left; win.style.top = prev.top; win.style.right = prev.right; win.style.bottom = prev.bottom;
    // Already at (or within a pixel of) the default → just release to CSS, no animation.
    if (Math.abs(start.x - target.x) < 0.5 && Math.abs(start.y - target.y) < 0.5) {
      setPos(null);
      return;
    }
    if (resetAnimRef.current !== null) cancelAnimationFrame(resetAnimRef.current);
    const DURATION_MS = 220;
    const t0 = performance.now();
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION_MS);
      const k = easeOutCubic(t);
      setPos({ x: start.x + (target.x - start.x) * k, y: start.y + (target.y - start.y) * k });
      if (t < 1) {
        resetAnimRef.current = requestAnimationFrame(step);
      } else {
        resetAnimRef.current = null;
        setPos(null); // settle onto the CSS anchor (same spot the tween ended on)
      }
    };
    resetAnimRef.current = requestAnimationFrame(step);
  };

  // Cancel any in-flight snap-back animation on unmount.
  useEffect(() => {
    return () => {
      if (resetAnimRef.current !== null) cancelAnimationFrame(resetAnimRef.current);
    };
  }, []);

  // Keep the window inside the stage if it shrinks (e.g. resize) with a manual pos.
  useEffect(() => {
    if (!pos) return;
    const win = winRef.current;
    const stage = stageRef.current;
    if (!win || !stage) return;
    const maxX = Math.max(0, stage.clientWidth - win.offsetWidth);
    const maxY = Math.max(0, stage.clientHeight - win.offsetHeight);
    if (pos.x > maxX || pos.y > maxY) {
      setPos({ x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) });
    }
  }, [pos, stageRef]);

  // Repaint whenever the perimeter, the main viewport, the main size, or the
  // indicator toggle changes. We FIT the whole shape into the overview's pixel box
  // and render it with a neutral state, then overlay the current-view rectangle.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    // Choose what to frame: in the UNRAVEL view, the unrolled panel strip (same
    // model space the main canvas uses there); otherwise the footprint perimeter.
    // This keeps the overview a faithful mini-map of whatever the main view shows.
    const useUnravel = unravelOn && unravelDraws != null && unravelDraws.length > 0;
    const pad = cssNum(canvas, "--overview-padding", 8);

    // Frame the chosen scene into this box. fitViewport floors degenerate spans to
    // an epsilon, so empty / single-point / straight-line inputs stay finite.
    //
    // OVERVIEW_MIN_SCALE: the navigator box is tiny (≈200×150 px) but the model it
    // frames can be huge — especially a WIDE many-panel unravel strip (the sum of
    // every wall length). The main canvas's 0.25 px/unit zoom-OUT floor would clamp
    // the fit and let the strip OVERFLOW the box (only its centre showing), so the
    // overview passes a near-zero floor: it must always frame the FULL extent.
    const OVERVIEW_MIN_SCALE = 1e-6;
    let fit: Viewport;
    if (useUnravel) {
      // Bounds = each panel rectangle (baseline → its own height), reusing the same
      // helper the main view's fit uses, so the strip frames identically. Built from
      // ALL unravelDraws (every panel), so the FULL width and the TALLEST height frame.
      const segments = unravelDraws!.map((d) => d.seg);
      const heightById = new Map(unravelDraws!.map((d) => [d.seg.index, d.height]));
      const bounds = unravelBoundsPerimeter(segments, (seg) => heightById.get(seg.index) ?? 0);
      fit = fitViewport(bounds, w, h, pad, OVERVIEW_MIN_SCALE);
    } else {
      fit = fitViewport(perimeter, w, h, pad, OVERVIEW_MIN_SCALE);
    }

    // Neutral RenderState framed by the fit viewport, with NO transient edit
    // feedback. In unravel mode we pass the resolved panels so render()'s unravel
    // branch draws the strip — but as BOUNDARIES ONLY (outlineOnly /
    // unravelBoundariesOnly below): just the panel rectangles, no dimension labels,
    // cells, divisions or floor plates. In perimeter mode it draws the footprint
    // OUTLINE only (no vertex dots). Either way it stays a clean, glanceable mini-map.
    const state: RenderState = {
      perimeter,
      viewport: fit,
      cursorModel: null,
      drawing: false,
      rubberBand: false,
      selectedVertex: -1,
      hoveredVertex: -1,
      handleVertex: -1,
      insertPreview: null,
      gridSpacing,
      unravel: useUnravel ? unravelDraws : null,
      hoveredUnravelEdge: -1,
      hoveredUnravelTop: -1,
      selectedUnravelPanel: -1,
      highlightEdge: -1,
      floorPlates: null,
      floorPlatePreview: null,
      dividePreview: null,
      // OVERVIEW opt-ins: show JUST the shape (no vertex dots / edit overlays) in
      // the perimeter view, and JUST the panel rectangle boundaries (no dimension
      // labels / cells / divisions / floor plates / emphasis) in the unravel view.
      outlineOnly: true,
      unravelBoundariesOnly: true,
    };
    render(ctx, canvas, w, h, dpr, state);

    // CURRENT-VIEW INDICATOR. render() leaves the transform at (dpr,0,0,dpr,0,0),
    // so we keep drawing in CSS px. Unproject the MAIN canvas corners to model
    // space (screen +Y down flips to model +Y up, so top-left screen → max-Y model
    // and bottom-right screen → min-Y model), then project those model points
    // through the overview's OWN fit viewport to get the rect in overview pixels.
    // Meaningful in BOTH views now: the overview and the main canvas share the same
    // model space in each mode (footprint ↔ footprint, strip ↔ strip).
    if (mainSize.w > 0 && mainSize.h > 0) {
      const mTL = toModel(viewport, 0, 0);
      const mBR = toModel(viewport, mainSize.w, mainSize.h);
      const s1 = toScreen(fit, mTL);
      const s2 = toScreen(fit, mBR);
      const x = Math.min(s1.x, s2.x);
      const y = Math.min(s1.y, s2.y);
      const rw = Math.abs(s2.x - s1.x);
      const rh = Math.abs(s2.y - s1.y);
      ctx.strokeStyle = cssVar(canvas, "--overview-indicator-color", "#c2700a");
      ctx.lineWidth = cssNum(canvas, "--overview-indicator-width", 1.5);
      ctx.strokeRect(x, y, rw, rh);
    }
  }, [perimeter, viewport, mainSize.w, mainSize.h, gridSpacing, unravelOn, unravelDraws]);

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : {};

  return (
    <div
      className="overview"
      ref={winRef}
      style={style}
      role="region"
      aria-label="Overview map — drag to reposition — double-click to reset position"
      title="Drag to reposition — double-click to reset to default position"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={resetToDefault}
    >
      {/* ===== FIT-TO-VIEW SCENE + CURRENT-VIEW RECT ===== */}
      <div className="overview__body">
        <canvas ref={canvasRef} className="overview__canvas" />
      </div>
    </div>
  );
}

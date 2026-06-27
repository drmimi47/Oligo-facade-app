/**
 * ExportPopup.tsx
 *
 * Modal popup for exporting the walls SELECTED via the Export marquee. Portalled
 * into the canvas stage so it floats over the scene with a dimming backdrop. It
 * mirrors the conventions already established by the mini-window and Solar Study (a
 * draggable title bar; a DPR-aware render3d preview the user can drag to orbit) and
 * adds the modal affordances: a backdrop, an attention-flash when the user clicks
 * OUTSIDE the dialog (a "you must deal with me" nudge rather than a silent close),
 * and Esc / × to dismiss.
 *
 * The preview shows ONLY the selected walls — extrude3d's `edges` filter builds a
 * sub-massing of just those edges, each at its real per-edge height. The three
 * export buttons (Revit / AutoCAD / Rhino) each download a unit-preserving DXF of
 * the same selection (see core/exporters.ts for why one DXF serves all three).
 *
 * All visual values come from CSS tokens (the EXPORT SELECTION + POPUP section in
 * styles.css); nothing visual is hardcoded here.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Perimeter } from "./core/geometry";
import { render3d, DEFAULT_CAMERA, type Camera } from "./core/extrude3d";
import { selectionToDxf } from "./core/exporters";

/** Drag sensitivity for the orbit gesture (radians per pixel) — matches MiniWindow. */
const ROTATE_RAD_PER_PX = 0.01;
/** Elevation clamp (radians) so the orbit can't flip over the poles. */
const ELEVATION_LIMIT = 1.45; // ~83°
/** Margin (px) left around the massing inside the preview canvas. */
const PREVIEW_MARGIN_PX = 16;

/** One export target: button label + the file name its download produces. */
interface ExportTarget {
  /** App this DXF is aimed at (used in the button label + the file name). */
  app: string;
  /** Short note shown under the label clarifying the format. */
  note: string;
  /** Download file name. */
  file: string;
}

/**
 * The three export targets. All emit a unit-preserving DXF (see exporters.ts); the
 * label names the destination app so the intent is explicit. Native .3dm / IFC /
 * DWG can be layered behind these same buttons later without changing the UI.
 */
const TARGETS: ExportTarget[] = [
  { app: "Revit", note: "DXF · Insert ▸ Link/Import CAD", file: "facade-selection-revit.dxf" },
  { app: "AutoCAD", note: "DXF · native import", file: "facade-selection-autocad.dxf" },
  { app: "Rhino", note: "DXF · File ▸ Import", file: "facade-selection-rhino.dxf" },
];

interface ExportPopupProps {
  /** The live editor perimeter (feet). */
  perimeter: Perimeter;
  /** ORIGINAL edge indices selected for export. */
  edges: ReadonlySet<number>;
  /** Per-edge height overrides (model units / feet). */
  heights: Record<number, number>;
  /** Default wall height (model units / feet) for any edge without an override. */
  defaultHeight: number;
  /** Stage element to portal into and to bound the drag within (the canvas wrap). */
  stageRef: React.RefObject<HTMLElement>;
  /** Close the popup. */
  onClose: () => void;
}

export default function ExportPopup({
  perimeter,
  edges,
  heights,
  defaultHeight,
  stageRef,
  onClose,
}: ExportPopupProps) {
  const stage = stageRef.current;
  const winRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Position: null = centred by CSS; once dragged we switch to explicit left/top.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);

  // Orbit camera for the preview (drag the canvas to spin), like MiniWindow's Thumb.
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const rotRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);

  /** Effective height for one edge — per-edge override else the default. */
  const heightOf = (edge: number): number => heights[edge] ?? defaultHeight;

  // Attention-flash: restart the CSS pulse imperatively (remove + reflow + re-add)
  // so it replays even on rapid repeat clicks, WITHOUT remounting the dialog (which
  // would blank the preview canvas).
  const triggerFlash = () => {
    const el = winRef.current;
    if (!el) return;
    el.classList.remove("is-flashing");
    void el.offsetWidth; // force reflow so the animation restarts from the top
    el.classList.add("is-flashing");
  };

  // --- Esc closes the dialog (modal convention). ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // --- Title-bar drag to reposition (clamped to the stage), mirroring MiniWindow. ---
  const onTitlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const win = winRef.current;
    if (!win || !stage) return;
    const winRect = win.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    dragRef.current = { offX: e.clientX - winRect.left, offY: e.clientY - winRect.top };
    setPos({ x: winRect.left - stageRect.left, y: winRect.top - stageRect.top });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onTitlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const win = winRef.current;
    if (!drag || !win || !stage) return;
    const stageRect = stage.getBoundingClientRect();
    let x = e.clientX - stageRect.left - drag.offX;
    let y = e.clientY - stageRect.top - drag.offY;
    const maxX = Math.max(0, stageRect.width - win.offsetWidth);
    const maxY = Math.max(0, stageRect.height - win.offsetHeight);
    x = Math.min(Math.max(0, x), maxX);
    y = Math.min(Math.max(0, y), maxY);
    setPos({ x, y });
  };
  const onTitlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // --- Preview orbit gesture (drag the canvas), mirroring MiniWindow's Thumb. ---
  const onPreviewPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    rotRef.current = { x: e.clientX, y: e.clientY, az: camera.azimuth, el: camera.elevation };
  };
  const onPreviewPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = rotRef.current;
    if (!r) return;
    const dx = e.clientX - r.x;
    const dy = e.clientY - r.y;
    const az = r.az + dx * ROTATE_RAD_PER_PX;
    const el = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, r.el - dy * ROTATE_RAD_PER_PX));
    setCamera({ azimuth: az, elevation: el });
  };
  const onPreviewPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    rotRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Paint the preview: extrude ONLY the selected walls (edges filter), each at its
  // real per-edge height. DPR-aware sizing to the CSS box, exactly like MiniWindow.
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
    render3d(ctx, canvas, w, h, dpr, perimeter, {
      marginPx: PREVIEW_MARGIN_PX,
      camera,
      height: defaultHeight,
      heights,
      edges, // restrict the massing to just the selected walls
    });
  }, [perimeter, camera, heights, defaultHeight, edges]);

  /** Build the selection's DXF (feet, units-preserving) and download it. */
  const downloadDxf = (file: string) => {
    const dxf = selectionToDxf(perimeter, edges, heightOf);
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // The popup lives inside the stage so it overlays the canvas; bail if not mounted.
  if (!stage) return null;

  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y, transform: "none" } : {};
  const count = edges.size;

  return createPortal(
    <div
      className="modal-backdrop"
      // Click OUTSIDE the dialog flashes it for attention (does not close — the
      // user must use × or Esc), matching the app's other popups.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) triggerFlash();
      }}
    >
      <div
        className="export-popup"
        ref={winRef}
        style={style}
        onAnimationEnd={() => winRef.current?.classList.remove("is-flashing")}
        role="dialog"
        aria-label="Export selected walls"
      >
        {/* ===== TITLE BAR (drag handle) ===== */}
        <div
          className="export-popup__titlebar"
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
        >
          <span className="export-popup__title">
            Export · {count} wall{count === 1 ? "" : "s"} selected
          </span>
          <button
            className="export-popup__close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ===== BODY: preview + export buttons ===== */}
        <div className="export-popup__body">
          <canvas
            ref={canvasRef}
            className="export-popup__preview"
            onPointerDown={onPreviewPointerDown}
            onPointerMove={onPreviewPointerMove}
            onPointerUp={onPreviewPointerUp}
            title="Drag to orbit the 3D preview of the selected walls"
          />
          <div className="export-popup__hint">
            3D preview of the selected walls (drag to orbit). Files preserve real
            dimensions in feet.
          </div>
          <div className="export-popup__targets">
            {TARGETS.map((t) => (
              <button
                key={t.app}
                className="export-popup__target"
                onClick={() => downloadDxf(t.file)}
                title={`Download a unit-preserving DXF for ${t.app}`}
              >
                <span className="export-popup__target-app">{t.app}</span>
                <span className="export-popup__target-note">{t.note}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    stage,
  );
}

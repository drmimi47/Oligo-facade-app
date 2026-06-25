/**
 * MiniWindow.tsx
 *
 * A draggable, collapsible overlay anchored to the TOP-RIGHT of the canvas
 * stage that shows the user's SAVED perimeters as a gallery of live thumbnails.
 *
 * It is purely a VIEW + INPUT surface over the saved-perimeter data: it owns no
 * geometry math. Each thumbnail repaints the saved shape as an EXTRUDED 3D
 * MASSING via `render3d()` (core/extrude3d.ts) — the footprint extruded up into
 * wall panels — which frames the massing into the thumbnail box itself. The pure
 * 3D logic lives in core/extrude3d.ts; this file only wires the canvas to it.
 *
 * Interactions (documented in NOTES.md too):
 *   - Click a thumbnail        -> load that perimeter into the editor.
 *   - Rename (double-click name / pencil) -> inline edit, Enter/blur commits.
 *   - Delete (×)               -> remove that save.
 *   - Update (⤓)               -> overwrite that save with the current editor shape.
 *   - Drag the title bar       -> reposition the window (clamped to the stage).
 *   - Collapse/expand (▾/▸)    -> hide/show the gallery body.
 *
 * All visual values come from CSS tokens in styles.css (the `MINI-WINDOW`
 * section); nothing visual is hardcoded here.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SavedPerimeter } from "./core/savedPerimeters";
import { savedStats } from "./core/savedPerimeters";
import { render3d, DEFAULT_CAMERA, type Camera } from "./core/extrude3d";

/** Drag sensitivity (radians of camera rotation per pixel dragged). */
const ROTATE_RAD_PER_PX = 0.01;
/** Elevation clamp (radians) so the camera can't flip fully over the poles. */
const ELEVATION_LIMIT = 1.45; // ~83°
/** Pointer travel (px) past which a thumbnail press counts as a rotate, not a click. */
const ROTATE_CLICK_THRESHOLD_PX = 3;

/** Margin (px) left around each thumbnail's massing inside its canvas. */
const THUMB_MARGIN_PX = 8;

interface MiniWindowProps {
  /** The saved perimeters to display. */
  saved: SavedPerimeter[];
  /** Whether a saved entry is currently loaded into the editor (highlight it). */
  activeId: string | null;
  /** Load a saved perimeter into the main editor. */
  onLoad: (s: SavedPerimeter) => void;
  /** Delete a saved perimeter. */
  onDelete: (id: string) => void;
  /** Rename a saved perimeter. */
  onRename: (id: string, name: string) => void;
  /** Overwrite a saved entry with the current editor perimeter. */
  onUpdate: (id: string) => void;
  /** Whether updating-in-place is allowed (current editor shape is saveable). */
  canUpdate: boolean;
  /** Bounds the window is dragged within (the stage size in CSS px). */
  stageRef: React.RefObject<HTMLElement>;
  /**
   * Hover-link: original edge index to highlight on the ACTIVE entry's thumbnail
   * (the one whose geometry matches the live shape being unravelled), or -1/none.
   * Only the `activeId` thumbnail receives it, since the edge index only maps
   * correctly onto a thumbnail whose geometry matches the live perimeter.
   */
  highlightEdge?: number;
  /**
   * Per-ORIGINAL-edge-index height overrides for the LIVE editor shape (model
   * units). Like {@link highlightEdge}, these only apply to the ACTIVE entry's
   * thumbnail (the one whose geometry matches the live shape); non-active
   * thumbnails extrude uniformly to {@link defaultHeight}.
   */
  heights?: Record<number, number>;
  /**
   * Global/default wall height (model units) for ALL thumbnails. Changing it
   * updates every preview uniformly; per-edge `heights` only affect the active one.
   */
  defaultHeight?: number;
}

export default function MiniWindow({
  saved,
  activeId,
  onLoad,
  onDelete,
  onRename,
  onUpdate,
  canUpdate,
  stageRef,
  highlightEdge,
  heights,
  defaultHeight,
}: MiniWindowProps) {
  // Position: null means "anchored top-right by CSS"; once the user drags it we
  // switch to explicit left/top coordinates (CSS px within the stage).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const winRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);

  // --- Title-bar drag to reposition (clamped to the stage) ---
  const onTitlePointerDown = (e: React.PointerEvent) => {
    // Ignore drags that start on a button (collapse/expand control).
    if ((e.target as HTMLElement).closest("button")) return;
    const win = winRef.current;
    const stage = stageRef.current;
    if (!win || !stage) return;
    const winRect = win.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    dragRef.current = {
      offX: e.clientX - winRect.left,
      offY: e.clientY - winRect.top,
    };
    // Seed explicit position from the current rendered spot so the first move
    // doesn't jump from the CSS-anchored location.
    setPos({ x: winRect.left - stageRect.left, y: winRect.top - stageRect.top });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onTitlePointerMove = (e: React.PointerEvent) => {
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

  const onTitlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // Keep the window inside the stage if the stage shrinks (e.g. resize) while a
  // manual position is set.
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

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: "auto" }
    : {};

  return (
    <div className="mini" ref={winRef} style={style} role="region" aria-label="Saved perimeters">
      {/* ===== TITLE BAR (drag handle) ===== */}
      <div
        className="mini__titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <span className="mini__title">Saved ({saved.length})</span>
        <button
          className="mini__iconbtn"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand" : "Collapse"}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {/* ===== GALLERY BODY ===== */}
      {!collapsed && (
        <div className="mini__body">
          {saved.length === 0 ? (
            <div className="mini__empty">No saved perimeters yet. Use “Save” in the panel.</div>
          ) : (
            <ul className="mini__list">
              {saved.map((s) => (
                <Thumb
                  key={s.id}
                  saved={s}
                  active={s.id === activeId}
                  onLoad={onLoad}
                  onDelete={onDelete}
                  onRename={onRename}
                  onUpdate={onUpdate}
                  canUpdate={canUpdate}
                  // Only the active entry's geometry matches the live unravelled
                  // shape, so only it can carry a meaningful edge highlight.
                  highlightEdge={s.id === activeId ? highlightEdge ?? -1 : -1}
                  // Per-edge heights belong to the live shape, so only the active
                  // entry honours them; others extrude uniformly to the default.
                  heights={s.id === activeId ? heights : undefined}
                  defaultHeight={defaultHeight}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface ThumbProps {
  saved: SavedPerimeter;
  active: boolean;
  onLoad: (s: SavedPerimeter) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onUpdate: (id: string) => void;
  canUpdate: boolean;
  /** Edge index to highlight on this thumbnail, or -1 for none. */
  highlightEdge: number;
  /** Per-edge height overrides to extrude this thumbnail with, or undefined for none. */
  heights?: Record<number, number>;
  /** Default/global wall height (model units), or undefined for the built-in default. */
  defaultHeight?: number;
}

/** One saved-perimeter row: a live thumbnail + name + stats + actions. */
function Thumb({ saved, active, onLoad, onDelete, onRename, onUpdate, canUpdate, highlightEdge, heights, defaultHeight }: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved.name);
  const stats = savedStats(saved);

  // Per-thumbnail 3D camera the user can spin by dragging on the preview.
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  // Gesture tracking: rotRef holds the drag start (pointer + camera); movedRef
  // tells the click handler whether this was a rotate-drag (don't load) or a tap.
  const rotRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);
  const movedRef = useRef(false);

  const onThumbPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    rotRef.current = { x: e.clientX, y: e.clientY, az: camera.azimuth, el: camera.elevation };
    movedRef.current = false;
  };

  const onThumbPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = rotRef.current;
    if (!r) return;
    const dx = e.clientX - r.x;
    const dy = e.clientY - r.y;
    if (Math.abs(dx) + Math.abs(dy) > ROTATE_CLICK_THRESHOLD_PX) movedRef.current = true;
    // Drag horizontally -> spin (azimuth); drag up -> raise the view (elevation).
    const az = r.az + dx * ROTATE_RAD_PER_PX;
    const el = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, r.el - dy * ROTATE_RAD_PER_PX));
    setCamera({ azimuth: az, elevation: el });
  };

  const onThumbPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    rotRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Load only on a genuine click, not at the end of a rotate-drag.
  const onThumbClick = () => {
    if (movedRef.current) return;
    onLoad(saved);
  };

  // Paint the thumbnail whenever the geometry changes. We size the canvas to its
  // CSS box (DPR-aware) and render the perimeter as an EXTRUDED 3D MASSING (the
  // footprint walls extruded up). The 3D renderer frames the whole massing
  // (footprint + height) into the thumbnail box itself, so no 2D viewport is
  // needed. The hovered-unravel edge highlights the matching wall panel in 3D.
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

    render3d(ctx, canvas, w, h, dpr, saved.perimeter, {
      marginPx: THUMB_MARGIN_PX,
      camera,
      // Global default height for every wall (per-edge overrides applied below).
      height: defaultHeight,
      // Per-edge heights (active entry only); undefined => uniform default height.
      heights,
      // Hover-link: highlight the wall panel matching the hovered unravel strip.
      highlightEdge,
    });
  }, [saved.perimeter, highlightEdge, heights, defaultHeight, camera]);

  const commitRename = () => {
    const name = draft.trim();
    if (name && name !== saved.name) onRename(saved.id, name);
    else setDraft(saved.name);
    setEditing(false);
  };

  return (
    <li className={`mini__item ${active ? "is-active" : ""}`}>
      <button
        className="mini__thumb"
        onClick={onThumbClick}
        title="Click to load · drag to rotate the 3D preview"
      >
        <canvas
          ref={canvasRef}
          className="mini__canvas"
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
        />
      </button>

      <div className="mini__meta">
        {editing ? (
          <input
            className="mini__nameinput"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(saved.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="mini__name"
            onClick={() => onLoad(saved)}
            onDoubleClick={() => {
              setDraft(saved.name);
              setEditing(true);
            }}
            title="Click to load · double-click to rename"
          >
            {saved.name}
          </button>
        )}
        <div className="mini__stats">
          {stats.vertices} v · {stats.length.toFixed(1)} u
          {saved.perimeter.closed ? ` · ${stats.area.toFixed(1)} u²` : ""}
        </div>
      </div>

      <div className="mini__actions">
        <button
          className="mini__iconbtn"
          onClick={() => {
            setDraft(saved.name);
            setEditing(true);
          }}
          title="Rename"
          aria-label="Rename"
        >
          ✎
        </button>
        <button
          className="mini__iconbtn"
          onClick={() => onUpdate(saved.id)}
          disabled={!canUpdate}
          title="Overwrite this save with the current editor shape"
          aria-label="Update"
        >
          ⤓
        </button>
        <button
          className="mini__iconbtn mini__iconbtn--danger"
          onClick={() => onDelete(saved.id)}
          title="Delete this save"
          aria-label="Delete"
        >
          ×
        </button>
      </div>
    </li>
  );
}

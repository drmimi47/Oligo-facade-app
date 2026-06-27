/**
 * Settings.tsx
 *
 * A draggable popup for application settings, opened from the gear button at the
 * top-right of the nav header. It reuses the SAME chrome as the Solar Study popup
 * (draggable title bar, close button, surface/shadow tokens) so the two read as
 * siblings — see the shared `.solar, .settings` rules in styles.css.
 *
 * The body is intentionally BLANK for now (only the "Settings" title is shown);
 * controls will be added later. Like SolarStudy / MiniWindow / OverviewMap the title
 * bar drags the popup (clamped to the stage) and all visual values come from CSS
 * tokens — nothing visual is hardcoded here.
 */

import { useRef, useState } from "react";

interface SettingsProps {
  /** Close the popup. */
  onClose: () => void;
  /** Bounds the popup is dragged within (the canvas stage in CSS px). */
  stageRef: React.RefObject<HTMLElement>;
  /** When true, plays the attention-flash animation (user clicked outside). */
  isFlashing?: boolean;
}

export default function Settings({ onClose, stageRef, isFlashing }: SettingsProps) {
  const winRef = useRef<HTMLDivElement>(null);
  // Position: null means "centred by CSS"; once dragged we switch to explicit px.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);

  // --- Title-bar drag to reposition (clamped to the stage) — mirrors SolarStudy. ---
  const onTitlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // ignore the close button
    const win = winRef.current;
    const stage = stageRef.current;
    if (!win || !stage) return;
    const winRect = win.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    dragRef.current = { offX: e.clientX - winRect.left, offY: e.clientY - winRect.top };
    // Seed explicit position from the current rendered spot so the first move doesn't
    // jump from the CSS-centred location.
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

  // Esc-to-close is handled centrally in PolylineTool's keydown handler (top of the
  // Escape chain), alongside the app's other popups/menus — so it isn't duplicated here.

  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y, transform: "none" } : {};

  return (
    <div className={`settings${isFlashing ? " settings--flash" : ""}`} ref={winRef} style={style} role="dialog" aria-label="Settings">
      {/* ===== TITLE BAR (drag handle) ===== */}
      <div
        className="settings__titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <span className="settings__title">Settings</span>
        <button className="settings__close" onClick={onClose} title="Close" aria-label="Close">
          ×
        </button>
      </div>

      {/* ===== BODY — intentionally blank for now (controls added later). ===== */}
      <div className="settings__body" />
    </div>
  );
}

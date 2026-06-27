/**
 * Settings.tsx
 *
 * A draggable popup for application settings, opened from the gear button at the
 * top-right of the nav header. It reuses the SAME chrome as the Solar Study popup
 * (draggable title bar, close button, surface/shadow tokens) so the two read as
 * siblings — see the shared `.solar, .settings` rules in styles.css.
 *
 * Internally it follows a Rhino-style two-pane layout: a category rail on the LEFT
 * and the selected category's controls on the RIGHT. Only the "Units" category exists
 * for now, holding a length-unit switch (Feet ′ ↔ Metric m).
 *
 * The switch is a DRAFT until the user clicks Save: `pending` holds the in-popup
 * choice and only `onSave(pending)` applies it app-wide (the parent then re-units every
 * label). Closing without saving discards the draft. Switching units only changes how
 * dimensions are FORMATTED — the stored geometry stays in feet (see core/units).
 *
 * Like SolarStudy / MiniWindow / OverviewMap the title bar drags the popup (clamped to
 * the stage) and all visual values come from CSS tokens — nothing visual is hardcoded.
 */

import { useRef, useState } from "react";
import type { UnitSystem } from "./core/units";

/** Categories listed in the left rail. Only "Units" for now; add more as needed. */
const CATEGORIES = ["Units"] as const;
type Category = (typeof CATEGORIES)[number];

interface SettingsProps {
  /** Close the popup. */
  onClose: () => void;
  /** Bounds the popup is dragged within (the canvas stage in CSS px). */
  stageRef: React.RefObject<HTMLElement>;
  /** When true, plays the attention-flash animation (user clicked outside). */
  isFlashing?: boolean;
  /** The currently APPLIED display unit (seeds the draft + marks "saved" state). */
  unitSystem: UnitSystem;
  /** Apply a unit choice app-wide. Called from the Save button with the draft value. */
  onSave: (u: UnitSystem) => void;
}

export default function Settings({ onClose, stageRef, isFlashing, unitSystem, onSave }: SettingsProps) {
  const winRef = useRef<HTMLDivElement>(null);
  // Position: null means "centred by CSS"; once dragged we switch to explicit px.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);

  // Selected category (left rail) and the DRAFT length-unit (right pane). The draft is
  // seeded from the applied unit and only takes effect on Save.
  const [category, setCategory] = useState<Category>("Units");
  const [pending, setPending] = useState<UnitSystem>(unitSystem);
  // No unsaved change when the draft matches what's already applied — used to disable
  // Save so it doubles as a "saved" indicator right after applying.
  const dirty = pending !== unitSystem;

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

      {/* ===== BODY — Rhino-style two-pane: category rail (left) + content (right). ===== */}
      <div className="settings__body">
        {/* LEFT: category rail */}
        <nav className="settings__nav" aria-label="Settings categories">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`settings__nav-item${c === category ? " is-active" : ""}`}
              aria-current={c === category ? "true" : undefined}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </nav>

        {/* RIGHT: content pane for the selected category */}
        <div className="settings__pane">
          {category === "Units" && (
            <>
              <h3 className="settings__pane-title">Units</h3>
              <div className="settings__row">
                <label className="settings__label" id="settings-length-unit">
                  Length units
                </label>
                <div className="segmented" role="group" aria-labelledby="settings-length-unit">
                  <button
                    type="button"
                    className={`segmented__btn${pending === "imperial" ? " is-active" : ""}`}
                    aria-pressed={pending === "imperial"}
                    onClick={() => setPending("imperial")}
                  >
                    Feet ′
                  </button>
                  <button
                    type="button"
                    className={`segmented__btn${pending === "metric" ? " is-active" : ""}`}
                    aria-pressed={pending === "metric"}
                    onClick={() => setPending("metric")}
                  >
                    Metric m
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ===== FOOTER — Save applies the draft app-wide AND closes the popup. Stays
              disabled/greyed until the draft differs from what's applied, so it doubles
              as the deliberate "commit + exit" action once something is changed. ===== */}
      <div className="settings__footer">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onSave(pending);
            onClose();
          }}
          disabled={!dirty}
          title={dirty ? "Apply settings and close" : "No changes to save"}
        >
          Save
        </button>
      </div>
    </div>
  );
}

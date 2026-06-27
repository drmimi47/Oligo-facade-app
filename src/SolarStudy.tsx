/**
 * SolarStudy.tsx
 *
 * A draggable popup that shows a LARGER view of a saved perimeter's 3D massing
 * (the same extruded preview as the mini-window thumbnail, via `render3d`) wrapped
 * in a 3D SUN-PATH DIAGRAM, plus controls to set the sketch's cardinal orientation
 * and the studied date / time. Opened from the "☀" button on a saved row.
 *
 * Real data, not decoration: the sun dome (compass rose, season + selected-day
 * sun-path arcs, hour marks, and the live sun) is computed from real solar geometry
 * (core/solar.ts) driven by latitude, day of year, solar time, and the sketch's
 * cardinal orientation (`northOffset`). Latitude/longitude currently default to
 * Omaha, NE (a temporary stand-in) and will later be supplied by the planned Mapbox
 * geocoding of the typed address; the model already stores them so accuracy improves
 * without reworking this UI. Because the dome is drawn in the SAME camera as the
 * massing, rotating the model rotates the whole study, and the persisted north +
 * study set are what a later step will use to encode each facade's cardinal facing.
 *
 * The LOCATION field inherits the entry's typed address and pushes edits back via
 * `onLocationChange`; the SOLAR settings persist via `onSolarChange`. Like
 * MiniWindow / OverviewMap the title bar drags the popup, and ALL visual values come
 * from CSS tokens in styles.css (the `SOLAR STUDY` section) — nothing visual is
 * hardcoded here.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SavedPerimeter, LocationInfo } from "./core/savedPerimeters";
import { emptyLocation } from "./core/savedPerimeters";
import { render3d, DEFAULT_CAMERA, PLAN_CAMERA, DEFAULT_WALL_HEIGHT_FT, type Camera } from "./core/extrude3d";
import { easeInOut, shortestAngleDelta } from "./core/viewport";
import {
  defaultSolarSettings,
  cloneSolarSettings,
  sunPosition,
  formatDayOfYear,
  formatHour,
  type SolarSettings,
} from "./core/solar";

/** Drag sensitivity (radians of camera rotation per pixel) — matches the thumbnail. */
const ROTATE_RAD_PER_PX = 0.01;
/** Elevation clamp (radians) so the camera can't flip over the poles. */
const ELEVATION_LIMIT = 1.45; // ~83°
/** Margin (px) left around the dome inside the larger canvas. */
const STUDY_MARGIN_PX = 28;
/** Duration (ms) of the double-click aerial (plan) view animation. */
const PLAN_ANIM_MS = 290;

interface SolarStudyProps {
  /** The saved entry being studied (its stored massing + location + solar settings). */
  entry: SavedPerimeter;
  /** Global/default wall height (model units) for walls without a per-edge override. */
  defaultHeight?: number;
  /** Close the popup. */
  onClose: () => void;
  /** Persist an edited location back onto the entry (and the live editor if active). */
  onLocationChange: (id: string, location: LocationInfo) => void;
  /** Persist edited solar settings (cardinal orientation + study set) back onto the entry. */
  onSolarChange: (id: string, solar: SolarSettings) => void;
  /**
   * SHARED orbit camera for the entry. Controlled by the parent so this popup and
   * the entry's mini-window thumbnail stay in sync — rotating either rotates both.
   */
  camera: Camera;
  onCameraChange: (camera: Camera) => void;
  /** Bounds the popup is dragged within (the canvas stage in CSS px). */
  stageRef: React.RefObject<HTMLElement>;
  /** When true, plays the attention-flash animation (user clicked outside). */
  isFlashing?: boolean;
}

/** Resolve an entry's solar settings, inheriting a geocoded latitude/longitude when
 *  the entry has no explicit solar config yet (so the dome uses the best site data
 *  available before Mapbox writes a dedicated solar config). */
function resolveSettings(entry: SavedPerimeter): SolarSettings {
  if (entry.solar) return cloneSolarSettings(entry.solar);
  const base = defaultSolarSettings();
  if (typeof entry.location?.lat === "number") base.latitude = entry.location.lat;
  if (typeof entry.location?.lng === "number") base.longitude = entry.location.lng;
  return base;
}

export default function SolarStudy({ entry, defaultHeight, onClose, onLocationChange, onSolarChange, camera, onCameraChange, stageRef, isFlashing }: SolarStudyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  // Position: null means "centred by CSS"; once dragged we switch to explicit px.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);

  // SOLAR settings (cardinal orientation + studied date/time + site). Seeded from the
  // entry and re-seeded only when a DIFFERENT entry's study opens (not on our own
  // writes, which would fight the controls). Each edit persists via onSolarChange.
  const [settings, setSettings] = useState<SolarSettings>(() => resolveSettings(entry));
  useEffect(() => {
    setSettings(resolveSettings(entry));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);
  const update = (patch: Partial<SolarSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      onSolarChange(entry.id, next);
      return next;
    });
  };

  // Drag-to-rotate uses the SHARED camera (prop) so the thumbnail mirrors it.
  const rotRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);
  // Aerial (plan) view toggle: double-clicking the massing animates the SHARED
  // camera between the 3/4 view and a top-down plan — same gesture the mini-window
  // thumbnail uses. `planView` tracks INTENT so the double-click reliably toggles.
  const [planView, setPlanView] = useState(false);
  const animRef = useRef<number | null>(null);
  const cancelAnim = () => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  };
  // Animate the shared camera to `target` over PLAN_ANIM_MS, azimuth along the
  // shortest path, driving the parent each frame so the popup AND the thumbnail
  // both rotate to the aerial view together.
  const animateCameraTo = (target: Camera) => {
    cancelAnim();
    const startAz = camera.azimuth;
    const startEl = camera.elevation;
    const dAz = shortestAngleDelta(startAz, target.azimuth);
    const dEl = target.elevation - startEl;
    const t0 = performance.now();
    const step = (now: number) => {
      const e = easeInOut(Math.min(1, (now - t0) / PLAN_ANIM_MS));
      onCameraChange({ azimuth: startAz + dAz * e, elevation: startEl + dEl * e });
      animRef.current = e < 1 ? requestAnimationFrame(step) : null;
    };
    animRef.current = requestAnimationFrame(step);
  };
  // Double-click toggles aerial (top-down) ↔ the default 3/4 massing.
  const onCanvasDoubleClick = () => {
    const next = !planView;
    setPlanView(next);
    animateCameraTo(next ? PLAN_CAMERA : DEFAULT_CAMERA);
  };
  // Stop any in-flight tween on unmount.
  useEffect(() => cancelAnim, []);

  // Address draft, INHERITED from the entry's stored location on open and whenever
  // the entry's address changes underneath us (e.g. edited in the left panel).
  const [address, setAddress] = useState(entry.location?.address ?? "");
  useEffect(() => {
    setAddress(entry.location?.address ?? "");
  }, [entry.id, entry.location?.address]);

  // --- Title-bar drag to reposition (clamped to the stage) — mirrors MiniWindow. ---
  const onTitlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // ignore the close button
    const win = winRef.current;
    const stage = stageRef.current;
    if (!win || !stage) return;
    const winRect = win.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    dragRef.current = { offX: e.clientX - winRect.left, offY: e.clientY - winRect.top };
    // Seed explicit position from the current rendered spot so the first move
    // doesn't jump from the CSS-centred location.
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

  // --- Canvas drag to orbit the massing camera. ---
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    cancelAnim(); // a manual drag takes over from any in-flight plan animation
    rotRef.current = { x: e.clientX, y: e.clientY, az: camera.azimuth, el: camera.elevation };
  };
  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = rotRef.current;
    if (!r) return;
    const az = r.az + (e.clientX - r.x) * ROTATE_RAD_PER_PX;
    const el = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, r.el - (e.clientY - r.y) * ROTATE_RAD_PER_PX));
    onCameraChange({ azimuth: az, elevation: el });
  };
  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    rotRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // --- Compass dial: drag the needle to set the model's cardinal orientation. ---
  // The dial's ring is FIXED to the world (N at top); the needle shows the drawing's
  // +Y ("up"/forward) direction within that world compass. Its bearing CW from north
  // IS `northOffset`, so dragging the needle to a bearing sets northOffset directly.
  const compassRef = useRef<HTMLDivElement>(null);
  const compassDragRef = useRef(false);
  const setNorthFromPointer = (e: React.PointerEvent) => {
    const el = compassRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (dx === 0 && dy === 0) return;
    // atan2(dx, -dy): 0 at the top (north), increasing CLOCKWISE — matches bearings.
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    deg = (deg % 360 + 360) % 360;
    update({ northOffset: Math.round(deg) });
  };
  const onCompassPointerDown = (e: React.PointerEvent) => {
    compassDragRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setNorthFromPointer(e);
  };
  const onCompassPointerMove = (e: React.PointerEvent) => {
    if (compassDragRef.current) setNorthFromPointer(e);
  };
  const onCompassPointerUp = (e: React.PointerEvent) => {
    compassDragRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // Esc closes the popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Paint the larger massing + sun dome (DPR-aware), framed into the canvas by render3d.
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
    render3d(ctx, canvas, w, h, dpr, entry.perimeter, {
      marginPx: STUDY_MARGIN_PX,
      camera,
      height: entry.unravelHeight ?? defaultHeight ?? DEFAULT_WALL_HEIGHT_FT,
      heights: entry.unravelHeights,
      sunPath: { settings },
    });
  }, [entry.perimeter, entry.unravelHeight, entry.unravelHeights, defaultHeight, camera, settings]);

  const commitAddress = (value: string) => {
    setAddress(value);
    const prev = entry.location ?? emptyLocation();
    // Typing a new address invalidates any previously resolved coordinates; a future
    // geocoder repopulates them. Keep them as-is here (still null on a blank model).
    onLocationChange(entry.id, { ...prev, address: value });
  };

  // Live sun readout (real geometry) for the selected day + time.
  const sun = sunPosition(settings.latitude, settings.dayOfYear, settings.hour);
  const altDeg = Math.round((sun.altitude * 180) / Math.PI);
  const azDeg = ((Math.round((sun.azimuth * 180) / Math.PI)) % 360 + 360) % 360;

  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y, transform: "none" } : {};

  return (
    <div className={`solar${isFlashing ? " solar--flash" : ""}`} ref={winRef} style={style} role="dialog" aria-label="Solar Study">
      {/* ===== TITLE BAR (drag handle) ===== */}
      <div
        className="solar__titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <span className="solar__title">Solar Study</span>
        <button className="solar__close" onClick={onClose} title="Close" aria-label="Close">
          ×
        </button>
      </div>

      {/* ===== LARGER MASSING + SUN DOME (drag to orbit) ===== */}
      <div className="solar__body">
        <canvas
          ref={canvasRef}
          className="solar__canvas"
          title="Drag to rotate — double-click for an aerial (top-down) view"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onDoubleClick={onCanvasDoubleClick}
        />

        {/* ===== SOLAR CONTROLS (cardinal orientation + studied date/time + site) ===== */}
        <div className="solar__controls">
          {/* Cardinal orientation: a compass dial whose needle = the drawing's +Y. */}
          <div className="solar__control solar__control--compass">
            <div className="solar__control-label">Orientation</div>
            <div
              className="solar__compass"
              ref={compassRef}
              onPointerDown={onCompassPointerDown}
              onPointerMove={onCompassPointerMove}
              onPointerUp={onCompassPointerUp}
              title="Drag to set the drawing's North relative to the cardinal directions"
            >
              <span className="solar__compass-tick solar__compass-tick--n">N</span>
              <span className="solar__compass-tick solar__compass-tick--e">E</span>
              <span className="solar__compass-tick solar__compass-tick--s">S</span>
              <span className="solar__compass-tick solar__compass-tick--w">W</span>
              {/* Needle points along the drawing's +Y; its bearing CW = northOffset. */}
              <span
                className="solar__compass-needle"
                style={{ transform: `translate(-50%, -100%) rotate(${settings.northOffset}deg)` }}
              />
            </div>
            <div className="solar__field">
              <input
                className="solar__num"
                type="number"
                min={0}
                max={359}
                step={1}
                value={Math.round(settings.northOffset)}
                onChange={(e) => update({ northOffset: ((Number(e.target.value) % 360) + 360) % 360 })}
                title="North offset — bearing (° clockwise from true north) of the drawing's +Y axis"
              />
              <span className="solar__unit">° N-off</span>
            </div>
          </div>

          {/* Date + time sliders and the latitude/site fields. */}
          <div className="solar__control solar__control--sliders">
            <div className="solar__slider-row">
              <label className="solar__control-label" htmlFor="solar-date">Date</label>
              <input
                id="solar-date"
                className="solar__slider"
                type="range"
                min={1}
                max={365}
                step={1}
                value={Math.round(settings.dayOfYear)}
                onChange={(e) => update({ dayOfYear: Number(e.target.value) })}
              />
              <span className="solar__readout">{formatDayOfYear(settings.dayOfYear)}</span>
            </div>

            <div className="solar__slider-row">
              <label className="solar__control-label" htmlFor="solar-time">Solar time</label>
              <input
                id="solar-time"
                className="solar__slider"
                type="range"
                min={0}
                max={24}
                step={0.25}
                value={settings.hour}
                onChange={(e) => update({ hour: Number(e.target.value) })}
              />
              <span className="solar__readout">{formatHour(settings.hour)}</span>
            </div>

            <div className="solar__slider-row">
              <label className="solar__control-label" htmlFor="solar-lat">Latitude</label>
              <input
                id="solar-lat"
                className="solar__num solar__num--wide"
                type="number"
                min={-90}
                max={90}
                step={0.25}
                value={settings.latitude}
                onChange={(e) => update({ latitude: Math.max(-90, Math.min(90, Number(e.target.value))) })}
                title="Site latitude (° N) — defaults to Omaha, NE"
              />
              <span className="solar__readout solar__readout--muted" title="Site coordinates feeding the sun path">
                {settings.latitude >= 0 ? "N" : "S"} · sun {altDeg >= 0 ? `alt ${altDeg}° · az ${azDeg}°` : "below horizon"}
              </span>
            </div>
          </div>
        </div>

        {/* ===== LOCATION (inherits the entry's typed address; editable) ===== */}
        <div className="solar__location">
          <div className="solar__location-title">Location</div>
          <input
            className="solar__location-input"
            type="text"
            value={address}
            placeholder="Address (e.g. 123 Main St, City)"
            title="Address for the solar study — inherited from the sketch's location; edit to update it"
            onChange={(e) => commitAddress(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

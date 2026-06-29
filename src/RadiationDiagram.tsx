/**
 * RadiationDiagram.tsx
 *
 * The "Irradiance (W/m²)" statistics diagram — a Ladybug-style temporal heatmap of
 * clear-sky solar IRRADIANCE (instantaneous power, W/m²) on ONE wall border. Its
 * ENERGY companion is the monthly insolation chart (kWh/m², InsolationChart.tsx),
 * which shares the helpers + tokens exported here. Axes: HORIZONTAL = months of the
 * year (Jan→Dec), VERTICAL = hour of the day (midnight at the bottom → midnight at
 * the top, so the daylight bulge reads centred and widens in summer). Each cell is
 * coloured by the incident irradiance (W/m²) on that wall at that month/hour.
 *
 * It is purely a VIEW over a {@link RadiationMatrix} (built in core/radiation.ts from
 * the Solar Study settings + the wall's true compass orientation). It owns no physics.
 *
 * ALL visual tokens (cell size, axis/grid colour, the colour ramp stops) live in
 * styles.css under "ANNUAL RADIATION DIAGRAM" and are read here via CSS custom
 * properties, so the diagram restyles from that single file (per the project's
 * single-source-of-truth styling rule).
 */

import type { RadiationMatrix } from "./core/radiation";

/** Three-letter month abbreviations for the horizontal axis (shared with InsolationChart). */
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 8-point compass labels for the facing readout, indexed by round(bearing / 45). */
const COMPASS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** The 8-point cardinal label for a compass bearing (deg, 0 = N, CW). */
export function cardinal8(bearingDeg: number): string {
  const b = ((bearingDeg % 360) + 360) % 360;
  return COMPASS_8[Math.round(b / 45) % 8];
}

/** Format a 24-hour clock value as a 12-hour label, e.g. 0/24 → "12 AM", 13 → "1 PM". */
function formatHour12(h24: number): string {
  const h = ((h24 % 24) + 24) % 24; // 24 → 0
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${suffix}`;
}

/** An RGB triple parsed from a `#rrggbb` token. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parse a `#rrggbb` hex string into RGB; falls back to mid-grey on a bad value. */
export function parseHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 128, g: 128, b: 128 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Read a CSS custom property off :root, with a fallback if unset/blank. */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim() || fallback;
}

/** Read a numeric CSS custom property off :root (parseFloat), with a fallback. */
export function cssNum(name: string, fallback: number): number {
  const n = parseFloat(cssVar(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

/** Sample a multi-stop RGB ramp at t in [0,1], blending the bracketing stops. */
export function sampleRamp(stops: RGB[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a.r + (b.r - a.r) * f)}, ${Math.round(a.g + (b.g - a.g) * f)}, ${Math.round(
    a.b + (b.b - a.b) * f,
  )})`;
}

/**
 * Read the shared cold→hot thermal ramp (--radiation-stop-0..4) off :root. Both the
 * irradiance heatmap and the insolation chart sample this, so the two solar views
 * speak the SAME colour language from one set of tokens.
 */
export function readRamp(): RGB[] {
  return [
    parseHex(cssVar("--radiation-stop-0", "#1b2a6b")),
    parseHex(cssVar("--radiation-stop-1", "#1f7ae0")),
    parseHex(cssVar("--radiation-stop-2", "#21c3a6")),
    parseHex(cssVar("--radiation-stop-3", "#ffd60a")),
    parseHex(cssVar("--radiation-stop-4", "#ff2d1c")),
  ];
}

export interface RadiationDiagramProps {
  /** The annual radiation grid to draw (month × hour irradiance + scale extents). */
  matrix: RadiationMatrix;
}

/**
 * Render the annual radiation temporal map. Sizing + colours come from CSS tokens so
 * the whole diagram restyles from styles.css.
 */
export default function RadiationDiagram({ matrix }: RadiationDiagramProps) {
  const { hours, months, values, max, bearingDeg, annualTotal } = matrix;

  // Resolve sizing + ramp tokens from CSS on every render so edits to the
  // --radiation-* tokens (cell size, ramp) take effect immediately — including under
  // hot-reload, where the component does not remount. The reads are cheap and the
  // overlay only re-renders on viewport changes. Text COLOUR/FONT live entirely in CSS
  // (the __axis-label / __total classes) so the labels match the General readout from
  // one place.
  const tk = {
    cellW: cssNum("--radiation-cell-w", 75),
    cellH: cssNum("--radiation-cell-h", 18),
    stops: readRamp(),
  };

  // Gutters sized for the 12px mono labels. LEFT fits a "12 AM"/"12 PM" hour label so
  // the hour text can sit LEFT-ALIGNED at x = 0 — flush with the diagram's left edge
  // (the title and, in turn, the wall border) — with the grid beginning after it. TOP
  // clears the top "12 AM" label so it isn't clipped.
  const LEFT = 42; // gutter for the (left-aligned) 12-hour labels
  const BOTTOM = 18; // gutter for month labels
  const TOP = 9;
  // Colour-scale legend geometry (right gutter). The gradient bar carries the "W/m²"
  // unit below it and the max value at its top; LEGEND_BAR_W is the bar's width.
  const LEGEND_GAP = 14; // gap from the grid's right edge to the legend bar
  const LEGEND_BAR_W = 13.5; // legend bar width (24 px base × 0.75², to match the diagram's ~56% scale)
  const LEGEND_LABEL_GAP = 6; // gap from the bar to its max/0 number labels
  const LEGEND_LABEL_W = 36; // room reserved for the right-side labels (max value · "W/m²" unit)
  const RIGHT = LEGEND_GAP + LEGEND_BAR_W + LEGEND_LABEL_GAP + LEGEND_LABEL_W; // right gutter
  const gridW = months * tk.cellW;
  const gridH = hours * tk.cellH;
  const W = LEFT + gridW + RIGHT;
  const H = TOP + gridH + BOTTOM;

  // Scale denominator (guard the all-zero / flat case so t stays finite).
  const span = max > 1e-6 ? max : 1;

  // Hour-axis ticks every 6 h (0 at the bottom, 24 at the top).
  const HOUR_TICKS = [0, 6, 12, 18, 24];

  // Legend gradient id — static (one diagram visible at a time).
  const gradId = "radiation-legend-grad";

  return (
    <div className="radiation-diagram">
      {/* Title matches the General overlay's heading exactly (stats-dropdown__title:
          all-caps, dim, same margin below) so the two statistics read consistently. */}
      <div className="stats-dropdown__title">Irradiance (W/m²)</div>
      <svg
        className="radiation-diagram__svg"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Annual clear-sky radiation on the ${cardinal8(bearingDeg)}-facing wall, by month and hour`}
      >
        <defs>
          {/* Bottom (0) = cool, top (1) = warm, so it reads alongside the vertical axis. */}
          <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
            {tk.stops.map((s, i) => (
              <stop
                key={i}
                offset={`${(i / (tk.stops.length - 1)) * 100}%`}
                stopColor={`rgb(${s.r}, ${s.g}, ${s.b})`}
              />
            ))}
          </linearGradient>
        </defs>

        {/* CELLS — one rect per (month, hour). Hour 0 at the BOTTOM row. */}
        {values.map((row, h) =>
          row.map((val, m) => (
            <rect
              key={`${h}-${m}`}
              className="radiation-diagram__cell"
              x={LEFT + m * tk.cellW}
              y={TOP + (hours - 1 - h) * tk.cellH}
              width={tk.cellW}
              height={tk.cellH}
              fill={sampleRamp(tk.stops, val / span)}
            />
          )),
        )}

        {/* Hour-axis labels — 12-hour AM/PM, LEFT-ALIGNED at x = 0 so they sit flush
            with the diagram's left edge (the wall border); top→bottom reads
            12 AM · 6 PM · 12 PM · 6 AM · 12 AM. Grid starts at LEFT. */}
        {HOUR_TICKS.map((hr) => {
          const y = TOP + (1 - hr / hours) * gridH;
          return (
            <text key={hr} className="radiation-diagram__axis-label" x={0} y={y} textAnchor="start" dominantBaseline="middle">
              {formatHour12(hr)}
            </text>
          );
        })}

        {/* Month-axis labels (bottom gutter): 3-letter abbreviation centred per column. */}
        {MONTH_ABBR.map((mi, m) => (
          <text
            key={m}
            className="radiation-diagram__axis-label"
            x={LEFT + (m + 0.5) * tk.cellW}
            y={TOP + gridH + BOTTOM - 4}
            textAnchor="middle"
          >
            {mi}
          </text>
        ))}

        {/* Colour-scale legend (right gutter): gradient bar, with the "W/m²" unit at the
            TOP and the max value just beneath it; 0 sits at the bar's bottom. */}
        <rect
          className="radiation-diagram__legend"
          x={LEFT + gridW + LEGEND_GAP}
          y={TOP}
          width={LEGEND_BAR_W}
          height={gridH}
          fill={`url(#${gradId})`}
        />
        <text
          className="radiation-diagram__axis-unit"
          x={LEFT + gridW + LEGEND_GAP + LEGEND_BAR_W + LEGEND_LABEL_GAP}
          y={TOP}
          dominantBaseline="hanging"
        >
          W/m²
        </text>
        <text
          className="radiation-diagram__axis-label"
          x={LEFT + gridW + LEGEND_GAP + LEGEND_BAR_W + LEGEND_LABEL_GAP}
          y={TOP + 16}
          dominantBaseline="hanging"
        >
          {Math.round(max)}
        </text>
        <text
          className="radiation-diagram__axis-label"
          x={LEFT + gridW + LEGEND_GAP + LEGEND_BAR_W + LEGEND_LABEL_GAP}
          y={TOP + gridH}
          dominantBaseline="middle"
        >
          0
        </text>
      </svg>
      <div className="radiation-diagram__total">
        {cardinal8(bearingDeg)}-facing · {Math.round(bearingDeg)}° ·{" "}
        {annualTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} kWh/m²·yr
      </div>
    </div>
  );
}

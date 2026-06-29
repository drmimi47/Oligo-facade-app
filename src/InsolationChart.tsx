/**
 * InsolationChart.tsx
 *
 * The "Insolation (kWh/m²)" statistics diagram — the ENERGY companion to the
 * irradiance heatmap (RadiationDiagram.tsx). Where the heatmap shows instantaneous
 * IRRADIANCE (W/m², a rate) cell by cell, this chart shows monthly INSOLATION: the
 * clear-sky solar energy (kWh/m²) the wall receives in each month of the year — the
 * standard monthly-radiation bar chart facade/solar tools (Ladybug, PVsyst, SAM) use
 * to read seasonal yield at a glance.
 *
 * It is purely a VIEW over a {@link RadiationMatrix}.monthlyTotals (built in
 * core/radiation.ts). It owns no physics, and deliberately REUSES the irradiance
 * diagram's style helpers, fonts, and colour ramp (imported from RadiationDiagram)
 * so the two solar views read identically from one set of styles.css tokens:
 *   - Month columns share --radiation-cell-w, so months line up with the heatmap.
 *   - Bars are coloured on the SAME cold→hot ramp (--radiation-stop-0..4), so a tall
 *     warm bar reads as "high radiation" exactly like a warm heatmap cell.
 *   - Axis / footer TEXT uses the shared radiation-diagram label classes.
 * Chart-specific geometry (plot height, bar gap, gridlines) lives under "MONTHLY
 * INSOLATION CHART" in styles.css.
 */

import type { RadiationMatrix } from "./core/radiation";
import { MONTH_ABBR, cardinal8, cssNum, readRamp, sampleRamp } from "./RadiationDiagram";

/**
 * Round a value UP to a "nice" axis maximum (1, 2, 5 × power of ten), so the y-axis
 * tops out at a clean number with evenly-readable gridline labels.
 */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * mag;
}

export interface InsolationChartProps {
  /** The annual radiation grid; only monthlyTotals + facing/total are read here. */
  matrix: RadiationMatrix;
}

/**
 * Render the monthly insolation bar chart. Sizing + colours come from the shared
 * --radiation-* tokens (plus a few --insolation-* tokens) so it restyles from
 * styles.css alongside the heatmap.
 */
export default function InsolationChart({ matrix }: InsolationChartProps) {
  const { months, monthlyTotals, bearingDeg, annualTotal } = matrix;

  // Geometry from CSS. Column width is SHARED with the heatmap (--radiation-cell-w) so
  // the months line up when toggling between the two views; the plot height and the
  // per-column bar gap are chart-specific tokens.
  const colW = cssNum("--radiation-cell-w", 75);
  const plotH = cssNum("--insolation-plot-h", 160);
  const barGap = cssNum("--insolation-bar-gap", 6); // total horizontal inset → bar width = colW − barGap
  const stops = readRamp();

  // Gutters mirror the heatmap's so the two diagrams align: LEFT fits the y-axis value
  // labels (left-aligned at x = 0, flush with the title/wall border), BOTTOM the month
  // labels, TOP a single "kWh/m²" unit line, RIGHT a small breathing margin.
  const LEFT = 42;
  const BOTTOM = 18;
  const TOP = 16;
  const RIGHT = 12;
  const gridW = months * colW;
  const gridH = plotH;
  const W = LEFT + gridW + RIGHT;
  const H = TOP + gridH + BOTTOM;

  // Largest month sets both the colour scale (relative, like the heatmap) and the axis.
  const maxVal = monthlyTotals.reduce((a, b) => Math.max(a, b), 0);
  const span = maxVal > 1e-6 ? maxVal : 1;
  const axisMax = niceCeil(maxVal);

  // Five evenly-spaced y gridlines/labels (0 … axisMax), bottom-up.
  const TICK_COUNT = 4; // → 5 lines including 0
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => (axisMax * i) / TICK_COUNT);

  return (
    <div className="insolation-chart">
      {/* Title matches the irradiance heatmap + General overlay headings exactly. */}
      <div className="stats-dropdown__title">Insolation (kWh/m²)</div>
      <svg
        className="insolation-chart__svg"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Monthly clear-sky insolation on the ${cardinal8(bearingDeg)}-facing wall, kilowatt-hours per square metre`}
      >
        {/* Y-axis unit, top-left above the highest gridline. */}
        <text className="radiation-diagram__axis-unit" x={0} y={0} dominantBaseline="hanging">
          kWh/m²
        </text>

        {/* Horizontal gridlines + value labels (0 at the bottom, axisMax at the top). */}
        {ticks.map((t, i) => {
          const y = TOP + gridH - (t / axisMax) * gridH;
          return (
            <g key={i}>
              <line className="insolation-chart__grid" x1={LEFT} y1={y} x2={LEFT + gridW} y2={y} />
              <text className="radiation-diagram__axis-label" x={0} y={y} textAnchor="start" dominantBaseline="middle">
                {Math.round(t)}
              </text>
            </g>
          );
        })}

        {/* One bar per month, coloured on the shared thermal ramp by relative magnitude. */}
        {monthlyTotals.map((val, m) => {
          const h = (val / axisMax) * gridH;
          const x = LEFT + m * colW + barGap / 2;
          const y = TOP + gridH - h;
          return (
            <rect
              key={m}
              className="insolation-chart__bar"
              x={x}
              y={y}
              width={colW - barGap}
              height={Math.max(0, h)}
              fill={sampleRamp(stops, val / span)}
            />
          );
        })}

        {/* Month-axis labels (bottom gutter): 3-letter abbreviation centred per column. */}
        {MONTH_ABBR.map((mi, m) => (
          <text
            key={m}
            className="radiation-diagram__axis-label"
            x={LEFT + (m + 0.5) * colW}
            y={TOP + gridH + BOTTOM - 4}
            textAnchor="middle"
          >
            {mi}
          </text>
        ))}
      </svg>
      <div className="radiation-diagram__total">
        {cardinal8(bearingDeg)}-facing · {Math.round(bearingDeg)}° ·{" "}
        {annualTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} kWh/m²·yr
      </div>
    </div>
  );
}

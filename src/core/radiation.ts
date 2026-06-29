/**
 * core/radiation.ts
 *
 * ANNUAL SURFACE RADIATION for a vertical facade (the "Irradiance (W/m²)" heatmap and
 * the "Insolation (kWh/m²)" monthly chart, which share this one matrix). Builds a
 * Ladybug-style temporal map: for each MONTH of the year and each
 * HOUR of the day, the clear-sky solar irradiance (W/m²) landing on ONE wall border,
 * given that wall's true compass orientation and the sketch's Solar Study settings
 * (latitude, day/season, north offset).
 *
 * WHY hand-written (per the working agreement): the codebase is deliberately
 * dependency-free and reuses the existing {@link sunPosition} astronomy from
 * core/solar.ts. The only addition here is a standard, well-documented CLEAR-SKY
 * irradiance model (Hottel's transmittance + an isotropic-sky diffuse split), ~60
 * lines of textbook physics — far less than pulling in a radiation library, and it
 * keeps the SAME orientation source of truth (compass bearings) the rest of the app
 * already uses. PURE DATA/MATH — no DOM, no React, no canvas.
 *
 * What's REAL here (so the diagram is data, not decoration):
 *   - Sun altitude/azimuth from the shared spherical-astronomy model (core/solar.ts).
 *   - Beam irradiance via Hottel's clear-sky transmittance (a function of solar
 *     zenith + site altitude), scaled by the day's extraterrestrial normal flux.
 *   - Diffuse (sky) irradiance via Liu–Jordan's transmittance correlation, deposited
 *     on the vertical wall isotropically, plus a small ground-reflected term.
 *   - The wall's INCIDENCE: only the component of the beam facing the wall counts, so
 *     a west wall lights up in the afternoon and a north wall stays cool — driven by
 *     the wall's true compass bearing (its outward normal), exactly like the
 *     Orientation Heatmap.
 *
 * What is SIMPLIFIED (and shares core/solar.ts's roadmap to Mapbox accuracy):
 *   - CLEAR-SKY only: no clouds/weather file (no EPW yet). Values are a clear-day
 *     upper envelope, consistent month-to-month, which is what the comparative
 *     diagram needs. A later step can swap in measured TMY/EPW data behind the same
 *     {@link RadiationMatrix} shape without touching the UI.
 *   - `hour` is LOCAL APPARENT SOLAR TIME (solar noon = 12:00), matching core/solar.ts.
 */

import { sunPosition, wallIncidenceCos, type SolarSettings } from "./solar";

/** Solar constant — mean extraterrestrial normal irradiance (W/m²). */
const SOLAR_CONSTANT = 1367;

/**
 * Site elevation used by Hottel's transmittance, in KILOMETRES. Omaha (the interim
 * default site) sits at ~0.3 km; until Mapbox supplies a real elevation this constant
 * stands in. Higher sites get a clearer atmosphere (more beam), so this is wired as a
 * single tunable rather than buried in the formula.
 */
const SITE_ALTITUDE_KM = 0.3;

/** Ground reflectance (albedo) for the ground-reflected diffuse term. 0.2 ≈ grass/soil. */
const GROUND_ALBEDO = 0.2;

/**
 * Klein's RECOMMENDED AVERAGE DAY of each month (day-of-year whose declination best
 * represents the month's mean) — the standard choice for monthly solar averages, so
 * each column of the diagram is a physically representative day, not just "the 15th".
 * Index 0 = January.
 */
export const MONTH_REPRESENTATIVE_DOY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344];

/** Days in each month (non-leap), used to scale a representative day up to a monthly total. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Extraterrestrial normal irradiance for a day of year (W/m²) — the solar constant
 * modulated by Earth's slightly elliptical orbit.
 */
function extraterrestrialNormal(dayOfYear: number): number {
  return SOLAR_CONSTANT * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365));
}

/**
 * Hottel's clear-sky BEAM transmittance for a 23 km-visibility atmosphere at solar
 * zenith angle `zenith` (radians) and site altitude `altKm`. Returns the fraction of
 * the extraterrestrial normal beam that reaches the ground (0 when the sun is at/below
 * the horizon). Standard mid-latitude-summer climate correction factors are applied.
 */
function hottelBeamTransmittance(zenith: number, altKm: number): number {
  const cosZ = Math.cos(zenith);
  if (cosZ <= 1e-4) return 0; // sun on/below the horizon
  const a0s = 0.4237 - 0.00821 * (6 - altKm) ** 2;
  const a1s = 0.5055 + 0.00595 * (6.5 - altKm) ** 2;
  const ks = 0.2711 + 0.01858 * (2.5 - altKm) ** 2;
  // Mid-latitude summer climate correction (Hottel): nudges the standard atmosphere
  // toward the typical clear-sky condition at these latitudes.
  const r0 = 0.97;
  const r1 = 0.99;
  const rk = 1.02;
  const tau = r0 * a0s + r1 * a1s * Math.exp((-rk * ks) / cosZ);
  return Math.max(0, tau);
}

/**
 * Irradiance landing on ONE vertical wall at a single instant.
 *   - `wallBearingDeg`: the wall's outward-normal compass bearing (deg, 0 = N, CW) —
 *     the same per-face bearing the Orientation Heatmap uses.
 * Returns the total incident irradiance (W/m²): beam (only when the sun faces the
 * wall) + isotropic sky diffuse + ground-reflected. Zero at night.
 */
export function wallIrradiance(
  settings: SolarSettings,
  wallBearingDeg: number,
  dayOfYear: number,
  hour: number,
): number {
  const pos = sunPosition(settings.latitude, dayOfYear, hour);
  if (pos.altitude <= 0) return 0; // sun below horizon → no radiation

  const zenith = Math.PI / 2 - pos.altitude;
  const cosZ = Math.cos(zenith); // = sin(altitude)
  const gon = extraterrestrialNormal(dayOfYear);

  const tauB = hottelBeamTransmittance(zenith, SITE_ALTITUDE_KM);
  const dni = gon * tauB; // direct normal irradiance (W/m²)

  // Liu–Jordan diffuse transmittance correlation → diffuse horizontal irradiance.
  const tauD = 0.271 - 0.294 * tauB;
  const dhi = gon * cosZ * Math.max(0, tauD);

  // Global horizontal (for the ground-reflected term).
  const ghi = dni * cosZ + dhi;

  // BEAM on the wall: cosθ for a VERTICAL surface (the shared incidence projection,
  // also driving the Orientation Heatmap's live direct-sun readout).
  const cosInc = wallIncidenceCos(pos, wallBearingDeg);
  const beam = cosInc > 0 ? dni * cosInc : 0; // sun behind the wall → no beam

  // Vertical surface view factors: sky = (1+cos90)/2 = 0.5, ground = (1−cos90)/2 = 0.5.
  const diffuseSky = dhi * 0.5;
  const reflected = ghi * GROUND_ALBEDO * 0.5;

  return beam + diffuseSky + reflected;
}

/** A month × hour grid of wall irradiance, with the scale extents + an annual total. */
export interface RadiationMatrix {
  /** Number of hour rows (24 — one per hour of the day). */
  hours: number;
  /** Number of month columns (12). */
  months: number;
  /**
   * Incident irradiance in W/m², indexed `values[hour][month]` with hour 0..23
   * sampled at the hour's midpoint (solar time). Row 0 = 00:00–01:00, row 23 = 23:00–24:00.
   */
  values: number[][];
  /** Largest cell value (W/m²) — the warm end of the colour scale. */
  max: number;
  /** Smallest cell value (W/m²) — the cool end of the colour scale (≥ 0). */
  min: number;
  /**
   * Per-MONTH incident insolation on the wall (kWh/m²), `monthlyTotals[month]` with
   * month 0 = January. The ENERGY companion to {@link values}: each entry is that
   * month's representative-day total scaled by the days in the month. Summed, these
   * equal {@link annualTotal} — they drive the monthly insolation chart.
   */
  monthlyTotals: number[];
  /** Cumulative annual incident radiation on the wall (kWh/m²·yr), clear-sky. */
  annualTotal: number;
  /** The wall's outward-normal compass bearing this matrix was built for (deg, 0 = N, CW). */
  bearingDeg: number;
}

/**
 * Build the annual radiation matrix for one wall border. Samples every hour of each
 * month's representative day at the wall's orientation, then scales the daily totals
 * by the days in each month for a real annual kWh/m²·yr figure.
 */
export function buildRadiationMatrix(settings: SolarSettings, wallBearingDeg: number): RadiationMatrix {
  const HOURS = 24;
  const MONTHS = 12;
  const values: number[][] = Array.from({ length: HOURS }, () => new Array<number>(MONTHS).fill(0));
  const monthlyTotals = new Array<number>(MONTHS).fill(0);
  let max = 0;
  let annualWh = 0; // Wh/m² accumulated over the whole year (per representative-day scaling)

  for (let m = 0; m < MONTHS; m++) {
    const doy = MONTH_REPRESENTATIVE_DOY[m];
    let dayWh = 0; // Wh/m² for this representative day (1 h steps → W/m² ≈ Wh/m²)
    for (let h = 0; h < HOURS; h++) {
      const irr = wallIrradiance(settings, wallBearingDeg, doy, h + 0.5);
      values[h][m] = irr;
      if (irr > max) max = irr;
      dayWh += irr; // each row spans one hour
    }
    const monthWh = dayWh * DAYS_IN_MONTH[m]; // scale the representative day to the month
    monthlyTotals[m] = monthWh / 1000; // Wh → kWh : this month's incident insolation
    annualWh += monthWh;
  }

  return {
    hours: HOURS,
    months: MONTHS,
    values,
    max,
    min: 0,
    monthlyTotals,
    annualTotal: annualWh / 1000, // Wh → kWh
    bearingDeg: ((wallBearingDeg % 360) + 360) % 360,
  };
}

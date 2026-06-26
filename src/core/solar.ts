/**
 * core/solar.ts
 *
 * Hand-written, dependency-free SOLAR GEOMETRY for the Solar Study.
 *
 * WHY hand-written (per the working agreement): the codebase is deliberately
 * dependency-free and the math here is small and standard (a few trig identities),
 * so pulling in a solar library (SunCalc, etc.) would add a dependency for ~40
 * lines of well-known astronomy. Keeping it here also means the SAME module can
 * later be upgraded for Mapbox-accurate results (real latitude/longitude + a
 * timezone + the equation of time to convert clock time ↔ solar time) WITHOUT
 * touching the renderer or UI — they consume the pure functions below.
 *
 * This module is PURE DATA/MATH — no DOM, no React, no canvas.
 *
 * What's REAL here (so the study offers real data, not decoration):
 *   - Solar DECLINATION via Cooper's equation (a function of the day of year).
 *   - Solar ALTITUDE and AZIMUTH from latitude + declination + hour angle, the
 *     standard spherical-astronomy equations. Azimuth is measured FROM NORTH,
 *     CLOCKWISE (0 = N, 90 = E, 180 = S, 270 = W) — the surveyor/compass
 *     convention — so it composes directly with a building's cardinal orientation.
 *
 * What is SIMPLIFIED for now (and flagged for the Mapbox-accuracy stage):
 *   - `hour` is treated as LOCAL APPARENT SOLAR TIME (solar noon = 12:00), NOT
 *     wall-clock time. Converting clock time → solar time needs the site's
 *     longitude, its timezone meridian, and the equation of time. Longitude is
 *     already carried in {@link SolarSettings} (defaulted to Omaha) so that upgrade
 *     is a localized change here. Until then the UI labels the control "solar time".
 *
 * Orientation model (the data the rest of the app will build cardinal facades on):
 *   - The drawn perimeter lives in model space with +X = EAST, +Y = NORTH, +Z = UP
 *     (matching core/extrude3d.ts). `northOffset` ROTATES true north relative to
 *     that model: it is the compass bearing (degrees clockwise from true north) of
 *     the model's +Y axis. northOffset = 0 means model +Y already points true north.
 *     Encoding it per saved sketch lets a later step derive each FACADE's cardinal
 *     orientation (its outward-normal bearing) and pair it with the sun positions
 *     computed here.
 */

/** A point/vector in 3D model space (X east, Y north, Z up). Mirrors extrude3d's Vec3. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The persisted solar-study configuration for a sketch. Carried on a SavedPerimeter
 * so the cardinal orientation + study set are remembered (and, later, drive per-facade
 * orientation). All angular fields are in DEGREES; `hour` is decimal hours of solar time.
 */
export interface SolarSettings {
  /** Compass bearing (deg, CW from true north) of the model's +Y axis. 0 = +Y is north. */
  northOffset: number;
  /** Site latitude (deg, +N). Until Mapbox geocoding fills it, defaults to Omaha. */
  latitude: number;
  /** Site longitude (deg, +E / −W). Reserved for Mapbox-accurate solar↔clock time. */
  longitude: number;
  /** Day of the year, 1..365 (selects the declination / season). */
  dayOfYear: number;
  /** Local apparent SOLAR time, 0..24 (12 = solar noon). */
  hour: number;
}

/**
 * Temporary site coordinates until the planned Mapbox geocoder supplies real ones
 * from the typed address — chosen here as Omaha, Nebraska (per the project's
 * interim default). Used as the latitude/longitude default in {@link defaultSolarSettings}.
 */
export const OMAHA = { latitude: 41.2565, longitude: -95.9345 };

/** Day-of-year of the reference seasons (non-leap year), used for the guide arcs. */
export const SEASON_DAYS = {
  /** ~Mar 20 — vernal equinox. */
  equinox: 80,
  /** ~Jun 21 — summer solstice (highest sun path, N hemisphere). */
  summer: 172,
  /** ~Dec 21 — winter solstice (lowest sun path, N hemisphere). */
  winter: 355,
} as const;

/** A fresh default solar configuration (north un-rotated, Omaha, summer solstice, noon). */
export function defaultSolarSettings(): SolarSettings {
  return {
    northOffset: 0,
    latitude: OMAHA.latitude,
    longitude: OMAHA.longitude,
    dayOfYear: SEASON_DAYS.summer,
    hour: 12,
  };
}

/** Deep-copy solar settings so a stored snapshot is detached from live state. */
export function cloneSolarSettings(s: SolarSettings): SolarSettings {
  return {
    northOffset: s.northOffset,
    latitude: s.latitude,
    longitude: s.longitude,
    dayOfYear: s.dayOfYear,
    hour: s.hour,
  };
}

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Solar declination (radians) for a day of the year — Cooper's equation. */
export function declination(dayOfYear: number): number {
  return 23.45 * DEG * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
}

/** A sun position in the sky: altitude above the horizon and azimuth from north (CW), radians. */
export interface SunPosition {
  /** Angle above the horizon (radians). Negative = below the horizon (night). */
  altitude: number;
  /** Compass bearing of the sun (radians, 0 = N, +CW through E). */
  azimuth: number;
}

/**
 * Compute the sun's altitude + azimuth for a latitude, day of year, and SOLAR hour.
 * Standard spherical-astronomy formulas; azimuth is returned FROM NORTH, CLOCKWISE.
 */
export function sunPosition(latitudeDeg: number, dayOfYear: number, hour: number): SunPosition {
  const lat = latitudeDeg * DEG;
  const dec = declination(dayOfYear);
  // Hour angle: 15°/hour, zero at solar noon, positive in the afternoon.
  const H = 15 * (hour - 12) * DEG;

  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const altitude = Math.asin(clamp(sinAlt, -1, 1));
  const cosAlt = Math.cos(altitude);

  let azimuth: number;
  if (cosAlt < 1e-6 || Math.abs(Math.cos(lat)) < 1e-6) {
    // Sun at the zenith or an observer at a pole: azimuth is undefined — pick north.
    azimuth = 0;
  } else {
    const cosAz = clamp((Math.sin(dec) - sinAlt * Math.sin(lat)) / (cosAlt * Math.cos(lat)), -1, 1);
    const az0 = Math.acos(cosAz); // 0..π, measured from north toward south
    // acos can't tell morning from afternoon; the hour angle does. Afternoon
    // (H > 0) → sun in the western half, so reflect across the N–S meridian.
    azimuth = H > 0 ? 2 * Math.PI - az0 : az0;
  }
  return { altitude, azimuth };
}

/**
 * Convert a sky position into a UNIT direction vector in MODEL space, accounting for
 * the sketch's `northOffset`. Multiply by a dome radius and add the dome centre to
 * place a point on the sun dome. (Model: +X east, +Y north, +Z up.)
 *
 * Rotating the model's north by θ shifts the sun's APPARENT azimuth (relative to the
 * model) by −θ, so the horizontal direction is simply (sin(az−θ), cos(az−θ)).
 */
export function sunDirectionModel(pos: SunPosition, northOffsetDeg: number): V3 {
  const a = pos.azimuth - northOffsetDeg * DEG;
  const ca = Math.cos(pos.altitude);
  return { x: ca * Math.sin(a), y: ca * Math.cos(a), z: Math.sin(pos.altitude) };
}

/**
 * Horizontal MODEL-space unit direction (z = 0) for a true-compass bearing, given the
 * sketch's `northOffset`. Used to place the N/E/S/W markers of the compass rose.
 */
export function bearingToModelDir(bearingDeg: number, northOffsetDeg: number): { x: number; y: number } {
  const a = (bearingDeg - northOffsetDeg) * DEG;
  return { x: Math.sin(a), y: Math.cos(a) };
}

// ---------------------------------------------------------------------------
// DATE HELPERS (day-of-year ↔ month/day, plus display formatting)
// ---------------------------------------------------------------------------

/** Cumulative days BEFORE each month (non-leap year); index 0 = January. */
const MONTH_CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Convert a 1..365 day-of-year into {month: 1..12, day: 1..31}. */
export function dayOfYearToDate(dayOfYear: number): { month: number; day: number } {
  const doy = clamp(Math.round(dayOfYear), 1, 365);
  let m = 11;
  while (m > 0 && doy <= MONTH_CUM[m]) m--;
  return { month: m + 1, day: doy - MONTH_CUM[m] };
}

/** Format a day-of-year as e.g. "Jun 21". */
export function formatDayOfYear(dayOfYear: number): string {
  const { month, day } = dayOfYearToDate(dayOfYear);
  return `${MONTH_ABBR[month - 1]} ${day}`;
}

/** Format a decimal solar hour as "HH:MM" (24-hour). */
export function formatHour(hour: number): string {
  const h = clamp(hour, 0, 24);
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    mm = 0;
    hh += 1;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// SUN-PATH GEOMETRY: build the dome / arcs / compass as MODEL-space 3D points.
//
// Pure geometry so the renderer (core/extrude3d.ts) only has to PROJECT and DRAW
// it in the same camera as the massing. Centre + radius are supplied by the caller
// (derived from the massing footprint) so the dome frames the building.
// ---------------------------------------------------------------------------

/** A labelled sun-path arc (a single day's above-horizon path) as model points. */
export interface SunArc {
  /** Which guide this arc is, so the renderer can style/label it. */
  key: "summer" | "equinox" | "winter" | "active";
  /** Short label (e.g. "Jun 21"). */
  label: string;
  /** Polyline of model-space points along the path (above the horizon only). */
  points: V3[];
}

/** An hour marker dotted onto an arc, optionally text-labelled with the hour. */
export interface HourMark {
  point: V3;
  hour: number;
  /** Whether to draw the numeric hour label next to the dot (kept sparse for legibility). */
  label: boolean;
}

/** A cardinal-direction marker for the compass rose. */
export interface CardinalMark {
  label: "N" | "E" | "S" | "W";
  /** Horizontal model-space unit direction (z = 0) the label sits along. */
  dir: { x: number; y: number };
}

/** Everything needed to draw the sun dome, in model space, around a given centre. */
export interface SunPathGeometry {
  center: V3;
  radius: number;
  /** Circle of points at z = 0 (the horizon ring of the dome). */
  groundRing: V3[];
  /** N/E/S/W markers (directions; the renderer scales by radius + places labels). */
  cardinals: CardinalMark[];
  /** Reference season arcs + the currently-selected day's arc (key "active"). */
  arcs: SunArc[];
  /** Integer-hour dots along the arcs (a sparse subset labelled). */
  hourMarks: HourMark[];
  /** The sun for the selected day + hour. */
  sun: { point: V3; visible: boolean; position: SunPosition };
}

/** Sample one day's above-horizon sun path into a model-space polyline. */
function buildArc(center: V3, radius: number, settings: SolarSettings, dayOfYear: number): V3[] {
  const pts: V3[] = [];
  for (let h = 0; h <= 24 + 1e-9; h += 0.2) {
    const pos = sunPosition(settings.latitude, dayOfYear, h);
    if (pos.altitude <= 0) continue; // below the horizon: not part of the visible dome
    const d = sunDirectionModel(pos, settings.northOffset);
    pts.push({ x: center.x + d.x * radius, y: center.y + d.y * radius, z: center.z + d.z * radius });
  }
  return pts;
}

/**
 * Build the full sun-path geometry (dome ring, compass, season + active arcs, hour
 * marks, and the current sun) in model space around `center` at `radius`, for the
 * given settings.
 */
export function buildSunPathGeometry(center: V3, radius: number, settings: SolarSettings): SunPathGeometry {
  // Horizon ring at the dome base.
  const groundRing: V3[] = [];
  const RING_STEPS = 64;
  for (let i = 0; i <= RING_STEPS; i++) {
    const a = (i / RING_STEPS) * 2 * Math.PI;
    groundRing.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius, z: center.z });
  }

  const cardinals: CardinalMark[] = ([
    ["N", 0],
    ["E", 90],
    ["S", 180],
    ["W", 270],
  ] as const).map(([label, bearing]) => ({ label, dir: bearingToModelDir(bearing, settings.northOffset) }));

  // Guide arcs for the three reference days, plus the live selected-day arc on top.
  const arcs: SunArc[] = [
    { key: "summer", label: formatDayOfYear(SEASON_DAYS.summer), points: buildArc(center, radius, settings, SEASON_DAYS.summer) },
    { key: "equinox", label: formatDayOfYear(SEASON_DAYS.equinox), points: buildArc(center, radius, settings, SEASON_DAYS.equinox) },
    { key: "winter", label: formatDayOfYear(SEASON_DAYS.winter), points: buildArc(center, radius, settings, SEASON_DAYS.winter) },
    { key: "active", label: formatDayOfYear(settings.dayOfYear), points: buildArc(center, radius, settings, settings.dayOfYear) },
  ];

  // Integer-hour dots: on each season arc place a dot at every whole hour the sun is
  // up; label only the summer arc at every 3rd hour so the diagram stays legible.
  const hourMarks: HourMark[] = [];
  for (const day of [SEASON_DAYS.summer, SEASON_DAYS.equinox, SEASON_DAYS.winter]) {
    const labelThis = day === SEASON_DAYS.summer;
    for (let h = 0; h <= 24; h++) {
      const pos = sunPosition(settings.latitude, day, h);
      if (pos.altitude <= 0) continue;
      const d = sunDirectionModel(pos, settings.northOffset);
      hourMarks.push({
        point: { x: center.x + d.x * radius, y: center.y + d.y * radius, z: center.z + d.z * radius },
        hour: h,
        label: labelThis && h % 3 === 0,
      });
    }
  }

  // The current sun for the selected day + hour.
  const pos = sunPosition(settings.latitude, settings.dayOfYear, settings.hour);
  const sd = sunDirectionModel(pos, settings.northOffset);
  const sun = {
    point: { x: center.x + sd.x * radius, y: center.y + sd.y * radius, z: center.z + sd.z * radius },
    visible: pos.altitude > 0,
    position: pos,
  };

  return { center, radius, groundRing, cardinals, arcs, hourMarks, sun };
}

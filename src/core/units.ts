/**
 * core/units.ts
 *
 * SINGLE SOURCE OF TRUTH for the application's real-world unit system.
 *
 * Geometry is ALWAYS stored in abstract model coordinates where one model unit is
 * DEFINED as one FOOT. Nothing in the data model is ever stored in metres. Anchoring
 * the model to feet (rather than an abstract, dimensionless unit) means every length,
 * area, and any future VECTOR-LINEWORK EXPORT carries true real-world feet, so the
 * drawing scales correctly in downstream CAD/design tools (Rhino, Revit, AutoCAD).
 *
 * The user can switch the DISPLAY unit (feet ↔ metric) from the Settings popup. That
 * switch is a pure PRESENTATION concern: it changes only how lengths/areas are
 * formatted and how typed input is interpreted — it NEVER mutates stored geometry,
 * panel/cell data, or anything the solar study and future computation depend on. Those
 * always read model feet. To switch unit everywhere, call `setUnitSystem` once and
 * trigger a repaint; every label flows from the helpers below.
 */

/** Model units per real-world foot. The model is authored directly in feet. */
export const UNITS_PER_FOOT = 1;

/** The display unit the UI formats lengths/areas in. Geometry stays in feet. */
export type UnitSystem = "imperial" | "metric";

/** Feet in one metre (1 m = 3.280839895 ft). The only conversion constant. */
export const FEET_PER_METRE = 3.280839895;

/** localStorage key for the persisted display-unit preference. */
const STORAGE_KEY = "facade-app:unit-system";

/** Read the persisted preference, defaulting to imperial (feet). */
export function loadUnitSystem(): UnitSystem {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "metric" || v === "imperial") return v;
  } catch {
    /* localStorage unavailable (private mode etc.) — fall through to default. */
  }
  return "imperial";
}

/** Persist the display-unit preference so it survives a reload. */
export function persistUnitSystem(u: UnitSystem): void {
  try {
    localStorage.setItem(STORAGE_KEY, u);
  } catch {
    /* ignore — a non-persisted session still works for the current run. */
  }
}

/**
 * The ACTIVE display unit. Module-level so BOTH the React UI and the imperative
 * canvas renderer (which is not a React component and cannot read context) format
 * through the same value. Initialised from the persisted preference at load so the
 * very first paint is already correct. Mutate only via `setUnitSystem`.
 */
let currentUnit: UnitSystem = loadUnitSystem();

/** The active display unit. */
export function getUnitSystem(): UnitSystem {
  return currentUnit;
}

/** Set the active display unit. Callers must trigger a repaint/re-render afterwards. */
export function setUnitSystem(u: UnitSystem): void {
  currentUnit = u;
}

/** True when the UI is currently presenting metric. */
export function isMetric(): boolean {
  return currentUnit === "metric";
}

// --- Conversions (model feet ⇆ active display unit) -------------------------------

/** Convert a model length (feet) to a numeric value in the active display unit. */
export function toDisplayLength(feet: number): number {
  return currentUnit === "metric" ? feet / FEET_PER_METRE : feet;
}

/** Convert a value TYPED in the active display unit back to model feet (for input). */
export function fromDisplayLength(value: number): number {
  return currentUnit === "metric" ? value * FEET_PER_METRE : value;
}

/** Convert a model area (square feet) to a numeric value in the active display unit. */
export function toDisplayArea(squareFeet: number): number {
  return currentUnit === "metric" ? squareFeet / (FEET_PER_METRE * FEET_PER_METRE) : squareFeet;
}

// --- Active labels ---------------------------------------------------------------

/** Linear unit label, e.g. "ft" or "m". */
export function lengthAbbr(): string {
  return currentUnit === "metric" ? "m" : "ft";
}

/** Area unit label, e.g. "ft²" or "m²". */
export function areaAbbr(): string {
  return currentUnit === "metric" ? "m²" : "ft²";
}

/**
 * COMPACT length tick for on-canvas tags: the prime mark (′) in feet — standard
 * architectural notation — or a plain "m" suffix in metric, where no prime applies.
 */
export function lengthTick(): string {
  return currentUnit === "metric" ? "m" : "′";
}

// --- Formatters (value in MODEL FEET → display string) ---------------------------

/** Format a linear measurement, converting from feet, e.g. `"12.50 ft"` / `"3.81 m"`. */
export function fmtLength(feet: number, digits = 2): string {
  return `${toDisplayLength(feet).toFixed(digits)} ${lengthAbbr()}`;
}

/** Format an area measurement, converting from square feet, e.g. `"24.00 ft²"`. */
export function fmtArea(squareFeet: number, digits = 2): string {
  return `${toDisplayArea(squareFeet).toFixed(digits)} ${areaAbbr()}`;
}

/** Compact length tag for on-canvas labels, e.g. `"10.00′"` / `"3.05m"`. */
export function fmtLengthTick(feet: number, digits = 2): string {
  return `${toDisplayLength(feet).toFixed(digits)}${lengthTick()}`;
}

/**
 * core/units.ts
 *
 * SINGLE SOURCE OF TRUTH for the application's real-world unit system.
 *
 * Geometry is stored in abstract model coordinates, but one model unit is
 * DEFINED as one FOOT. Anchoring the model to a real dimension (rather than an
 * abstract, dimensionless unit) means every length, area, and — importantly —
 * any future VECTOR-LINEWORK EXPORT carries true real-world feet, so the drawing
 * scales correctly in downstream CAD/design tools (Rhino, Revit, AutoCAD, etc.).
 *
 * If the unit system ever needs to change (e.g. metres, or a user-selectable
 * unit), change it HERE and every label/format updates from one place.
 */

/** Model units per real-world foot. The model is authored directly in feet. */
export const UNITS_PER_FOOT = 1;

/** Linear unit label shown in the UI (panel fields, readouts, status bar). */
export const UNIT_ABBR = "ft";

/** Area unit label (square feet). */
export const UNIT_AREA_ABBR = "ft²";

/**
 * Prime mark (′) denoting feet — the standard architectural notation. Used for
 * COMPACT on-canvas dimension labels where a full " ft" would crowd the drawing
 * (e.g. panel width/height tags, floor-plate elevation markers).
 */
export const UNIT_PRIME = "′";

/** Format a linear measurement in feet, e.g. `fmtFeet(12.5) -> "12.50 ft"`. */
export function fmtFeet(value: number, digits = 2): string {
  return `${value.toFixed(digits)} ${UNIT_ABBR}`;
}

/** Format an area measurement in square feet, e.g. `"24.00 ft²"`. */
export function fmtSqFeet(value: number, digits = 2): string {
  return `${value.toFixed(digits)} ${UNIT_AREA_ABBR}`;
}

/** Compact feet label for on-canvas tags, e.g. `fmtFeetPrime(10) -> "10.00′"`. */
export function fmtFeetPrime(value: number, digits = 2): string {
  return `${value.toFixed(digits)}${UNIT_PRIME}`;
}

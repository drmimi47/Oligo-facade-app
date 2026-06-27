/**
 * core/exporters.ts
 *
 * Pure, dependency-free, DOM-free serialisers that turn selected walls into a
 * CAD-importable file. The React layer (ExportPopup) calls these to get a string,
 * then handles the actual download (Blob + object URL + <a download>); none of
 * that browser plumbing lives here, so this module stays unit-testable.
 *
 * FORMAT — ASCII DXF (Drawing eXchange Format):
 *   DXF is plain, hand-writable text and the lingua franca of CAD interchange. It
 *   imports NATIVELY into AutoCAD, and is read directly by Rhino (File ▸ Import)
 *   and Revit (Insert ▸ Link/Import CAD). One correct DXF therefore satisfies all
 *   three target apps, so the three export buttons each emit DXF for now; the
 *   button label names the destination app. Truly-native formats (Rhino `.3dm`
 *   via the rhino3dm WASM lib, IFC for Revit, DWG) can be layered on later behind
 *   the same buttons — they'd each pull in a sizeable dependency, so they are left
 *   as a deliberate follow-up rather than shipped half-working (see CLAUDE.md's
 *   "note the dependency and tradeoff" rule). DXF stays the robust baseline.
 *
 * UNIT PRESERVATION (the hard requirement):
 *   The model is in FEET (1 model unit = 1 foot). We write the wall geometry using
 *   the raw model coordinates — feet — with NO display-unit conversion baked in,
 *   and set the DXF header `$INSUNITS = 2` (Imperial feet). A wall that reads
 *   100' × 20' in the app is written as a 100 × 20 quad and measures 100 × 20 feet
 *   when the receiving app reads the units header. `$MEASUREMENT = 0` keeps the
 *   drawing on the Imperial system.
 *
 * GEOMETRY:
 *   Each selected wall is an extruded vertical quad from {@link buildMassing}
 *   (base edge a→b on the ground plane, rising to the wall's real per-edge height).
 *   Every quad is emitted as one `3DFACE` entity (a 4-point planar face) on a
 *   per-edge layer, so the export is a true 3D surface model of the selected walls.
 */

import type { Perimeter } from "./geometry";
import { buildMassing, type Massing } from "./extrude3d";

/** DXF group-code value for "Imperial feet" in the `$INSUNITS` header. */
export const DXF_INSUNITS_FEET = 2;

/** Line terminator. DXF is traditionally CRLF-delimited; every importer accepts it. */
const NL = "\r\n";

export interface DxfOptions {
  /**
   * `$INSUNITS` header value — the drawing's insertion units. Defaults to
   * {@link DXF_INSUNITS_FEET} (2 = feet) so the receiving CAD app reads the raw
   * model coordinates as feet. Change only if exporting in a different unit.
   */
  insunits?: number;
  /** Layer-name prefix for the per-wall faces (each wall lands on `${prefix}${edge}`). */
  layerPrefix?: string;
}

/**
 * Format a coordinate for DXF: fixed-point (never exponent notation, which some
 * importers choke on), trimmed of trailing zeros, with -0 normalised to 0.
 */
function fmtNum(n: number): string {
  const v = Object.is(n, -0) ? 0 : n;
  // 6 decimals is sub-thousandth-of-a-foot precision — well beyond any real need.
  let s = v.toFixed(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Append one DXF group-code / value pair (each occupies its own line). */
function pair(out: string[], code: number, value: string | number): void {
  out.push(String(code));
  out.push(String(value));
}

/**
 * Serialise an extruded {@link Massing} to an ASCII DXF string. Each wall quad
 * becomes a `3DFACE` entity in feet; the header advertises feet so dimensions are
 * preserved on import. Faces with fewer than 4 points repeat their last point (a
 * degenerate-but-valid triangular 3DFACE); {@link buildMassing} always emits quads.
 */
export function massingToDxf(massing: Massing, opts: DxfOptions = {}): string {
  const insunits = opts.insunits ?? DXF_INSUNITS_FEET;
  const layerPrefix = opts.layerPrefix ?? "WALL_";
  const out: string[] = [];

  // ---- HEADER: declare the drawing units so coordinates are read as feet. ----
  pair(out, 0, "SECTION");
  pair(out, 2, "HEADER");
  // AutoCAD 2000 (AC1015): the earliest version that honours $INSUNITS, and is
  // universally importable by AutoCAD / Rhino / Revit.
  pair(out, 9, "$ACADVER");
  pair(out, 1, "AC1015");
  pair(out, 9, "$INSUNITS");
  pair(out, 70, insunits); // 2 = feet
  pair(out, 9, "$MEASUREMENT");
  pair(out, 70, 0); // 0 = Imperial measurement system
  pair(out, 0, "ENDSEC");

  // ---- ENTITIES: one 3DFACE per wall quad, on a per-edge layer. ----
  pair(out, 0, "SECTION");
  pair(out, 2, "ENTITIES");
  for (const face of massing.faces) {
    const p = face.pts;
    if (p.length < 3) continue; // not a face — skip defensively
    // A 3DFACE always carries 4 corners; for a triangle the 4th repeats the 3rd.
    const c = [p[0], p[1], p[2], p[3] ?? p[2]];
    pair(out, 0, "3DFACE");
    pair(out, 8, `${layerPrefix}${face.edge}`);
    // Corner group codes: 10/20/30, 11/21/31, 12/22/32, 13/23/33 (X/Y/Z each).
    for (let i = 0; i < 4; i++) {
      pair(out, 10 + i, fmtNum(c[i].x));
      pair(out, 20 + i, fmtNum(c[i].y));
      pair(out, 30 + i, fmtNum(c[i].z));
    }
  }
  pair(out, 0, "ENDSEC");

  pair(out, 0, "EOF");
  return out.join(NL) + NL;
}

/**
 * Convenience: build a sub-massing of just the `edges` selected from `perimeter`
 * (each wall at its real per-edge height via `heightOf`) and serialise it to DXF.
 * Coordinates are the raw model feet — the display-unit (Feet/Metric) toggle is
 * deliberately NOT applied, so the file always carries true feet matching the
 * `$INSUNITS = 2` header.
 */
export function selectionToDxf(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  opts: DxfOptions = {},
): string {
  const massing = buildMassing(perimeter, heightOf, edges);
  return massingToDxf(massing, opts);
}

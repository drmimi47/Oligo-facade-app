/**
 * core/exporters.ts
 *
 * Pure, dependency-free, DOM-free serialisers that turn selected walls into a
 * CAD-importable file. The React layer (ExportPopup) calls these to get a string,
 * then handles the actual download (Blob + object URL + <a download>); none of
 * that browser plumbing lives here, so this module stays unit-testable.
 *
 * FORMAT — ASCII DXF (Drawing eXchange Format), AutoCAD R12 (AC1009):
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
 *   We target the R12 (AC1009) dialect deliberately. R12 is the most lenient,
 *   universally-readable DXF: unlike R2000+ (AC1015) it requires NO object handles,
 *   no CLASSES/OBJECTS sections, and no $HANDSEED, so a correct file is hand-writable
 *   without that bookkeeping. CRUCIALLY for Rhino — whose DXF reader is far stricter
 *   than AutoCAD's — the file MUST be complete and self-consistent: every layer an
 *   entity names (group code 8) has to be DEFINED in the TABLES ▸ LAYER table, and a
 *   BLOCKS section must be present (even if empty). A bare HEADER+ENTITIES file (what
 *   we emitted before) opens in AutoCAD, which silently auto-creates missing layers,
 *   but Rhino rejects it as malformed — that was the "file could not be opened" bug.
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
 *   per-edge layer (`WALL_<edge>`), so the export is a true 3D surface model.
 *
 *   Each wall's CENTERLINES and FRAMING (from {@link buildFacadeLines}) are emitted as
 *   `LINE` entities on grouped SUB-LAYERS named `WALL_<edge>-CENTERLINES` and
 *   `WALL_<edge>-FRAMING`. A wall gets a sub-layer ONLY when it actually carries that
 *   geometry. The hyphen-grouped naming (rather than a "Parent::Child" path) is
 *   deliberate: a colon is an INVALID character in AutoCAD layer names, so a "::" path
 *   would risk the very "won't open" failure we just fixed; `WALL_0-CENTERLINES` is
 *   valid in every target app and still groups/sorts under its wall border.
 */

import type { Perimeter } from "./geometry";
import { buildMassing, type Massing, type Face } from "./extrude3d";
import {
  buildFacadeLines,
  buildFacadeLines2D,
  buildFlatPanels,
  type FacadeRecords,
  type Vec3,
} from "./facadeLines";

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

/** Default colour index (7 = white/black, follows background) for generated layers. */
const LAYER_COLOR = 7;

/** One polyline to emit as a chain of `LINE` entities on `layer` (centerline/framing). */
interface DxfLine {
  layer: string;
  pts: Vec3[];
}

/**
 * Serialise wall `3DFACE`s plus facade `LINE`s into one complete, well-formed ASCII
 * DXF string (R12 / AC1009). The file carries the full section set strict readers
 * (Rhino) require: HEADER, TABLES (LTYPE `CONTINUOUS` + a LAYER record for EVERY layer
 * any entity uses — collected up-front — plus the always-present default layer `0`),
 * an empty BLOCKS section, then ENTITIES. Declaring every referenced layer is what
 * makes the export open in Rhino, not just AutoCAD. Coordinates are raw model feet and
 * the header advertises feet, so dimensions are preserved on import.
 */
function buildDxfDocument(faces: Face[], lines: DxfLine[], layerPrefix: string, insunits: number): string {
  const out: string[] = [];

  // Collect EVERY layer the entities reference so each can be DEFINED in the LAYER
  // table; "0" is the mandatory default. A facade sub-layer only appears here when its
  // line set is non-empty, so walls without centerlines/framing get no empty sub-layer.
  const layers = new Set<string>(["0"]);
  for (const face of faces) if (face.pts.length >= 3) layers.add(`${layerPrefix}${face.edge}`);
  for (const line of lines) if (line.pts.length >= 2) layers.add(line.layer);

  // ---- HEADER: R12 version + drawing units, so coordinates are read as feet. ----
  pair(out, 0, "SECTION");
  pair(out, 2, "HEADER");
  // AC1009 (AutoCAD R12): the most lenient, universally-importable DXF dialect —
  // no object handles or OBJECTS/CLASSES sections required, so the hand-written file
  // is fully conformant. $INSUNITS/$MEASUREMENT are still honoured by Rhino/AutoCAD.
  pair(out, 9, "$ACADVER");
  pair(out, 1, "AC1009");
  pair(out, 9, "$INSUNITS");
  pair(out, 70, insunits); // 2 = feet
  pair(out, 9, "$MEASUREMENT");
  pair(out, 70, 0); // 0 = Imperial measurement system
  pair(out, 0, "ENDSEC");

  // ---- TABLES: linetype + a LAYER record for every layer the entities reference. ----
  pair(out, 0, "SECTION");
  pair(out, 2, "TABLES");
  // LTYPE table — defines CONTINUOUS, the linetype every layer below points at.
  pair(out, 0, "TABLE");
  pair(out, 2, "LTYPE");
  pair(out, 70, 1);
  pair(out, 0, "LTYPE");
  pair(out, 2, "CONTINUOUS");
  pair(out, 70, 0);
  pair(out, 3, "Solid line");
  pair(out, 72, 65);
  pair(out, 73, 0);
  pair(out, 40, "0.0");
  pair(out, 0, "ENDTAB");
  // LAYER table — one record per collected layer.
  pair(out, 0, "TABLE");
  pair(out, 2, "LAYER");
  pair(out, 70, layers.size);
  for (const name of layers) {
    pair(out, 0, "LAYER");
    pair(out, 2, name);
    pair(out, 70, 0); // flags: none (visible, thawed, unlocked)
    pair(out, 62, LAYER_COLOR); // colour index
    pair(out, 6, "CONTINUOUS"); // linetype (defined above)
  }
  pair(out, 0, "ENDTAB");
  pair(out, 0, "ENDSEC");

  // ---- BLOCKS: present-but-empty. Strict readers expect the section to exist. ----
  pair(out, 0, "SECTION");
  pair(out, 2, "BLOCKS");
  pair(out, 0, "ENDSEC");

  // ---- ENTITIES: 3DFACE per wall quad, then LINE chains for centerlines / framing. ----
  pair(out, 0, "SECTION");
  pair(out, 2, "ENTITIES");
  for (const face of faces) {
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
  // Each facade polyline → one LINE per consecutive vertex pair (R12 LINE is universal;
  // a 2-point polyline is a single line, a curved-wall horizontal line spans several).
  for (const line of lines) {
    const p = line.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      pair(out, 0, "LINE");
      pair(out, 8, line.layer);
      pair(out, 10, fmtNum(a.x));
      pair(out, 20, fmtNum(a.y));
      pair(out, 30, fmtNum(a.z));
      pair(out, 11, fmtNum(b.x));
      pair(out, 21, fmtNum(b.y));
      pair(out, 31, fmtNum(b.z));
    }
  }
  pair(out, 0, "ENDSEC");

  pair(out, 0, "EOF");
  return out.join(NL) + NL;
}

/**
 * Serialise an extruded {@link Massing} (walls only) to a complete R12 DXF string.
 * Each wall quad becomes a `3DFACE` entity in feet on its `WALL_<edge>` layer.
 */
export function massingToDxf(massing: Massing, opts: DxfOptions = {}): string {
  const insunits = opts.insunits ?? DXF_INSUNITS_FEET;
  const layerPrefix = opts.layerPrefix ?? "WALL_";
  return buildDxfDocument(massing.faces, [], layerPrefix, insunits);
}

/**
 * Flatten the per-wall facade line sets (3D or 2D) into `LINE` entities on the grouped
 * `WALL_<edge>-CENTERLINES` / `WALL_<edge>-FRAMING` sub-layers. Empty sets contribute
 * nothing, so a sub-layer is only created when the wall actually carries that geometry.
 */
function facadeLinesToDxf(
  sets: ReturnType<typeof buildFacadeLines>,
  layerPrefix: string,
): DxfLine[] {
  const lines: DxfLine[] = [];
  for (const fe of sets) {
    for (const pl of fe.centerlines) lines.push({ layer: `${layerPrefix}${fe.edge}-CENTERLINES`, pts: pl });
    for (const pl of fe.framing) lines.push({ layer: `${layerPrefix}${fe.edge}-FRAMING`, pts: pl });
  }
  return lines;
}

/**
 * 3D export: build a sub-massing of just the `edges` selected from `perimeter` (each
 * wall extruded to its real per-edge height via `heightOf`) and serialise it to DXF.
 * When `records` is given, each wall's CENTERLINES and FRAMING are also exported as
 * `LINE`s on grouped `WALL_<edge>-CENTERLINES` / `WALL_<edge>-FRAMING` sub-layers.
 * Coordinates are the raw model feet — the display-unit (Feet/Metric) toggle is
 * deliberately NOT applied, so the file always carries true feet matching the
 * `$INSUNITS = 2` header.
 */
export function selectionToDxf(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  records?: FacadeRecords,
  opts: DxfOptions = {},
): string {
  const insunits = opts.insunits ?? DXF_INSUNITS_FEET;
  const layerPrefix = opts.layerPrefix ?? "WALL_";
  const massing = buildMassing(perimeter, heightOf, edges);
  const lines = records ? facadeLinesToDxf(buildFacadeLines(perimeter, edges, heightOf, records), layerPrefix) : [];
  return buildDxfDocument(massing.faces, lines, layerPrefix, insunits);
}

/**
 * 2D (UNROLLED-ELEVATION) export: the same selection laid out as the elevations view —
 * each wall a FLAT rectangle in the unravel strip (panels spaced by `gap`, lying on the
 * ground plane Z = 0), with its centerlines and framing flat inside. Uses the IDENTICAL
 * layer scheme as {@link selectionToDxf} (`WALL_<edge>` panel + `-CENTERLINES` /
 * `-FRAMING` sub-layers), so the 2D and 3D files organise the same way — only the
 * geometry layout differs. Units are preserved exactly as in the 3D export.
 */
export function selection2DToDxf(
  perimeter: Perimeter,
  edges: ReadonlySet<number>,
  heightOf: (edge: number) => number,
  records: FacadeRecords,
  gap: number,
  opts: DxfOptions = {},
): string {
  const insunits = opts.insunits ?? DXF_INSUNITS_FEET;
  const layerPrefix = opts.layerPrefix ?? "WALL_";
  // Flat wall-border panels become 3DFACEs on WALL_<edge>, exactly like the 3D walls.
  const faces: Face[] = buildFlatPanels(perimeter, edges, heightOf, gap).map((p) => ({
    edge: p.edge,
    pts: p.pts,
  }));
  const lines = facadeLinesToDxf(buildFacadeLines2D(perimeter, edges, heightOf, records, gap), layerPrefix);
  return buildDxfDocument(faces, lines, layerPrefix, insunits);
}

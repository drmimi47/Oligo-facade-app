/**
 * core/savedPerimeters.ts
 *
 * Save / persistence layer for perimeters. Pure data logic — no DOM, no React.
 *
 * WHY localStorage (noted per the working agreement): the Perimeter model is a
 * plain, JSON-serializable object (vertices with numeric fields + a boolean),
 * so the simplest durable store that survives a reload with zero backend is
 * `localStorage`. No new dependency is introduced. If multi-device sync or large
 * libraries are needed later, swap this module's read/write for IndexedDB or a
 * server without touching the UI (the component only calls the helpers here).
 *
 * Each save is deep-copied on capture so subsequent edits to the LIVE perimeter
 * can never mutate a stored one (the model is shared-by-reference in React
 * state, so a shallow copy would alias the vertex objects).
 */

import type { Perimeter } from "./geometry";
import { perimeterLength, enclosedArea } from "./geometry";

/** A persisted perimeter plus its metadata. */
export interface SavedPerimeter {
  /** Stable unique id (used as React key and for load/delete/update). */
  id: string;
  /** User-facing name; auto-generated ("Perimeter 1") but renameable. */
  name: string;
  /** Epoch millis when first saved (for ordering / display). */
  createdAt: number;
  /** Deep-copied perimeter geometry (model units). */
  perimeter: Perimeter;
}

/** localStorage key under which the saved-perimeter list lives. */
const STORAGE_KEY = "facade-app.savedPerimeters.v1";

/**
 * Deep-copy a perimeter. The model is plain JSON (no functions/dates/cycles),
 * so structuredClone (or a JSON round-trip fallback) is correct and detaches
 * every nested vertex/handle object from the live state.
 */
export function clonePerimeter(p: Perimeter): Perimeter {
  if (typeof structuredClone === "function") return structuredClone(p);
  return JSON.parse(JSON.stringify(p)) as Perimeter;
}

/** Minimum vertices required to save (guards empty/degenerate perimeters). */
export const MIN_SAVE_VERTICES = 2;

/** Is this perimeter substantial enough to save? */
export function canSave(p: Perimeter): boolean {
  return p.vertices.length >= MIN_SAVE_VERTICES;
}

/** Generate a reasonably unique id without pulling in a uuid dependency. */
function makeId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a new SavedPerimeter from the live perimeter. `existing` is used only to
 * pick the next auto name ("Perimeter N") so names stay sequential.
 */
export function makeSavedPerimeter(p: Perimeter, existing: SavedPerimeter[]): SavedPerimeter {
  // Next number = one past the highest "Perimeter N" already present, so deleting
  // and re-saving doesn't reuse a confusingly low number mid-session.
  let maxN = 0;
  for (const s of existing) {
    const m = /^Perimeter (\d+)$/.exec(s.name);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return {
    id: makeId(),
    name: `Perimeter ${Math.max(existing.length, maxN) + 1}`,
    createdAt: Date.now(),
    perimeter: clonePerimeter(p),
  };
}

/** Convenience readouts for a saved perimeter (curve-accurate). */
export function savedStats(s: SavedPerimeter): { length: number; area: number; vertices: number } {
  return {
    length: perimeterLength(s.perimeter),
    area: enclosedArea(s.perimeter),
    vertices: s.perimeter.vertices.length,
  };
}

// ---------------------------------------------------------------------------
// PERSISTENCE (localStorage)
// ---------------------------------------------------------------------------

/**
 * Load the saved list from localStorage. Defensive: returns [] on any problem
 * (missing key, malformed JSON, wrong shape, no localStorage in the runtime) so
 * a corrupt store never crashes the app on mount.
 */
export function loadSaved(): SavedPerimeter[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only entries with the expected shape.
    return parsed.filter(
      (s): s is SavedPerimeter =>
        s &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        s.perimeter &&
        Array.isArray(s.perimeter.vertices),
    );
  } catch {
    return [];
  }
}

/** Persist the saved list. Swallows quota/serialization errors (best-effort). */
export function persistSaved(list: SavedPerimeter[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }
  } catch {
    /* best-effort: ignore quota / private-mode write failures */
  }
}

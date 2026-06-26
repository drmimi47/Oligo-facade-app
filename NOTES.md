# Facade App — Polyline / Perimeter Tool

First feature of the facade-app: an interactive 2D canvas for drawing a building
perimeter as a polyline/polygon, with the precision and visible state expected of
professional design tooling.

## Stack and rationale

- **Vite + React + TypeScript** — fast dev server/HMR, strong typing for the
  geometry layer, minimal config. React manages only the UI shell and reactive
  state; it does not touch the canvas pixels directly.
- **HTML5 Canvas 2D** for rendering (not SVG). Chosen because the tool needs a
  single repaint of the whole scene per frame (grid + segments + vertices +
  live rubber-band) and we do hit-testing in our own **model coordinate space**
  rather than relying on DOM element hit-testing. Canvas keeps the DOM flat and
  scales to many vertices without per-vertex DOM nodes. The trade-off (no free
  DOM hit-testing) is handled by explicit geometry hit-tests in `core/geometry.ts`.
- **No other runtime dependencies.** Geometry, viewport math, and rendering are
  hand-written and dependency-free to keep the surface small and predictable.

## Architecture — clean separation of concerns

The code keeps the three layers the brief asked for strictly separate:

| Layer        | Files                                              | Responsibility |
|--------------|----------------------------------------------------|----------------|
| Data model   | `src/core/geometry.ts`, `src/core/perimeterOps.ts` | `Perimeter` = ordered list of vertices in **model units** + `closed` flag. Each vertex carries optional cubic-Bézier handle offsets (`handleIn`/`handleOut`) so a segment is a straight line or a curve. Pure geometry (length, area, snapping, angle constraint, curve flattening/splitting, hit-testing) and **immutable** edit operations. No DOM/React. |
| Rendering    | `src/core/renderer.ts`, `src/core/viewport.ts`     | Model↔screen transform (+Y up in model, flipped for screen) and a pure `render()` that paints the model + transient UI state. Reads all visual values from CSS variables. |
| Input / UI   | `src/PolylineTool.tsx`                              | Pointer + keyboard handling translated into model operations; React state; the side panel and status bar. |

The data model is the source of truth: it stores **model coordinates, never
pixels**, so zoom/pan never alter the geometry. All edits return new `Perimeter`
objects (non-destructive), which makes future undo/redo straightforward.

## How to run

```bash
npm install
npm run dev      # start the dev server (Vite prints the local URL)
```

Other scripts:

```bash
npm run build      # tsc --noEmit type-check, then production build to dist/
npm run typecheck  # type-check only
npm run preview    # serve the production build
```

## Controls

Mouse:
- **Click** — place a vertex (Draw mode).
- **Click-drag while placing** — pull out cubic-Bézier curve handles, turning the
  segment into a curve (pen-tool style); handles are symmetric (smooth point).
- **Click the first vertex** (it shows a ring once ≥3 points) / **Double-click** — close the perimeter.
- **Drag a vertex** (Edit mode) — reshape.
- **Drag a handle knob** (Edit mode, selected vertex) — shape the curve; **Alt-drag** breaks the tangent (cusp).
- **Alt-drag a vertex** (Edit mode) — pull out fresh handles, converting a corner into a curve.
- **Double-click a vertex** (Edit mode) — strip its handles (curve → corner).
- **Shift-click a vertex** (Edit mode, perimeter view) — delete that vertex (a quick
  "remove point" gesture). One undo step; clears the selection. If deleting drops a
  closed polygon below 3 vertices it is reopened (`deleteVertex` op). Hooked into the
  edit-mode vertex hit-test only — NOT during drawing, where Shift is the 45° angle
  constraint and clicking the first vertex closes the shape, so the gesture can't
  collide with either.
- **Click a segment** (Edit mode) — insert a new vertex there and start dragging it
  (curved segments are split with De Casteljau, preserving the shape).
- **Wheel / trackpad zoom** — smooth zoom toward the cursor. The zoom is
  magnitude-proportional and exponential (`factor = exp(-deltaY * K)`, `K = ln(1.1)/100`,
  per-event factor clamped to 0.5–2.0), so a mouse notch still steps ~1.1× while a
  trackpad's many small deltas read as continuous. `deltaMode` is normalized to pixels
  (line ×16, page × canvas height) first.
- **Pinch-to-zoom (trackpad)** — browsers report a pinch as a `ctrl`+wheel event; it
  flows through the same anchored exponential zoom path.
- **Right-click drag** — pan (touchpad-friendly, no middle button needed). A *static*
  right-click still opens the unravel cell-split menu; a right-drag-pan suppresses it.
- **Middle-mouse drag** — pan.

Note: the wheel handler is attached as a **non-passive native listener**
(`addEventListener("wheel", …, { passive: false })`) so `preventDefault()` works —
otherwise a trackpad pinch would zoom the whole browser page. React's synthetic
`onWheel` is passive and cannot prevent that, so it is not used here.

Keyboard:
- **A / L** — set the next segments to **A**rc (curved) or **L**ine (straight).
  In Arc mode a plain click auto-curves the committed segment; click-drag shapes it manually.
- **Enter** — close the perimeter (Draw mode, ≥3 vertices).
- **Esc** — cancel the in-progress polyline.
- **Backspace / Delete** — remove the last vertex (Draw) or delete the selected vertex (Edit).
- **Shift (hold)** — constrain the current segment (or handle) to 45° increments.
- **Ctrl/Cmd+Z** — undo · **Ctrl+Y** or **Ctrl/Cmd+Shift+Z** — redo (see *Undo / redo* below).

Precision controls (left panel):
- Snap-to-grid is ALWAYS ON (no toggle) and rounds points to a FIXED 1 ft grid.
  `gridSpacing` is now a `const 1` (no longer user-editable; the spacing input was
  removed from the left panel). The grid is never drawn — `gridSpacing` drives
  snapping only.
- **Numeric next-segment entry**: type a length and angle to place the next
  vertex exactly, relative to the last one.

Readouts:
- Status bar: live cursor X/Y, current segment length and angle, snap
  state ("Snap on"), 45°-lock indicator, and zoom.
- **Statistics dropdown** (button at the top of the canvas, next to Redo): the
  live derived statistics, **context-aware by view**. In the draw/perimeter view
  it shows vertex count, closed state, total perimeter length, and enclosed area;
  in the unravel/elevation view it shows segment count, unwrapped length, and
  total area. These readouts used to live in the left panel ("Perimeter" /
  "Unwrap" sections) — they now live ONLY in this dropdown (see *Statistics
  dropdown* below).

## Undo / redo

Keyboard: **Ctrl/Cmd+Z** = undo, **Ctrl+Y** or **Ctrl/Cmd+Shift+Z** = redo (also ↶/↷
buttons at the top of the panel). Shortcuts are ignored while a text field is
focused so native text-undo still works there.

- **What's tracked** — a snapshot history of the *authored document*: the
  `perimeter` (vertices, curve handles, open/closed) plus the per-panel unravel
  **heights** (`unravelHeights` + global default `unravelHeight`) and **cell
  splits** (`unravelCells`). Transient view state (viewport, selection, hover,
  mode) and the saved-library list are intentionally NOT in the snapshot.
- **Cheap snapshots** — every tracked value is immutable (perimeter ops return new
  objects; the height/cell maps are replaced, never mutated), so a `DocSnapshot`
  is just a bundle of references — no deep cloning. Stacks are capped at
  `HISTORY_LIMIT` (100); a new edit clears the redo stack.
- **One step per action** — capture happens at action boundaries, not per
  mouse-move: discrete actions (place/close/insert/delete vertex, numeric add,
  smooth/corner, double-click corner, cell split, load, reset) call
  `recordHistory()` *before* the change; drags and field edits (vertex/handle/
  height drags, the global Height field) snapshot at the start (`beginHistory`)
  and push once on the first actual change (`flushHistory`), so a whole drag or a
  typing session collapses to a single undo step and a no-op press/focus adds
  nothing. The on-rectangle height input records on commit (Enter/blur).
- **Implementation** — `docRef` holds the always-current snapshot (refreshed each
  render) so capture/undo read fresh values without stale closures; `applyDoc`
  restores a snapshot and clears transient selection. All in `PolylineTool.tsx`.
- **Deferred** — the **undo history** itself is per-session (not saved to
  localStorage). The document fields it tracks (heights/cells/floor plates),
  however, **are** persisted per save — see *Saving perimeters* below.

## Saving perimeters + the mini-window

A perimeter can be **saved** and recalled later. Saved shapes appear in a
draggable **mini-window** anchored to the top-right of the canvas.

### Save

- **Save perimeter** button (left panel, *Library* section) or **Ctrl/Cmd+S**.
- Guarded: requires **≥ 2 vertices** (`canSave`); the button disables and the
  shortcut no-ops on an empty/degenerate perimeter.
- On save the live model is **deep-copied** (`clonePerimeter` via
  `structuredClone`, JSON fallback) so later edits to the editor never mutate a
  stored entry. Each save gets a unique id and an auto name ("Perimeter N",
  renameable). **Save perimeter always creates a NEW entry** (→ a new mini-window
  preview) and makes it active; it never overwrites an existing one.
- **A saved entry carries elevation state too.** `SavedPerimeter` stores not just
  the footprint `perimeter` but the authored **elevation/unwrapped-view document
  state**: `unravelHeights` (per-edge panel heights), `unravelCells` (per-edge
  cell splits), `unravelHeight` (global default wall height), and `floorPlates`
  (placed level elevations). These mirror the editor's `DocSnapshot` persistent
  fields and are deep-copied on capture (`cloneElevationState` — fresh
  containers, values are primitives). So saving a shape that already has panel
  edits snapshots them, and loading restores them.
  - **Backward compatible:** the four elevation fields are **optional** on the
    interface, and `loadSaved()` **defaults** any missing field (`{}` / `{}` /
    `DEFAULT_WALL_HEIGHT_FT` / `[]`) when reading. Entries written before
    elevation state existed (only `{id,name,createdAt,perimeter}`) still load —
    the `STORAGE_KEY` is **not** bumped and old saves are **not** dropped.
- **Auto-save of the active entry.** When a saved entry is loaded
  (`activeSavedId` set), an effect writes **every** authored document change —
  footprint geometry **and** elevation-view panel edits — back into **that entry
  only**. There is no manual "update" button; edits to a loaded project always
  auto-save to that specific pipeline.
  - **Isolation:** the effect replaces **only** the entry whose `id ===
    activeSavedId` (every other entry keeps its exact reference). A brand-new
    unsaved shape (`activeSavedId == null`) is never auto-created — its edits stay
    live until the user clicks *Save perimeter*.
  - **No-op guard (avoids feedback loops / persist churn):** loading an entry sets
    these same states, which would otherwise re-trigger an identical write-back
    every render. Inside the `setSaved` updater we compare the stored fields to
    the live document (cheap `JSON.stringify` deep-equal on the small
    maps/arrays/perimeter, plus a numeric compare for `unravelHeight`); if they
    already match we return the **same list reference** so React bails out (no
    re-render, no localStorage write). A new list is returned only when something
    actually differs.
- **Persistence:** saves are written to **`localStorage`** (key
  `facade-app.savedPerimeters.v1`). *Why localStorage:* the `Perimeter` model
  (and the elevation state) is plain, JSON-serializable data, so this is the
  simplest durable store that survives reload with no backend and no new
  dependency. Loading happens once via the lazy `useState(() => loadSaved())`
  initializer (defensive: returns `[]` on missing/corrupt data); the list is
  re-persisted by an effect whenever it changes (this is what flushes auto-saved
  edits to disk). To move to IndexedDB/a server later, only
  `core/savedPerimeters.ts` changes.

### Mini-window (top-right overlay)

Renders each saved shape as a **live thumbnail** using the existing `render()`
with a **fit-to-bounds** viewport (`fitViewport` in `core/viewport.ts`: bounds
from `flattenPerimeter`, small margin, centred; zero-size bounds — single point /
straight line — are floored to an epsilon to avoid divide-by-zero). Multiple
saves show as a compact, **scrollable** gallery with name + vertex count + length
(+ area when closed).

Interactions:
- **Click a thumbnail / name** — load that perimeter back into the editor
  (replaces the live one; **restores its elevation state** — panel heights, cell
  splits, default height, floor plates; switches to **Edit** mode for closed
  shapes, stays in **Draw** for open ones). The loaded entry is highlighted, and
  subsequent edits **auto-save** back into it (see *Auto-save* above).
  - **Zoom-to-fit on load.** Saved shapes are at vastly different model scales, so
    `loadSavedEntry` now **frames the loaded perimeter** to the main canvas via
    `animateViewport(fitViewport(loaded, w, h, 64))` — the same fit helpers used by
    `zoomToPanel`/`fitUnravel`, animated (not snapped) for a smooth transition. The
    fit uses the SAME cloned perimeter that is loaded; `fitViewport` floors
    degenerate spans (empty / single point / straight line) to an epsilon so the
    target is always finite (no NaN/Infinity viewport). It runs **only when the
    perimeter view is showing** (`!unravelOn`): in the unravel/elevation view the
    unrolled strip — not the footprint — is on screen, so refitting to the footprint
    would move the viewport away from what's drawn. The **mini-window thumbnails are
    deliberately left unchanged** (no edit to `MiniWindow.tsx` / its `frozenRef`
    freeze or per-thumb camera) — only the MAIN canvas viewport reframes.
- **Rename** — double-click the name, or the **✎** button; Enter/blur commits,
  Esc cancels.
- **Delete (×)** — remove that save.
- *(The old **Update (⤓)** thumbnail button and the **Update loaded entry** panel
  button were removed — editing a loaded entry now auto-saves to that entry.)*
- **Reposition** — drag the **title bar** to move the window; it is clamped to
  stay fully within the canvas area (and re-clamped on resize).
- **Collapse/expand (▾/▸)** — hide/show the gallery body.

Architecture: pure data/persistence logic lives in `core/savedPerimeters.ts`;
the UI lives in `MiniWindow.tsx` and is composed into `PolylineTool.tsx`. No
geometry math is duplicated — thumbnails reuse `flattenPerimeter`.

### Thumbnails are 3D massing previews

Each mini-window thumbnail renders its saved perimeter as an **extruded 3D
massing** (not a flat 2D outline): the footprint is extruded vertically into
**thin (thickless) wall planes only — no floor/roof caps**. Each perimeter edge
becomes one vertical plane; the result reads as an open wall shell you can spin.

- **Dependency decision — hand-written, no library.** Per the working agreement,
  this codebase is deliberately dependency-free; geometry and the 2D-canvas
  renderer are all hand-written. A 3D library (three.js/WebGL) would be far larger
  than needed for a small, static, slightly-from-above massing preview. So the 3D
  is a **hand-written lightweight projection drawn to the same 2D canvas**: build
  extruded vertices, project with a simple fixed camera, draw faces as
  filled/stroked polygons with **painter's-algorithm** back-to-front depth
  sorting. No new dependency; consistent with `renderer.ts`.
- **Module:** `core/extrude3d.ts` (pure 3D logic, no React/DOM beyond reading CSS
  tokens off the canvas exactly like `renderer.ts`). `MiniWindow.tsx` only calls
  `render3d(ctx, canvas, w, h, dpr, perimeter, options)`.
- **Unit / height assumption:** the app's unit system is **feet** — see the
  **Units** section below. **1 model unit = 1 foot**, so the default wall height
  of ~10 ft is `DEFAULT_WALL_HEIGHT_FT = 10` (a single named constant — change it
  to retune; `render3d` also accepts a `height` option).
- **Curves extrude smoothly:** walls are built from the **flattened** outline
  (`flattenPerimeter`), so a curved wall becomes a smooth strip of vertical quads.
  Each wall quad carries the **original edge index** (reconstructed by reusing
  `flattenSegment`'s point count per edge), so flattened sub-segments still map
  back to their source edge.
- **Camera / projection / fit:** starts at a 3/4 view (`DEFAULT_CAMERA`: azimuth
  ~-36°, elevation 30° down-tilt) and is **rotatable per thumbnail by dragging**
  (see below). Projection is **orthographic** (rotate about Z for azimuth, tilt
  about X for elevation; screen-X = rotated right axis, screen-up = lifted Z minus
  folded depth; depth = the into-screen component used only for sorting).
  Orthographic avoids perspective distortion and any divide-by-z, which reads
  cleanly at thumbnail size. `fitProjected` frames ALL projected face vertices (so
  it accounts for both footprint and height) into the thumb box with a margin,
  centred; zero-size spans are floored to an epsilon so the scale is finite.
- **Correct occlusion:** wall planes are filled with an **opaque** token and drawn
  **back-to-front** (faces sorted by mean depth, **farthest first**) so nearer
  walls paint over farther ones. This keeps background walls from incorrectly
  showing in front as the model spins. (Vertical walls of a footprint don't
  intersect, so centroid-depth ordering is reliable; mildly concave shapes can
  still mis-order rare cases — acceptable for a preview.)
- **Drag to rotate/spin:** dragging on a thumbnail orbits its camera — horizontal
  drag spins the azimuth, vertical drag changes elevation (clamped to ~±83°). Each
  thumbnail keeps its own camera. A drag past a small threshold is treated as a
  rotate (it does **not** load the perimeter); a click without drag still loads.
  Cursor shows `grab`/`grabbing`.
  - **Mode-aware (`onThumbPointerMove`):** the gesture is the same in both views, but
    the camera constraint differs by `planView`. In **plan/top-down view** a drag only
    **spins** the plan (azimuth) and elevation is **locked** to the plan's `PI/2`, so the
    view stays flat/2D-looking no matter how the user drags — dragging never tilts it
    back out of top-down. **Only a double-click** returns to the 3D (3/4) view. In **3D
    view** the full behavior is unchanged (azimuth from horizontal drag, elevation from
    vertical drag clamped to ~±83°). The `.is-plan` affordance therefore persists while
    spinning the plan.
- **Double-click for a top-down (plan) view:** double-clicking a thumbnail's preview
  smoothly animates its camera to a true top-down / orthogonal plan
  (`elevation = PI/2`, `azimuth → 0`, north-up), collapsing the extruded massing into
  its flat 2D footprint outline — for when the angled 3/4 massing isn't wanted.
  Double-clicking again toggles back to the default 3/4 view (`DEFAULT_CAMERA`).
  - The animation (`animateCameraTo` in `MiniWindow.tsx`) runs on
    `requestAnimationFrame` over ~290ms with the shared `easeInOut` (`viewport.ts`).
    Azimuth interpolates along the **shortest** angular path (delta normalized into
    `[-π, π]`) so it never spins the long way; elevation eases linearly. The plan
    target uses the full `PI/2`, NOT the drag's `±83°` clamp (that clamp limits manual
    rotation only).
  - **The user stays in control:** starting a drag (`onThumbPointerDown`) cancels any
    in-flight animation so manual rotation always wins, a new double-click cancels and
    re-targets, and the rAF is cancelled on unmount (no setState-after-unmount).
  - The toggle tracks **intent** via a `planView` boolean (not float equality of the
    camera). Double-click does **not** load the perimeter: it sets a
    `suppressClickRef` flag that the thumbnail's click handler consumes/clears, so the
    click that fires alongside the double-click is ignored (single-click-to-load and
    drag-to-rotate are otherwise unchanged).
  - **Affordance:** a thumb in plan view shows a subtle inset outline
    (`.mini__canvas.is-plan`, token `--mini-plan-outline`, light + dark).
- **Edge-highlight preserved in 3D:** the mini-window still receives
  `highlightEdge` for the active entry; in 3D the **wall panel** for that edge
  index is filled/stroked in the highlight tokens, so hovering an unravel strip
  lights up the matching wall.
- **Degenerate inputs are safe:** < 2 vertices or a zero-size footprint draw
  nothing (no crash, no divide-by-zero).
- **New CSS tokens** (`styles.css`, light + dark, `=== MINI-WINDOW 3D ===`):
  `--m3d-wall-fill/-stroke`, `--m3d-highlight-fill/-stroke`, `--m3d-edge-width`,
  `--m3d-highlight-width`. (Roof/floor cap tokens were removed with the caps.)
- **Trade-off:** thumbnails no longer use the 2D `render()`/`fitViewport` path
  (`render` is still used for the main canvas).

### Active thumbnail tracks live edits, then freezes on click-away

The **active** entry (`activeSavedId`) renders the **live editor shape**
(`livePerimeter` + per-edge `heights`) so footprint/height edits show in its
preview immediately, instead of a stale stored snapshot. When the entry **stops
being active** — the user clicks away or loads a *different* saved preview — the
thumbnail does **not** snap its massing back to the stored snapshot. Each `Thumb`
keeps a `frozenRef` recording the last live massing it displayed while active and
renders that frozen shape afterwards, so the preview **stays exactly as it was
shown**. The per-thumbnail `camera` (perspective) is already local Thumb state, so
it persists across the transition without extra work; only the geometry/heights
needed explicit freezing. Render priority in the repaint effect: live shape (active)
→ frozen live massing (was active, clicked away) → stored snapshot (never edited
live). When `saved.perimeter` is replaced for an entry (e.g. auto-save writes a
new snapshot), the repaint effect clears `frozenRef` so the fresh snapshot shows.

## Overview map (bottom-left navigator)

A small, always-visible **overview map** (`src/OverviewMap.tsx`) anchored inside
`.canvas-wrap` shows a **fit-to-view, centred** picture of WHATEVER THE MAIN CANVAS
SHOWS — the WHOLE footprint perimeter in the draw/edit view, or the WHOLE unrolled
**panel strip** in the unravel/elevation view — so the user can glance the entire
scope even while the main canvas is zoomed hard onto one part of a very large
shape/elevation.

- **Reuses the proven layers — no geometry/drawing duplicated.** It frames the
  scene with `fitViewport(...)` (the same helper the mini-window / unravel fits use;
  degenerate spans — empty / single point / straight line — are floored to an epsilon
  in `viewport.ts`, so the fit viewport is always finite, no NaN). The fit TARGET is
  view-dependent: the footprint `perimeter` in draw/edit, or — in the unravel view —
  the strip bounds from `unravelBoundsPerimeter(segments, heightOf)` rebuilt from the
  passed `unravelDraws` (same bounds the main unravel fit uses, so the strip frames
  identically). It then paints with the pure `render()` (`core/renderer.ts`) using a
  **neutral `RenderState`** that also sets two OVERVIEW-ONLY opt-in flags so the
  navigator stays a clean, glanceable read (the MAIN canvas never sets either flag, so
  its rendering is untouched):
  - `outlineOnly` (perimeter view): `render()` paints the footprint fill + stroke and
    then RETURNS — **no vertex dots**, no edge highlight, handles, rubber-band, or
    insert marker. The overview shows JUST the shape.
  - `unravelBoundariesOnly` (unravel view): `render()`/`drawUnravel` draw ONLY each
    panel's rectangle (outline + light fill) and skip the **dimension labels, cell
    splits, division mullions, divide preview, hover/selected/top-resize emphasis**,
    and **floor plates**. So the strip reads as clean panel BOUNDARIES only.

  Canvas sizing is DPR-aware exactly like the mini-window `Thumb`. It repaints via
  `useLayoutEffect` whenever the perimeter, the main viewport, the main canvas size,
  `unravelOn`, or `unravelDraws` change.
- **Frames the FULL extent (true-extent fix).** The bounds are built from ALL
  `unravelDraws` (every panel's `x0..x1` and its own height, via
  `unravelBoundsPerimeter`), so the complete width and the tallest height are covered.
  The bug was the FIT, not the bounds: `fitViewport` clamps zoom to a 0.25 px/unit
  floor (an interactive limit for the big main canvas). A wide many-panel strip needs a
  much smaller scale to fit the ~200×150 px overview box, so the clamp let it OVERFLOW
  (only its centre showing). `fitViewport` now takes an optional `minScale` (default =
  the 0.25 `MIN_SCALE`, so the main canvas is unchanged); the overview passes a
  near-zero floor (`OVERVIEW_MIN_SCALE`) so the whole strip / footprint always frames in
  full, regardless of the main canvas zoom/pan.
- **Current-view indicator (the main payoff).** A rectangle marks the portion of
  the model currently visible in the MAIN canvas. The main view's visible model
  rectangle is found by **unprojecting** the main canvas corners with
  `toModel(mainViewport, 0, 0)` and `toModel(mainViewport, mainW, mainH)`; those two
  model points are then **projected through the overview's OWN fit viewport** with
  `toScreen` and stroked (`--overview-indicator-color/-width`). `render()` leaves
  the transform at `(dpr,0,0,dpr,0,0)`, so the rect is stroked in CSS px on top of
  the painted scene.
  Because the overview shares the main view's MODEL SPACE in each mode (footprint ↔
  footprint, strip ↔ strip), the **current-view indicator is meaningful in BOTH views**
  and is always drawn (no `showViewportRect` gate anymore).
- **Draggable anchoring.** Mirrors `MiniWindow`: a `pos` state switches from the
  CSS bottom-left anchor to explicit `left/top` once the drag strip is dragged
  (pointer capture, clamped to the stage via `stageRef={wrapRef}`, re-clamped on
  stage shrink). Default placement is **bottom-left, lifted ABOVE the
  `.tool-controls` row** (Floor plate / Subtractive / Additive) via
  `--overview-offset-bottom = calc(--space-3 + --control-height + --space-2)`, so it
  never collides with those buttons at rest and — living inside `.canvas-wrap` — is
  naturally clear of the left panel.
- **No text label.** The old "Overview" title was removed; the title bar is now a
  slim, label-less **drag-handle strip** with a centered grip bar (`.overview__titlebar::before`),
  still the move affordance (`cursor: move`).
- **Degenerate handling.** Degenerate perimeters (<2 vertices) — and an empty unravel
  strip — rely on `fitViewport`'s epsilon flooring and simply draw an empty neutral
  box (no crash, no NaN).
- **Prop contract:** `perimeter`, `viewport` (main), `mainSize {w,h}` (main canvas
  CSS px), `gridSpacing`, `unravelOn`, `unravelDraws`, `stageRef`.
- **New CSS token section** (`styles.css`, `=== OVERVIEW MAP ===`):
  `--overview-width`, `--overview-canvas-height`, `--overview-bg/-border/-shadow`,
  `--overview-titlebar-bg`, the grip tokens `--overview-grip-color/-height/-width/-thickness`,
  `--overview-canvas-bg`, `--overview-padding` (fit padding, read by the component),
  `--overview-indicator-color`, `--overview-indicator-width`, and the default anchor
  offsets `--overview-offset-left` / `--overview-offset-bottom`. The colour/surface
  tokens reuse the `--mini-*` family and `--color-accent-warm`, all of which already
  have dark-theme overrides, so no overview-specific dark tokens are needed.

## Unwrap / unravel (elevation strip)

The **Unwrap** panel section (*Unravel ⟳ (CW)* button) "unrolls" the perimeter:
each edge is laid out as a **rectangle ("space"/panel) standing on the baseline
(model y = 0)**, in **clockwise** order, separated by an adjustable **Gap**. This
is the facade use-case — a footprint's walls unrolled flat into an elevation strip
of panels.

- **Each edge becomes a rectangle.** Its **WIDTH = the edge's true length and is
  UNCHANGEABLE** — it is derived from geometry only (`UnravelSegment.length`,
  `x1 - x0`); there is no control that can change it. Its **HEIGHT is PER-PANEL
  (individual)** — see "Per-panel heights" below. The rectangle spans the baseline
  (y = 0) up to y = its own height.
  - **Height default + unit.** The DEFAULT (the **Height** input) = `DEFAULT_WALL_HEIGHT_FT`
    (10), **imported from `core/extrude3d.ts`** so the unwrap and the 3D massing
    agree (1 model unit = 1 foot). Min 0.5u, integer step.
- **Gap default = 10** (`unravelGap` fixed constant).

#### Per-panel heights (each rectangle sized individually)

Heights are **per-panel**. A global DEFAULT (`unravelHeight`, default 10) seeds
panels that haven't been individually changed; per-panel overrides live in
`unravelHeights: Record<number, number>` in `PolylineTool`, **keyed by the
ORIGINAL edge index** (`UnravelSegment.index`, stable across order/gap). A panel's
**effective height = `unravelHeights[index] ?? unravelHeight`** (the
`effectiveHeight` callback). Stale keys for edges that no longer exist are ignored;
new edges fall back to the default.

Three ways to set a panel's height:

1. **Drag the rectangle's TOP edge.** Hit-test (`hitUnravelTop`): cursor x within
   `[x0,x1]` (±tol) AND model-y within `TOP_EDGE_TOLERANCE_PX` (6px, via
   `pixelsToModel`) of that panel's effective height. While hovering a top edge the
   canvas shows an **`ns-resize`** cursor (the `canvas--ns-resize` class, toggled by
   `unravelOn && hoveredUnravelTop >= 0`) and the top edge is redrawn emphasised
   (`--unravel-top-width`). A new `dragRef` kind **`unravelHeight` (carries `edge`)**
   is started on press; on move the panel's height is set to the cursor's raw
   model-y, clamped via `clampHeight` (≥0.5, grid-snapped when Snap is on). The
   top-edge resize **takes precedence** over the body hover-highlight near the top.
2. **Type in the on-rectangle input** (DOM overlay, below).
3. **Edit the global Height input** — sets the default AND **clears all per-panel
   overrides** (a "make them all uniform" action). Documented in its tooltip.

#### DOM-input overlay synced to the canvas (new pattern)

Per-panel heights are editable via a **DOM overlay** (`.unravel-overlay`
containing one `.unravel-input` `<input type=number>` per rectangle), NOT
canvas-drawn text. Each input is **absolutely positioned** by converting its
rectangle's left edge at vertical-mid to screen with `toScreen(viewport, {x: x0,
y: height/2})`; CSS `transform: translate(-50%,-50%) rotate(-90deg) translateY(…)`
parks it just **OUTSIDE** the left edge, vertically centred, and **rotated 90°** so
the number reads bottom-to-top (it represents the panel's vertical height).

The field is styled to **VISUALLY MATCH the canvas-drawn WIDTH length-label** above
each panel — it is the vertical (height) counterpart to that horizontal (width)
label, and both sit **outside** the rectangle as bare dimensions:
- **Outside the panel** — parked left of the rectangle (anchor at `x0`, pushed out
  by the trailing `translateY`), never overlapping the rectangle body. Because the
  panel body sits to the RIGHT of the `x0` anchor and `rotate(-90deg)` maps the
  field's local +Y to screen +X (right, into the panel), the `translateY` offset is
  **NEGATIVE** so the box moves screen-LEFT, outside the left border. Its magnitude
  is `half the field's CROSS axis + --unravel-label-gap`. The cross axis is the new
  `--unravel-input-thickness` token (16px) — **not** the 52px `--unravel-input-width`:
  after `rotate(-90deg)` it is the box HEIGHT (thickness) that runs along screen-X
  and governs the border distance, while the 52px width becomes the vertical typing
  run. The field's `height`/`line-height` are pinned to that thickness so the glyphs
  fill it and the number's near edge lands exactly `--unravel-label-gap` from the
  border. Thickness is matched to the canvas WIDTH label's plate height (16px), so the
  X (width) and Y (height) dimension numbers read at the **SAME thickness, sit the
  SAME gap outside their borders, and shift identically when zooming**. (Earlier the
  offset used `--unravel-input-width/2`, which is the wrong, much larger axis — the
  number floated ~30px out instead of ~4px; and before that a positive offset pushed
  it onto the panel. Both fixed.) `--unravel-label-gap` (root token) is the single
  shared source for that gap: the `.unravel-input` transform uses it here, and
  `core/renderer.ts` reads it (via `cssNum`) in `drawUnravel` to offset the width
  label (`topL.y - gap`), keeping the two dimension labels visually consistent.
- **No border** (borderless; `outline: none` on focus too).
- **No infill / no background** — `background: none`, so it reads as plain text like
  the width label (the old `--unravel-input-bg` wash token was removed, light + dark).
- **No spinner chevrons** — the `type=number` up/down arrows are hidden via CSS
  (`::-webkit-inner/outer-spin-button { -webkit-appearance: none }` + Firefox
  `appearance: textfield`). The input stays `type=number`; the numeric commit logic
  (`parseFloat` in `commitPanelInput`) is unchanged.
- **Matched type treatment** — uses the canvas label tokens (`font: var(--label-font)`,
  `color: var(--unravel-input-text)` which now follows `--label-text`) so the two
  read alike.

Because `viewport` is React state and the component re-renders on pan/zoom/resize,
the inputs **track the canvas** automatically (same triggers as `paint`). The
container is `pointer-events: none` so only the inputs capture events — canvas
pan/zoom elsewhere is unaffected. Typing updates a local draft (`unravelInputDraft`,
keyed by edge) so clamping doesn't fight mid-edit; **Enter/blur commits** (clamp
into `unravelHeights`, drop draft), **Esc cancels**. **Drag-to-stretch still live-
updates** the displayed value: a top-edge drag sets `unravelHeights[edge]`, which
re-renders the field's `value` from the resolved `height` (no draft active during a
drag). The overlay only mounts while `unravelOn` (auto cleanup on exit). This
DOM-overlay-synced-to-canvas pattern is new to the app.

#### Zoom to a panel + split into cells

- **Double-click a panel** → the viewport fits that single rectangle to fill the
  screen (`zoomToPanel` → `fitViewport(unravelBoundsPerimeter([seg], …), 56px margin)`).
  **Esc** exits the zoom (refits the whole strip) and `focusedPanel` is cleared.
- The zoom-in (and Esc zoom-out, plus the unravel-on / gap / height re-fits) is
  **animated**, not a jump: `animateViewport` tweens the viewport over ~280ms with a
  cubic ease-in-out (`easeInOut` in `viewport.ts`). It's **focal-anchored** —
  `lerpViewportFocal` interpolates scale geometrically (log-space, constant-rate zoom)
  while easing the target-centre's on-screen position, so the focus doesn't drift.
  The tween runs on `requestAnimationFrame`, snaps trivial moves instantly, and is
  cancelled (`cancelAnim`) the moment the user pans/drags (pointer-down) or wheel-zooms,
  and on unmount, so it never fights manual input.
- **Right-click a panel** → a `.cell-menu` context menu (DOM overlay positioned in
  canvas-wrap px) to split the panel into **N equal-width vertical cells** (facade
  bays): presets 1/2/3/4/6/8 + a custom count. Cell counts are **per-panel**,
  stored in `unravelCells: Record<edgeIndex, number>` (default 1 = no split), so
  they're stable across order/gap like heights. The menu is dismissed by Esc or any
  canvas press.
- The renderer draws `N-1` division lines inside each rectangle. `UnravelDraw` now
  carries `cells`; new token `--unravel-cell-color` (light + dark). The split is a
  pure visual subdivision — it does not change the perimeter geometry.

#### Renderer + fit changes for per-panel heights

- `RenderState.unravel` is now `UnravelDraw[]` (`{ seg: UnravelSegment; height:
  number; cells: number }`) — each segment paired with its RESOLVED height and
  cell-split count — replacing the old single `unravelHeight` field. `drawUnravel`
  draws each rectangle at its own height and adds its cell divisions;
  `RenderState.hoveredUnravelTop` drives the emphasised top edge. The renderer
  stays height-policy-agnostic (the input layer resolves heights/cells).
- `unravelBoundsPerimeter(segments, height)` now accepts `height` as a number OR a
  `(seg) => number` function; `fitUnravel` passes a per-segment `heightOf` so the
  fit frames the **TALLEST** panel (nothing clipped). Refit on entering unravel and
  on gap/global-height change; an individual top-edge drag or input edit does NOT
  force a refit (the user is actively sizing).
- **New CSS tokens** (`styles.css`, light + dark where colour-bearing):
  `--unravel-top-width` (emphasised hovered top edge, root token), and the height
  input overlay `--unravel-input-text` (root; follows `--label-text`) and
  `--unravel-input-width` (root). The field is borderless AND infill-free and reuses
  the canvas `--label-font`/`--label-text` tokens to match the width label, so there
  is no `--unravel-input-border` and no `--unravel-input-bg` token (the latter was
  removed, light + dark). `--unravel-label-gap` (root) is the SHARED border-to-label
  gap: the `.unravel-input` transform uses it (left of each panel) and `renderer.ts`
  reads it for the width label (above each panel), so both dimensions sit the same
  distance outside their borders.
- **Length (width) is preserved exactly.** Straight edges use their chord length;
  curved (Bézier) edges use their true **arc length** (computed by summing the
  flattened curve), so a curved wall unrolls to a rectangle of the same running
  width. Curved-origin rectangles are drawn **dashed/tinted** to flag the
  difference.
- **Clockwise ordering**: orientation is detected from the signed area of the
  flattened outline (model +Y up ⇒ positive area = CCW); a CCW shape's edge list
  is reversed so the layout proceeds clockwise. Open polylines have no winding, so
  edges are taken in draw order.
- Entering the view **fits** the strip to the canvas (reuses `fitViewport`); the
  strip is centred on the origin. **Fit accounts for the rectangle TOPS** (the
  per-panel heights), not just the baseline, so the TALLEST panel is framed and
  nothing is clipped — `unravelBoundsPerimeter` takes a per-segment `heightOf`. It
  **refits on Gap and global-Height change** (not on individual top-edge drags /
  input edits — the user is actively sizing). It allows left-click ONLY for the
  top-edge height resize (no drawing/editing); pan with middle-drag and wheel-zoom
  still work. Exit restores normal editing. The panel shows segment count, total
  unwrapped length, and **total area (Σ length × effective height)**.

Architecture: the unwrap math is a pure module, `core/unravel.ts`
(`unravelPerimeter`, `unravelBoundsPerimeter(segments, heightOf)`), returning
model-space segments; `renderer.ts` draws the rectangles via the optional
`unravel` field on `RenderState`, now an **`UnravelDraw[]`** (`{ seg, height }`)
carrying each panel's resolved per-panel height (it hides the shape and draws the
rectangles instead). `drawUnravel` draws each rectangle filled
(`--unravel-rect-fill`) + stroked (existing line/curve tokens), from y = 0 to its
own height; the **WIDTH stays purely geometric** (segment length). No
geometry/drawing is duplicated. State lives in `PolylineTool` as `unravelHeight`
(global default, `DEFAULT_WALL_HEIGHT_FT`) plus `unravelHeights` (per-edge
overrides) — see "Per-panel heights" above.

### Hover-link the strips to the preview

While unravelling, **hovering an unwrapped strip on the main canvas highlights
the corresponding edge** of the shape in the mini-window thumbnail, and
highlights that same strip on the main canvas — so it's obvious which wall a
strip came from. The link is by **edge index** (`UnravelSegment.index`, the
original edge in the source perimeter).

- **Hit-testing** (input layer, `PolylineTool.onPointerMove`): the strips are
  horizontal at model `y = 0` from `x0→x1`. A strip is hovered when the cursor's
  `|y|` is within a screen-pixel tolerance (`HIT_TOLERANCE_PX`, converted to model
  units via `pixelsToModel`) and its `x` falls inside `[min(x0,x1), max(x0,x1)]`
  (± tolerance). The matched `index` is stored in `hoveredUnravelEdge` (-1 = none),
  cleared on pointer-leave and on exiting unravel.
- **Main-canvas feedback** (`RenderState.hoveredUnravelEdge`): the unravel branch
  draws the matching **rectangle** in the highlight fill (`--unravel-highlight-fill`)
  with a highlight-colour, thicker outline. Hit-testing now matches the rectangle
  AREA (cursor inside the segment's `x` span AND `y` in 0..height, with tolerance),
  so hovering anywhere over a rectangle lights it up and the linked mini-window wall.
- **Mini-window** (`RenderState.highlightEdge`): the renderer's normal branch
  re-draws ONE edge on top of the normal stroke in the highlight colour/width,
  reusing `isCurved`/`segmentCubic`/`toScreen` (so curved edges highlight along
  their curve). `MiniWindow` threads `highlightEdge` through to `Thumb`, whose
  repaint effect depends on it.
- **Which thumbnail:** only the **currently loaded entry** (`activeSavedId`) gets
  the highlight, because the live-shape edge index only maps onto a thumbnail
  whose geometry matches. **If nothing is loaded/active, nothing is highlighted in
  the mini-window** (the strip on the main canvas still highlights, so the hover
  feedback is never lost). This was the simple, predictable choice over pinning a
  live preview into the mini-window.

#### Perimeter-mode edge hover → highlighted edge LINE (not a wall panel)

The same hover-link now also works in **perimeter (edit) mode**: hovering a
**footprint edge** on the main canvas highlights the **corresponding edge LINE**
on the active thumbnail — deliberately a single line on the footprint, *not* a
filled wall panel (that panel fill is reserved for the unravel-strip hover above).

- **Hit-testing** (`PolylineTool.onPointerMove`, edit branch): reuses the existing
  `hitSegment` already run for the vertex-insert preview; its `index` is stored in
  `hoveredEdge` (-1 = none). Cleared over a vertex, on pointer-leave, and on
  entering unravel. The mini-window receives `highlightEdge = unravelOn ?
  hoveredUnravelEdge : (mode === "edit" ? hoveredEdge : -1)`.
- **Line vs panel** is selected by a new `highlightAsLine` flag threaded
  `PolylineTool → MiniWindow → Thumb → render3d` (true in perimeter mode = `!unravelOn`).
  In `extrude3d.render3d`, line mode leaves the highlighted wall's fill normal and,
  **after** the depth-sorted face pass, overlays the **base (z = 0) segments** of
  every sub-quad carrying that edge index — so a curved edge highlights along its
  whole curve. Drawn last (on top) with `--m3d-highlight-stroke`, one px heavier
  than the panel highlight so the single line reads clearly. Panel mode (unravel)
  is unchanged: the matching wall face is filled in the highlight token.
- New CSS tokens (`styles.css`, light + dark): `--unravel-highlight-color` and
  `--highlight-width`. The mini-window was also enlarged (`--mini-width` 200→300px,
  `--mini-thumb-height` 84→130px) so a highlighted edge is clearly visible.

### Unravel rectangle tokens (added with the rectangle feature)

New unravel tokens (`styles.css`, light + dark, in the unravel group):
`--unravel-rect-fill` (rectangle/space fill) and `--unravel-highlight-fill`
(hovered rectangle fill). The rectangle OUTLINE reuses the existing
`--unravel-line-color` / `--unravel-curve-color` (curved = dashed) and
`--unravel-highlight-color` (hover). The end-tick + endpoint-dot drawing was
dropped (the rectangle edges read as the boundaries), so the `--unravel-tick-color`
token was removed as unused.

## Construction-plane axes removed + grid default-off

- The big "+" **origin axis lines** drawn through (0,0) on the main canvas were
  removed: `renderer.ts` no longer calls/defines `drawAxes`, and the now-unused
  `--axis-color` token was deleted (light + dark). The **grid** drawing is intact;
  only the two axis lines went. The insertion-preview "+" (`drawPlus`) is unrelated
  and unchanged.
- The **grid is now OFF by default** (`showGrid` initial state `false` in
  `PolylineTool`); the *Show grid* checkbox still toggles it on.
  - **Update:** the grid is now NEVER drawn. The *Show grid* and *Snap to grid*
    checkboxes were removed; the entire grid-display path (`showGrid` state +
    render field, the `drawGrid` function, and the `--grid-*` CSS tokens) is gone.
    Snap-to-grid is permanently on (`snapEnabled` is a `const true`), and
    `gridSpacing` survives because it still drives the snap rounding.

## Floor plates (horizontal level lines)

A **"floor plate"** button floats at the **bottom-left of the canvas**
(`.floorplate-btn`, absolutely positioned in `.canvas-wrap`). Clicking it **arms**
a placement tool (`floorPlateMode`); the button highlights (`.is-active`) while armed.

- **Preview** — while armed, a **ghosted dotted horizontal line** tracks the
  cursor's elevation across the full canvas width (`RenderState.floorPlatePreview`
  = the cursor's model-Y; drawn in `--floorplate-ghost-color`).
- **Place / remove** — a left-click on the canvas drops a floor plate at that
  elevation (snapped to grid when snap is on); clicking on an existing plate (within
  `HIT_TOLERANCE_PX`) removes it. **Place as many as wanted** — the tool stays armed.
  **Esc** (or re-clicking the button) disarms it.
- **Intelligent floor-to-floor increment snap.** Once the user has placed their
  FIRST plate ABOVE the ground (the smallest strictly-positive elevation in
  `floorPlates` — the ground `0` plate is always present), that elevation becomes a
  floor-to-floor INCREMENT. Subsequent placements AND the live ghost preview
  MAGNETICALLY snap to the nearest NON-NEGATIVE multiple of that increment when the
  cursor is within `FLOORPLATE_SNAP_PX` (12px, converted to model units via
  `pixelsToModel`) of it; otherwise they fall back to the fixed 1 ft grid snap. The
  increment is RE-DERIVED from `floorPlates` state every time (not captured), so it
  stays correct across undo/redo and plate deletion. With only the ground plate
  present there is no increment and placement is plain grid snap as before.
  - **`shiftHeld` toggles it OFF** — holding **Shift** bypasses the increment magnet
    entirely (free / grid-only placement) so an off-rhythm plate can be dropped.
  - **One shared helper** — `snapFloorPlateY(rawY)` (reads `floorPlates`, `shiftHeld`,
    `viewport`, plus the fixed `snapEnabled`/`gridSpacing`) is used by BOTH the
    placement (`onPointerDown`) and the preview (`paint`'s `floorPlatePreview`), so the
    ghost line, its elevation label, and the committed plate can never drift apart. It
    is in the dep arrays of both `onPointerDown` and `paint`. Removal-by-click still
    takes precedence (clicking within tolerance of an existing plate deletes it).
- **Model-space, not screen-space** — plates are stored as **model-Y elevations**
  (`floorPlates: number[]`, kept sorted), so they **pan/zoom with the scene** like a
  real building level rather than drifting in screen pixels. Drawn in **both** the
  normal and unravel views (on top), via `drawFloorPlates` in `renderer.ts`.
- **Height labels — UNRAVEL view only.** Each floor-plate line (and the live ghost
  preview while placing) is labelled with its **height**, but ONLY in the unravel
  view, where the unrolled panels stand on a meaningful ground datum. The **datum is
  the panel baseline at model y = 0 — the ground floor, height 0** — so a plate's
  marker value is simply its model-Y elevation, formatted to match the existing
  dimension labels (`toFixed(2)`, bare number). Markers are parked **off to the LEFT
  of the unravelled strip**, right-aligned and vertically centred on their line, so
  they never clash with the panels or their width/height dimension labels. The
  renderer computes the **leftmost panel edge** in model-x (`min` over all
  `state.unravel` draws of `min(seg.x0, seg.x1)`), converts it to screen, and draws
  each label so its right edge sits `--floorplate-label-gap` px left of that edge.
  In the **normal (shape) view the plates are unlabelled** (no ground datum):
  `drawFloorPlates` takes an optional leftmost-model-x argument that is passed ONLY
  from the unravel branch; absent ⇒ lines only (prior behaviour).
- **New token** (`styles.css`, root, FLOOR PLATES group): `--floorplate-label-gap`
  (px gap between the strip's left edge and the right edge of a height marker —
  independently tunable from `--unravel-label-gap`). Marker text/background/font
  reuse the shared canvas label tokens (`--label-text`, `--label-bg`,
  `--label-font`), so the elevation markers read like the other dimension labels.
- **Undoable** — placing/removing a plate is one undo step; `floorPlates` is part of
  the `DocSnapshot` (alongside perimeter / heights / cells) and restored by `applyDoc`.
  **Reset** clears plates and disarms the tool.
- **Ground plate auto-placed on entering the elevation view** — toggling INTO the
  unravel/elevation view (`toggleUnravel`, `next === true`) guarantees a floor plate
  at the **ground datum (model y = 0, level 0)** exists, so the user starts with the
  ground line drawn. A `setFloorPlates` functional update adds `0` only if no ~0 plate
  is already present (epsilon `1e-6` guards against float-dupes), then re-sorts
  bottom→top to match the click handler's convention. Like the other view-state resets
  in `toggleUnravel` (`setSelectedVertex(-1)` etc.), this is **NOT a separate history
  step** — toggling the view is itself a view action. It is not removed on exit.
- **Ground plate is a HARD INVARIANT while in the unravel view.** `toggleUnravel` only
  guarantees the ground plate on ENTRY; several other paths replace `floorPlates`
  without it — `loadSavedEntry` (`setFloorPlates([...(s.floorPlates ?? [])])`, esp.
  older saves whose snapshot predates the datum), `applyDoc` (undo/redo restoring a
  pre-ground `DocSnapshot`), and click-removal near `y = 0`. This caused the 0′ line to
  "sometimes appear and sometimes not". A dedicated **`useEffect` on `[unravelOn,
  floorPlates]`** now re-asserts the datum across ALL of them: when `unravelOn` and no
  `floorPlates` entry satisfies `Math.abs(p) <= 1e-6`, it appends `0` (re-sorted
  bottom→top). It is **NOT a history step** (mirrors the `toggleUnravel` insert — view
  scaffolding, not an authored edit) and **cannot loop**: it only adds when missing and
  returns the SAME array reference when a ~0 plate is present, so React bails. Interplay
  with auto-save is safe: after a load the guard adds `0`, the auto-save effect persists
  it into the active entry, and that effect's JSON no-op guard then sees the stored and
  live `floorPlates` equal and stops (no write loop).
- **Ground plate is protected from click-removal.** The `onPointerDown` removal branch
  skips deletion when the hit plate is the ground datum (`Math.abs(plates[hit]) <= 1e-6`)
  — a click at/near the baseline is a no-op rather than deleting the 0′ line. Removal
  still works for every above-ground plate. (`snapFloorPlateY`'s increment magnet reads
  only strictly-positive plates via `p > 1e-6`, so keeping `0` present never corrupts the
  floor-to-floor increment.)
- **Bug fix — intermittent floor-plate clicks.** The `onPointerDown` `useCallback` was
  missing `floorPlateMode`, `snapEnabled`, `gridSpacing`, and `cancelAnim` from its
  dependency array even though the floor-plate branch reads all of them. The memoized
  handler kept a **stale closure** (`floorPlateMode === false`) after arming the tool,
  so left-clicks fell through to draw/edit until an unrelated dep change (e.g. a
  pan/zoom updating `viewport`) happened to rebuild the callback — making placement work
  only "sometimes". Adding those four deps makes the handler always close over current
  state. (`onPointerMove`, `paint`, and the keyboard effect already carry every
  floor-plate value they read, so no other stale-closure hazards of this kind remain.)
- **CSS tokens** (`styles.css`, root): `--floorplate-color` (placed line),
  `--floorplate-ghost-color` (preview), `--floorplate-width`, `--floorplate-dash`,
  `--floorplate-dash-gap` (dash pattern), and `--floorplate-label-gap` (left-of-strip
  height-marker gap, unravel view only). The button styling lives in `.floorplate-btn`
  and reuses the control tokens (`--control-*`, `--mini-shadow`, accent when active).

## Additive / Subtractive buttons (panel-selection gated)

Two buttons — **Subtractive** and **Additive** (in that left-to-right order) — float
at the **bottom-left of the canvas, next to the Floor plate button** (`.subtractive-btn`
/ `.additive-btn`, siblings of `.floorplate-btn` in `.tool-controls`, mirroring its
style). They are the entry points for per-panel operations in the unravel/elevation
view. **Subtractive** is implemented (the panel-division tool, below); **Additive** is
still a TODO stub.

- **Gated on a selected panel.** Both buttons are **DISABLED by default** and become
  enabled only while a panel is **SELECTED via double-click** in the unravel view —
  i.e. `hasSelectedPanel = unravelOn && focusedPanel !== null`.
- **Selection state reuses `focusedPanel`** (no new state added). Double-clicking a
  panel already sets `focusedPanel` (via `onDoubleClick` → `zoomToPanel`) and zooms
  to it; Esc and leaving the unravel view clear it (`setFocusedPanel(null)`). That
  lifecycle — single edge index, set on dblclick, cleared on Esc / view-exit — is
  exactly the "selected panel" semantics needed, so `focusedPanel` doubles as the
  Additive/Subtractive target. (A dedicated `selectedPanel` would have duplicated
  this with identical set/clear points.)
- **Selected panel's dimension labels turn floor-plate grey.** When a panel is
  selected, BOTH its dimension labels recolour to the same faint grey as the
  floor-plate elevation labels (`--floorplate-color`, the renderer's `tk.floorPlate`):
  - **WIDTH label (canvas-drawn):** `RenderState` gained a `selectedUnravelPanel`
    field (fed `focusedPanel ?? -1` in `paint`); the unravel branch threads it into
    `drawUnravel`, which passes `tk.floorPlate` as an optional `color` arg to
    `drawCenteredLabel` for the matching panel (the function now takes an optional
    `color` overriding `--label-text`). `paint`'s dep array gained `focusedPanel`.
  - **HEIGHT field (DOM `.unravel-input` overlay):** the selected panel's input gets
    an `.is-selected` class whose CSS sets `color: var(--floorplate-color)`, matching
    the recoloured width label.
- **Additive — TODO stub.** `onAdditive` is a clearly-commented no-op (guard on
  `focusedPanel !== null`, then a TODO). When implemented it should operate on
  `focusedPanel` and wrap the change in `recordHistory()` for a single undo step.
- **Subtractive — the panel-division tool** (see next section). `onSubtractive`
  toggles an armed mode (`subtractiveOn`) rather than performing a one-shot op.

### Subtractive: EQUAL-COLUMN panel splits (iteration recommendations)

Clicking **Subtractive** (only enabled with a panel selected) **arms** a division
tool scoped to the selected panel (`subtractiveOn`; the button shows `.is-active`).
Its recommendations are **even subdivisions** — N equal-width columns — NOT
grid-snapped lines.

- **Hover recommendation.** While armed, moving over the selected panel recommends an
  **equal-column split**: the cursor's distance from the panel's LEFT border is read as
  the desired column width, and N = `round(panelWidth / desired)` (clamped to
  `[2, MAX_EQUAL_COLUMNS]`) is the nearest iteration that divides evenly. The preview
  shows ALL `N−1` division lines at `x0 + i·(panelWidth/N)`. Moving the cursor changes
  the iteration (fewer/wider ↔ more/narrower columns). We store the raw cursor model-x
  in `divideHoverX` (NO grid snap); the render builder turns it into the lines + the
  width dimension. Drawn as faint ghosts (`--unravel-divide-preview-color`, light + dark).
- **Click commits the even split.** Pointer-down (and optional drag, which just re-picks
  the iteration) previews the equal columns; release commits all `N−1` lines. The pure
  generator is `buildEqualColumns(cursorX, x0, x1)` in `core/unravel.ts`, used by BOTH
  the live preview and the commit so they always agree. Positions are exact multiples of
  `panelWidth/N`, so the columns are perfectly equal (not grid-aligned).
- **Live width dimension.** While previewing, a horizontal **measure line** spans the
  column under the cursor at the cursor's height, with end ticks and a `fmtFeetPrime`
  label = the equal column width (`panelWidth/N`), so the user sees the resulting panel
  width. Carried on `RenderState.dividePreview.dim` and drawn by `drawUnravel` in the
  accent highlight colour; tick half-length is `--unravel-dim-tick`.
- **Storage = per-panel OFFSETS.** Committed lines live in `panelDivisions:
  Record<edgeIndex, number[]>`, each value a list of OFFSETS in model units from the
  panel's left edge `seg.x0` (robust to the strip re-centring when the perimeter
  changes). `commitDivisions` merges new lines with existing, de-dups at ~0.01 ft,
  sorts, in one `recordHistory()` undo step.
- **Rendering.** `UnravelDraw` gained `divisions?: number[]`; `drawUnravel` draws each
  committed line solid in `--unravel-cell-color` (same as equal cell-splits), then a
  faint preview for the active edge from `RenderState.dividePreview` (the active drag's
  equal-column lines, else the hover recommendation computed from `divideHoverX`).
- **Input integration.** A `dragRef` kind `"divide"` carries `{ edge }`.
  The unravel `onPointerDown`/`onPointerMove` branches check `subtractiveOn` FIRST so
  the tool owns clicks (no height-resize / deselect / double-click-zoom interference).
  Esc disarms the tool (first press) before exiting the panel zoom; an effect also
  disarms it if the selection or the unravel view is lost.
- **Double-click-outside backs out a layer (the layer principle, in reverse).** The
  app's core principle is that double-clicking INTO an area goes "a layer deeper"
  (double-click a panel → select + zoom it). So double-click should also work in
  reverse: while the Subtractive tool is armed, a double-click OUTSIDE the selected
  panel (`edge !== focusedPanel` — empty area OR a different panel) **unequips the
  tool** (`setSubtractiveOn(false)` + clears the `divideHoverX`/`divideDraft` preview),
  backing out one layer. Then, if the double-click landed on a DIFFERENT panel, it
  selects + zooms that panel (`zoomToPanel`) so the gesture still goes a layer deeper
  into the newly-clicked panel (the user re-arms Subtractive there); if it landed on
  empty area it just unequips and stays on the currently-selected panel's layer (no
  zoom — the buttons remain enabled for that panel). A double-click INSIDE the selected
  panel (`edge === focusedPanel`) is left untouched: it's just two equal-split
  placements handled by the click handlers, so `onDoubleClick` returns without
  re-zooming. The branch is structured on the LOCAL `subtractiveOn` closure value +
  `edge` + `focusedPanel` with explicit `return`s (React's `setSubtractiveOn` doesn't
  update the local within the same handler call). Additive has no armed state today, so
  there is nothing to unequip for it — the same back-out would apply to a future
  Additive armed mode.
- **Persistence + undo.** `panelDivisions` is a full member of `DocSnapshot` (undo/redo
  via `applyDoc`) AND `SavedElevationState` (auto-save / load round-trip), alongside
  heights/cells/floor plates — so divisions persist to the loaded project and replay
  through history like every other authored field. Nested arrays are copied
  element-wise in `cloneElevationState` and on load.
- **New CSS** (`styles.css`, `=== ADDITIVE / SUBTRACTIVE ===`): tokens `--addsub-gap`,
  `--floorplate-btn-w`, `--addsub-btn-w` (running-offset layout so the trio of
  bottom-left buttons spaces from tokens), classes `.additive-btn` / `.subtractive-btn`
  (mirror `.floorplate-btn`, with the same dimmed `:disabled` + neutralised hover
  pattern), and `.unravel-input.is-selected` (height field recolour to
  `--floorplate-color`).

### Subtractive: HOLD SHIFT to flip the split to HORIZONTAL rows

While the Subtractive tool is armed, **holding Shift flips the division array from
VERTICAL columns to HORIZONTAL rows** — instead of splitting the selected panel into
equal-width COLUMNS it splits it into equal-height ROWS. Everything else behaves
identically (same recommend-an-even-split hover, same live dimension, same click/drag
commit, same persistence/undo), just rotated 90°. Releasing Shift returns to columns.
The render builder depends on `shiftHeld`, so toggling Shift repaints the preview axis
live. (Shift's other meanings are not active here: the draw-mode 45° angle lock only
applies while `drawing`, and the floor-plate snap bypass only in floor-plate mode — both
separate from the armed-subtractive unravel context. The status bar swaps its `45° lock`
chip for a `Rows` chip while `subtractiveOn`.)

- **Pure generator.** `buildEqualRows(cursorY, y0, y1)` in `core/unravel.ts` mirrors
  `buildEqualColumns` on the Y axis: the desired row height is the cursor's distance
  above the BASELINE (`cursorY − y0`, where `y0 = 0` and `y1 = panelHeight`),
  `N = round(panelHeight / desired)` clamped to `[2, MAX_EQUAL_COLUMNS]` (same cap), and
  it returns the `N−1` positions `y0 + i·(panelHeight/N)`. Pure; used by BOTH the live
  preview and the commit so they always agree.
- **Committed store = `panelDividersH`.** A parallel per-edge store of HORIZONTAL divider
  OFFSETS in model-Y from the baseline (`Record<edgeIndex, number[]>`), the mirror of
  `panelDivisions`. It is threaded through EVERY place `panelDivisions` is — `DocSnapshot`
  (+ `docRef` init/assign + `applyDoc`), `SavedElevationState`/`SavedPerimeter` +
  `cloneElevationState` (element-wise nested-array copy) + `makeSavedPerimeter` +
  `loadSaved` (default `{}`), `currentElevation`, `loadSavedEntry`, the auto-save effect
  (no-op compare + written object + dep array), and `unravelDraws` — so horizontal
  dividers persist + undo/redo round-trip EXACTLY like vertical ones.
- **Rendering.** `UnravelDraw` gained `dividersH?: number[]`; `drawUnravel` draws each
  committed offset as a HORIZONTAL line spanning `seg.x0 → seg.x1` at that model-y, in
  `--unravel-cell-color` (same styling as the vertical divisions), and respects
  `boundariesOnly` (hidden in the overview, like the vertical divisions/cells).
- **Generalized `dim` + `dividePreview`.** `RenderState.dividePreview` now carries an
  optional `ys?` (horizontal preview lines, model-y) alongside the existing optional
  `xs?`, and `dim` is generalized from `{ ax; bx; y; dist }` to an arbitrary SEGMENT
  `{ x1; y1; x2; y2; dist }` (model coords). For columns it is a HORIZONTAL measure
  segment (column width); for rows a VERTICAL measure segment (row height). `drawUnravel`
  strokes `xs` as vertical ghosts AND `ys` as horizontal ghosts (whichever is present),
  and draws the generalized `dim` with perpendicular end ticks + a centred
  `fmtFeetPrime(dist)` label (above a horizontal measure line, centred on a vertical one).
- **Shift input wiring.** The hover branch now stores the whole raw cursor point in
  `divideHover: Point | null` (the render builder picks the axis by `shiftHeld`); the
  in-flight `divideDraft` is `{ edge; axis: "v" | "h"; lines }` so the drag and the commit
  know which axis they are on (axis is pinned at press time). `onPointerDown`/`onPointerMove`
  compute `buildEqualRows(cursorY, 0, panelHeight)` when horizontal else `buildEqualColumns`;
  `commitDividersH(edge, ys)` (offsets ARE the y-values since the baseline is 0) mirrors
  `commitDivisions` (merge, de-dup ~0.01 ft, sort, one `recordHistory()` step), and
  `onPointerUp` routes to the right commit by `divideDraft.axis`.

### Horizontal rows SNAP to floor plates crossing the panel

When floor plates pass through the selected panel, the horizontal (Shift) row array treats
each plate as a hard **guide an array line must land on**, rather than ignoring them. The
desired floor-plate behaviour: a designer who has placed floor lines wants the row courses to
align to those floors, with a course on every floor plate.

- **Generator change.** `buildEqualRows(cursorY, y0, y1, guides = [])` gained an optional
  `guides` argument — the floor-plate elevations (model-Y, same space as the panel baseline
  `y0 = 0`). Guides strictly INSIDE the panel (`> y0`, `< y1`, de-duped, sorted) become band
  boundaries. The panel is split into bands `[baseline, guide₁, … guideₖ, top]`; **each band is
  independently subdivided into equal rows** whose height best matches the cursor's desired
  height (`round(bandH / desired)`, ≥ 1 per band), and **each interior guide elevation is emitted
  as a division line** so a row line lands exactly on every floor plate. With no interior guide it
  falls back to the original single even split across the whole panel (`≥ 2` rows). Still pure;
  still used by both the live preview and the commit, so they agree.
- **Why per-band (not one global step).** A single uniform step anchored to one plate only lands
  on plates that happen to be integer multiples of that step; per-band subdivision guarantees a
  line on EVERY plate (plural) and keeps each floor-to-floor band's courses equal — the
  professional "even courses per floor" result. Rows can therefore be UNEQUAL across bands.
- **Call sites.** All three `buildEqualRows` calls (press in `onPointerDown`, drag in
  `onPointerMove`, hover preview in the paint builder) now pass the live `floorPlates` array;
  `floorPlates` was added to both pointer handlers' dependency arrays (the paint effect already
  depended on it) so the snap guides never go stale.
- **Dimension readout.** Because rows may now be unequal, the row `dim` is derived directly from
  the resulting `ys` (`bounds = [0, …ys, panelHeight]`, measure the band the cursor sits in)
  instead of assuming `panelHeight / N`. Columns are unaffected (no guides).
- **No new persistence.** The committed lines (including those on the plates) flow through the
  existing `panelDividersH` store / undo / auto-save unchanged. Floor plates remain their own
  store and keep drawing as floor-plate lines; the coincident divider just makes the alignment
  explicit in the data (and persists if the plate is later moved/removed).

## Eraser: delete panel division lines (Subtractive's destructive twin)

The **Eraser** button (third in the bottom-left cluster, **AFTER Additive** — order
now Subtractive · Additive · Eraser) is the destructive counterpart to Subtractive:
instead of CREATING division lines it **DELETES** them. It removes entries from the
existing `panelDivisions` (vertical) / `panelDividersH` (horizontal) stores — **no new
persistence fields** were added; it rides the same `DocSnapshot` undo/redo and
auto-save plumbing the Subtractive tool already established.

- **Armed exactly like Subtractive.** New `eraserOn` state, enabled only with a panel
  selected (`focusedPanel`, the double-click "layer deeper" selection). The button is
  DISABLED until a panel is selected and shows the same `is-active` armed style.
  `onEraser` toggles it; the three armed modes are **mutually exclusive** — arming the
  Eraser disarms Subtractive (and clears `divideHover`/`divideDraft`), and arming
  Subtractive disarms the Eraser (and clears its `eraseHover` highlight). Additive has
  no armed state, so nothing to clear there.
- **Hover targets the nearest line.** `eraseHover: { edge; axis: "v"|"h"; index } | null`
  holds the line currently targeted for deletion. `nearestEraseLine(m)` finds the
  closest vertical division (`panelDivisions`, x-offset from `seg.x0`) or horizontal
  divider (`panelDividersH`, y-value from the baseline) on the focused panel within
  `ERASE_SNAP_PX` (12px, converted to model units via `pixelsToModel` — the same
  snap-distance pattern as `FLOORPLATE_SNAP_PX`). `onPointerMove` sets `eraseHover` and
  clears the rectangle hover-link so they don't fight (mirrors the Subtractive branch).
- **Click deletes — one undo step.** `onPointerDown` calls `commitEraseLine(target)`
  which `recordHistory()` once then REPLACES the panel's offset array with the targeted
  index filtered out (`panelDivisions` for `"v"`, `panelDividersH` for `"h"`). Because
  the arrays are replaced (never mutated) the removal round-trips through undo/redo and
  auto-save with zero extra wiring. Deletion happens on press (no drag concept for a
  single-line erase).
- **Double-click out unequips (layer-back-out).** `onDoubleClick` mirrors the
  `subtractiveOn` logic exactly: a double-click INSIDE the selected panel is suppressed;
  OUTSIDE it unequips the Eraser — empty area keeps the panel selected, a DIFFERENT
  panel unequips then selects + zooms it (`zoomToPanel`). Esc also disarms it (same
  precedence as Subtractive). Two cleanup effects de-arm it if the selection is lost or
  the view is left while armed, and `onPointerLeave` drops the highlight.
- **Rendering.** `RenderState.eraseHighlight?: { edge; axis: "v"|"h"; offset }` carries
  the targeted line's resolved offset (the paint builder reads it from the live panel
  arrays by index). `drawUnravel` redraws that one committed line on top in the deletion
  colour + a heavier stroke so the user sees exactly what a click will remove. New CSS
  tokens (`styles.css`, light + dark where colour-bearing): `--unravel-erase-highlight-color`
  (the deletion-highlight line colour) and `--unravel-erase-highlight-width` (its stroke
  width, unitless / theme-independent). The Eraser button styling lives in `.eraser-btn`
  / `.eraser-btn.is-active`, sharing the `.additive-btn`/`.subtractive-btn` rules.

## UI refinements (panel title, floating history, Unravel colour)

Three small UI changes, all visual values kept in `src/styles.css`:

- **Removed the "Perimeter Tool" panel title.** The `<h1 className="panel__title">`
  was deleted from `PolylineTool.tsx`; the now-unused `.panel__title` CSS rule and
  the `--font-size-title` token (its only consumer) were removed so there's no dead
  CSS.
- **Undo / Redo now float at the top-left of the canvas**, outside (clear of) the
  left panel. The old `panel__section` holding them was removed from inside the
  `.panel` aside; the buttons render in a `<div className="history-controls">` that
  is a child of `.canvas-wrap` (right after the `<canvas>`, alongside the
  `.floorplate-btn`). New `=== FLOATING HISTORY (UNDO/REDO) CONTROLS ===` CSS
  section: `position: absolute` at `top/left: var(--space-3)`, `z-index: 50`, so it
  is anchored to the TOP-LEFT corner of the canvas-wrap — the same anchoring as the
  floor-plate button (which pins to the bottom-left). Because the cluster lives
  inside the canvas area, it sits just past the panel's right edge and never
  overlaps the panel's contents. The buttons are now their own
  **`.history-btn`** class (no longer piggybacking on `.btn`), styled to **match the
  floating `.floorplate-btn` exactly** — same `--control-*` tokens + `--mini-shadow`
  so they read as siblings of that button. They are **compact**: horizontal padding
  is `var(--space-2)` (tighter than the default `.btn`) with a small `var(--space-1)`
  inter-button gap, so each is sized snugly to its label and the pair sits as one
  tight corner cluster. A clear disabled state (`opacity: 0.4` + `not-allowed`
  cursor) keeps undo/redo availability visible. Behaviour/handlers/tooltips unchanged.
- **Unravel button is now blue in both states.** It always carries `btn--primary`
  (the blue accent); when `unravelOn` it adds `is-active`. A new
  `.btn--primary.is-active` rule gives the engaged toggle a darker/pressed look
  (`filter: brightness(0.82)` + inset shadow) so ON vs OFF is still distinguishable
  at a glance. No colour hardcoded inline.

## Controls help popup + floor-plate button gating

Three related UI changes (all visual values in `src/styles.css`):

- **Floor-plate button gated to the unravel view.** Floor plates only RENDER in
  the unravel/elevation view, so the `.floorplate-btn` is now `disabled` whenever
  `!unravelOn` (clear dimmed + `not-allowed` state via `.floorplate-btn:disabled`,
  mirroring `.history-btn:disabled`). Its tooltip explains why when disabled. An
  effect (`useEffect` on `[unravelOn, floorPlateMode]`) also **de-arms**
  `floorPlateMode` if the view is left while the tool is still armed, so it can't
  stay "on" in the draw-perimeter view.
- **"?" help button (bottom-right of the canvas).** A round `.help-btn` anchored
  to the bottom-right of `.canvas-wrap` (the mirror of the floor-plate button's
  bottom-left), toggling a controls/keybindings popup. Reuses the control colour
  family + `--mini-shadow`; turns accent (`.is-active`) while open.
- **Controls list moved out of the left panel into the popup.** The shortcuts
  list (formerly a `panel__section--help` in the left panel) was extracted into a
  reusable `ControlsList` component and rendered inside `.help-popup`. The left
  panel no longer shows it; the unused `.panel__section--help` CSS rule was
  removed. The `.help` list styling is unchanged (still consumed by `ControlsList`).
  - **Open/close is explicit and predictable:** the "?" button toggles it; a ×
    close button, an outside click (a transparent full-canvas `.help-backdrop`
    click-catcher), or **Escape** dismiss it. Escape is handled in a popup-scoped
    effect bound only while open; the main keyboard handler early-returns on
    Escape while `helpOpen` so it doesn't also cancel a polyline.
- **New CSS tokens** (`styles.css`, `:root`): `=== HELP BUTTON ===`
  `--help-btn-size` / `--help-btn-offset` / `--help-btn-font-size`; and
  `=== CONTROLS / HELP POPUP ===` `--help-popup-width` / `--help-popup-max-height`
  / `--help-popup-gap`. The popup surfaces reuse the existing `--mini-*` tokens, so
  no new colour tokens were needed (works in both light and dark themes).

## Statistics dropdown (live readouts moved off the left panel)

The live derived **statistics** that used to sit in the left panel (the
"Perimeter" readouts and the unravel "Segments / Unwrapped length / Total area"
block) now live in a **Statistics dropdown** anchored to a button at the **top of
the canvas, next to Redo**. This frees panel space and lets the user keep the
live stats floating over the canvas while they work.

- **Button** — a `<button className="history-btn">` (the same class/style as
  Undo/Redo) added as a sibling immediately after Redo in `.history-controls`,
  wrapped in a relatively-positioned `.stats-anchor` so the dropdown can pin
  beneath it. The button gains `.is-active` (accent fill, like the floor-plate /
  help buttons) while the dropdown is open.
- **Drops DOWN, anchored to the button** — `.stats-dropdown` is
  `position: absolute; top: calc(100% + var(--stats-dropdown-gap)); left: 0`
  inside `.stats-anchor`, so it appears just below the button.
- **Context-aware** — it renders the **unravel** stat set (`Segments`,
  `Unwrapped length`, `Total area = Σ length × effective height`) when
  `unravelOn && unravelResult`, otherwise the **perimeter** stat set (`Vertices`,
  `Closed`, `Total length`, `Enclosed area`). It re-renders live as the user
  edits (same `perimeter` / `unravelResult` / `effectiveHeight` derivations the
  panel used). Rows reuse the existing `.readout` / `.readout__key` /
  `.readout__val` structure.
- **Transparent background, minimal obstruction** — the dropdown surface is
  **transparent** via the token `--stats-dropdown-bg` (default `transparent`; a
  surface colour can be dropped in there if ever wanted). The readout text keeps a
  subtle `--stats-dropdown-text-shadow` for legibility against the canvas, and the
  dropdown is `pointer-events: none` so canvas pan/zoom passes through its empty
  areas.
- **Open/close — explicit, stays up while working** — the button toggles it, and
  **Escape** closes it (a dropdown-scoped effect, bound only while open; the main
  keyboard handler early-returns on Escape while `statsOpen` so it doesn't also
  cancel a polyline). It deliberately does **NOT** auto-close on canvas clicks or
  pointer interaction (no backdrop catcher) — the user explicitly wants to leave
  the live stats up while editing.
- **New CSS** (`styles.css`, `:root`, `=== STATISTICS DROPDOWN ===`):
  `--stats-dropdown-bg` (transparent surface), `--stats-dropdown-width`,
  `--stats-dropdown-gap`, `--stats-dropdown-pad`, `--stats-dropdown-row-gap`,
  `--stats-dropdown-text-shadow`; classes `.stats-anchor`, `.stats-dropdown`,
  `.stats-dropdown__title`, plus a `.history-btn.is-active` accent rule for the
  open state.

## Visual styling — single source of truth

All visual tokens (colours, spacing, typography, sizing) live as CSS custom
properties at the top of **`src/styles.css`**, grouped and commented by section.
Components reference the variables; the canvas renderer also reads its drawing
tokens (`--canvas-bg`, `--vertex-color`, etc.) from the same file via
`getComputedStyle`, so even canvas appearance is editable from that one file.

**Audit (single-source-of-truth verification):** every `cssVar`/`cssNum` token
referenced by `core/renderer.ts` and `core/extrude3d.ts` is confirmed DEFINED in
`styles.css` (the stylesheet is authoritative; the hex/number literals in those
`.ts` files are only fallback defaults). No static visual values are hardcoded in
the React components — the only inline `style={…}` usages (`MiniWindow` window
position, `PolylineTool` height-input + cell-menu `left/top`) are dynamic runtime
positions that track the canvas and cannot live in a static stylesheet. Two minor
canvas stroke widths that had been hardcoded in the renderer were tokenised
(`--affordance-width`, `--handle-line-width`, same values) so even those are now
tunable from `styles.css`. `styles.css` is the single control point for appearance.

## Units — feet (single source of truth)

The model is authored directly in **feet**: **1 model unit = 1 foot**. This is
not an abstract unit — anchoring to a real dimension means lengths, areas, and
any future **vector-linework export** carry true real-world feet, so the drawing
scales correctly in downstream CAD/design tools.

- **`src/core/units.ts`** is the single source of truth: `UNITS_PER_FOOT`,
  `UNIT_ABBR` (`"ft"`), `UNIT_AREA_ABBR` (`"ft²"`), `UNIT_PRIME` (`′`), plus
  `fmtFeet` / `fmtSqFeet` / `fmtFeetPrime` formatters. Change the unit system in
  one place and every label updates.
- **UI chrome** (panel fields, readouts, mini-window stats, status bar) shows
  `ft` / `ft²` (and `px/ft` for zoom) via `UNIT_ABBR` / `UNIT_AREA_ABBR`.
- **On-canvas dimension tags** use the compact architectural **prime mark** `′`
  via `fmtFeetPrime`, e.g. `12.50′`. These are now ALL consistent — panel **width**
  labels, the per-panel **height** field, floor-plate elevation markers, AND the
  **live polyline-drawing** segment length (`drawSegmentLabel`, e.g.
  `12.50′  ∠45.0°`) — every feet readout goes through `fmtFeetPrime`/`UNIT_PRIME`.
- **The editable per-panel height *input*** (`.unravel-input` DOM overlay) shows
  the prime tick `′` too, but only when IDLE (a focus/blur display swap). It is a
  `type="text"` field (so the value can carry the `′` glyph) with
  `inputMode="decimal"`; while focused or mid-edit it shows the PLAIN number and
  `onChange` sanitizes to digits/`.`/`-`, so `parseFloat` on commit (Enter / blur,
  with `clampHeight` + history) is unchanged. Focus is tracked by
  `focusedUnravelInput`.

## Known limitations / deferred items

- **No undo/redo yet.** The immutable model + ops layer is designed to support
  it; a history stack can wrap `setPerimeter` later.
- **Save + localStorage persistence is implemented** (see "Saving perimeters"
  above). Still **no file export** (JSON download, DXF); the in-memory model is
  serialized only to `localStorage`.
- **Single perimeter only** (no holes, no multiple buildings/layers).
- **Self-intersection is allowed**; area uses the shoelace formula (on the
  flattened outline, so curves are accounted for) which is only geometrically
  meaningful for simple (non-self-intersecting) polygons.
- **Curves are cubic Béziers, not true circular arcs.** "Arc" mode gives a
  circular-looking default that's fully editable via handles; if exact circular
  arcs/radii are needed later, the vertex model can carry an arc representation
  alongside the handle one.
- **Numeric entry** adds relative to the last vertex; there is no inline
  "type while drawing" overlay yet (values are entered in the side panel).
- The grid is never drawn (display path removed); `gridSpacing` drives snapping only.

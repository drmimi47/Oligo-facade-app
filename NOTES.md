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
- **Click a segment** (Edit mode) — insert a new vertex there and start dragging it
  (curved segments are split with De Casteljau, preserving the shape).
- **Wheel** — zoom toward the cursor.
- **Middle-mouse drag** — pan.

Keyboard:
- **A / L** — set the next segments to **A**rc (curved) or **L**ine (straight).
  In Arc mode a plain click auto-curves the committed segment; click-drag shapes it manually.
- **Enter** — close the perimeter (Draw mode, ≥3 vertices).
- **Esc** — cancel the in-progress polyline.
- **Backspace / Delete** — remove the last vertex (Draw) or delete the selected vertex (Edit).
- **Shift (hold)** — constrain the current segment (or handle) to 45° increments.
- **Ctrl/Cmd+Z** — undo · **Ctrl+Y** or **Ctrl/Cmd+Shift+Z** — redo (see *Undo / redo* below).

Precision controls (left panel):
- Snap-to-grid toggle + grid spacing (model units).
- Show/hide grid.
- **Numeric next-segment entry**: type a length and angle to place the next
  vertex exactly, relative to the last one.

Readouts:
- Status bar: live cursor X/Y, current segment length and angle, snap/grid
  state, 45°-lock indicator, and zoom.
- Panel: vertex count, closed state, total perimeter length, enclosed area.

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
- **Deferred** — heights/cells are session state (not persisted per save), so undo
  history is per session and not saved to localStorage.

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
  renameable).
- **Persistence:** saves are written to **`localStorage`** (key
  `facade-app.savedPerimeters.v1`). *Why localStorage:* the `Perimeter` model is
  plain, JSON-serializable data, so this is the simplest durable store that
  survives reload with no backend and no new dependency. Loading happens once via
  the lazy `useState(() => loadSaved())` initializer (defensive: returns `[]` on
  missing/corrupt data); the list is re-persisted by an effect whenever it
  changes. To move to IndexedDB/a server later, only `core/savedPerimeters.ts`
  changes.

### Mini-window (top-right overlay)

Renders each saved shape as a **live thumbnail** using the existing `render()`
with a **fit-to-bounds** viewport (`fitViewport` in `core/viewport.ts`: bounds
from `flattenPerimeter`, small margin, centred; zero-size bounds — single point /
straight line — are floored to an epsilon to avoid divide-by-zero). Multiple
saves show as a compact, **scrollable** gallery with name + vertex count + length
(+ area when closed).

Interactions:
- **Click a thumbnail / name** — load that perimeter back into the editor
  (replaces the live one; switches to **Edit** mode for closed shapes, stays in
  **Draw** for open ones). The loaded entry is highlighted.
- **Rename** — double-click the name, or the **✎** button; Enter/blur commits,
  Esc cancels.
- **Update (⤓)** — overwrite the selected save with the current editor shape
  (also available as *Update loaded entry* in the panel). Disabled when the
  current shape isn't saveable.
- **Delete (×)** — remove that save.
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
- **Unit / height assumption:** the app's units are abstract ("u"); the massing
  adopts the simplest mapping **1 model unit = 1 foot**, so the default wall
  height of ~10 ft is `DEFAULT_WALL_HEIGHT_FT = 10` (a single named constant —
  change it to retune; `render3d` also accepts a `height` option).
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
- **Gap default = 3** (`unravelGap` initial state).

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
- **CSS tokens** (`styles.css`, root): `--floorplate-color` (placed line),
  `--floorplate-ghost-color` (preview), `--floorplate-width`, `--floorplate-dash`,
  `--floorplate-dash-gap` (dash pattern), and `--floorplate-label-gap` (left-of-strip
  height-marker gap, unravel view only). The button styling lives in `.floorplate-btn`
  and reuses the control tokens (`--control-*`, `--mini-shadow`, accent when active).

## Visual styling — single source of truth

All visual tokens (colours, spacing, typography, sizing) live as CSS custom
properties at the top of **`src/styles.css`**, grouped and commented by section.
Components reference the variables; the canvas renderer also reads its drawing
tokens (`--canvas-bg`, `--vertex-color`, etc.) from the same file via
`getComputedStyle`, so even canvas appearance is editable from that one file.

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
- Grid auto-hides when lines would be denser than ~6px to stay readable.

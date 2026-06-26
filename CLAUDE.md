# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A web application for **designers and computational designers** (architecture / computational
design domain). Treat the audience as professional, technical creators — comparable users of tools
like Rhino/Grasshopper, Revit, AutoCAD, Figma, and parametric design environments.

## Core principles

These are global and override convenience or visual preference when they conflict.

- **Function before aesthetic.** Correct, predictable, controllable behavior is the priority. Never
  sacrifice clarity of interaction, precision, or data integrity for visual polish. Aesthetics are
  applied on top of working function, never before it.
- **Design like architecture/design tooling, not consumer apps.** Favor patterns from professional
  design software: precise numeric input, direct manipulation, real-time feedback, predictable
  parametric controls, non-destructive editing, and visible state. Avoid hiding controls, animations
  that delay feedback, or "magic" that obscures what the tool is doing. The user is an expert and
  expects control and transparency.
- **Power and precision over hand-holding.** Expose parameters and let the user drive. Provide sensible
  defaults but keep everything adjustable.

## Visual styling — single source of truth

All visual presentation MUST be controllable from a **single, clearly-commented CSS file** so future
visual changes are easy to locate and make without touching application logic.

- Centralize colors, spacing, typography, sizing, and other visual tokens as **CSS custom properties
  (variables)** at the top of that file.
- **Comment every section and variable group** with clear labels stating what each controls
  (e.g. `/* === CANVAS BACKGROUND === */`, `/* Primary accent — used for selected/active elements */`).
- Components reference the variables; they do not hardcode visual values inline. Keep visual decisions
  out of component logic/markup so styling stays editable from one place.
- When adding a new UI element, add its visual tokens to the CSS file with a descriptive comment rather
  than inlining styles.

## Controls documentation — single source of truth

The `ControlsList` component in `src/PolylineTool.tsx` — surfaced through the bottom-right **"?"** help
button popup — is the **single source of truth** for the application's user controls. It MUST document
the complete, current set of interactions at all times.

- **Every relevant control belongs there**, across all input modalities:
  - **Pointer / mouse** — e.g. left-click to place a vertex, click-drag to pull curve handles, drag a
    vertex or handle knob in edit mode, Alt-drag, click a segment to insert, double-click a vertex to
    make a corner.
  - **Keyboard shortcuts** — e.g. Escape (cancel / exit), Enter and double-click to close, Backspace
    (remove last / delete selected), Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) undo/redo, Ctrl+S save, A / L
    curve types, Shift to constrain.
  - **Trackpad / navigation gestures** — e.g. wheel/pinch zoom (at cursor), middle-drag and
    right-click-drag pan, and minimap interactions (double-click for top-down/plan view, drag to rotate).
- **Keeping this list complete and accurate is part of the change, not a follow-up.** Whenever a
  user-facing control or interaction is **added, removed, or changed**, update `ControlsList` in the
  **same** change so it always reflects reality. Adding a control without documenting it here — or
  leaving a stale/incorrect entry behind — is **incomplete work**.
- Write entries in the existing style: concise, professional, **action → result** (bold control,
  short plain-language effect). Do not invent controls that do not exist.

## Working agreement

- Before introducing a new framework, dependency, or architectural pattern, briefly note the choice and
  why, since the stack is not yet established.

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

## Working agreement

- Before introducing a new framework, dependency, or architectural pattern, briefly note the choice and
  why, since the stack is not yet established.

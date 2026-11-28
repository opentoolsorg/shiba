---
version: alpha
name: Shiba workspace
description: Overlay-inspired neutral workspace visual system for Shiba dashboard, docs, and marketing surfaces.
colors:
  light:
    background: "#fafafa"
    foreground: "#0a0a0a"
    muted: "#71717a"
    muted-light: "#a1a1aa"
    border: "#e4e4e7"
    surface-elevated: "#ffffff"
    surface-muted: "#f5f5f5"
    surface-subtle: "#f0f0f0"
    sidebar-surface: "#f5f5f5"
    button-primary-bg: "#dcdce1"
    button-primary-hover: "#ccccd3"
    button-primary-text: "#27272a"
    input-background: "#ffffff"
    input-border: "#e4e4e7"
    success: "#10b981"
    warning: "#f59e0b"
    danger: "#ef4444"
  dark:
    background: "#09090b"
    foreground: "#f5f5f5"
    muted: "#a1a1aa"
    muted-light: "#71717a"
    border: "#27272a"
    surface-elevated: "#111113"
    surface-muted: "#151518"
    surface-subtle: "#1c1c20"
    sidebar-surface: "#111113"
    button-primary-bg: "#3b3b42"
    button-primary-hover: "#484850"
    button-primary-text: "#ededf0"
    input-background: "#111113"
    input-border: "#27272a"
    success: "#34d399"
    warning: "#fbbf24"
    danger: "#f87171"
typography:
  display:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.02em
  body:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Geist Mono
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.25
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
motion:
  color:
    duration: 150ms
    timingFunction: cubic-bezier(0.16, 1, 0.3, 1)
  panel:
    duration: 220ms
    timingFunction: cubic-bezier(0.16, 1, 0.3, 1)
components:
  button-primary:
    backgroundColor: "{colors.light.button-primary-bg}"
    textColor: "{colors.light.button-primary-text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 36px
  button-secondary:
    backgroundColor: "{colors.light.surface-muted}"
    textColor: "{colors.light.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 36px
  input-field:
    backgroundColor: "{colors.light.input-background}"
    textColor: "{colors.light.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
    height: 44px
  card:
    backgroundColor: "{colors.light.surface-elevated}"
    textColor: "{colors.light.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  sidebar:
    backgroundColor: "{colors.light.sidebar-surface}"
    textColor: "{colors.light.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
---

## Overview

Shiba uses a quiet, modern workspace design: neutral surfaces, compact type,
rounded panels, flat controls, and little decoration. The product should feel
fast and obvious. Visual structure comes from spacing, fill, hierarchy, and
alignment rather than heavy borders or brand effects.

This file follows the Google `DESIGN.md` format. The YAML tokens are the
machine-readable contract. The prose explains how agents should apply them.
CSS custom properties remain the runtime delivery mechanism.

This is the target contract, not a measured snapshot. Current implementation
status:

| Surface | Status |
| --- | --- |
| `apps/frontend` | Closest to this direction because it already uses neutral workspace tokens, rounded radii, and soft elevation. |
| `apps/web` | Still carries the older cream/navy paper-OS system. Treat that as migration debt when touching docs or marketing visuals. |

## Colors

Use semantic tokens, not page-specific colors. Light and dark themes change
values, not token names.

- `background` is the page fill.
- `surface-elevated` is the main card, dialog, popover, and composer fill.
- `surface-muted` and `surface-subtle` separate nested regions without heavy
  borders.
- `sidebar-surface` is the navigation fill.
- `foreground` is primary text. `muted` and `muted-light` are secondary text.
- `border` is reserved for inputs, the composer, and rare separation that fill
  cannot communicate.
- Primary buttons are neutral filled controls, not bright brand buttons.
- `success`, `warning`, and `danger` carry status only.

Do not reintroduce the paper-OS navy accent, dot-grid canvas, window titlebars,
hard offset shadows, or pixelated chrome as the default product language.

## Typography

Use Geist for interface and display text. Use Geist Mono for paths, machine
facts, keyboard hints, compact labels, and status metadata.

Headings are semibold and compact. Do not use a serif display face for normal
product UI. Marketing may use stronger scale and spacing, but it must keep the
same neutral palette and restrained voice.

## Layout

Use a workspace shell with clear navigation, a focused content column, and
contextual detail panels where the workflow needs them. Surfaces may be rounded
up to 12px. Keep an 8px rhythm for controls and small gaps, with 16px and 24px
for section spacing.

Headers use the same fill as the surface below them. Do not add divider lines
or backdrop blur by default. Let the content hierarchy separate the header.

## Elevation & Depth

Most in-page surfaces are flat. Use fill changes instead of resting borders.
Use soft shadows only for floating layers: `shadow-md` for menus, popovers, and
tooltips; `shadow-lg` for dialogs and sheets. Focus rings remain visible for
keyboard focus.

## Shapes

Controls use rounded rectangles. Use `rounded.md` for buttons and inputs,
`rounded.lg` for cards and panels, and `rounded.full` only for small status or
selection pills. Do not mix sharp retro chrome with this system.

## Motion & Micro-interaction

Motion is short and functional. Use about 150ms for hover and color changes
and about 220ms for panels and menus. Respect reduced motion. Do not add
decorative parallax, glows, or continuous animation.

## Voice & Content Strategy

Use direct, compact product copy. Prefer ordinary words and explicit state.
Approval-gate copy stays visible and specific. Do not hide destructive or
approval-required actions behind playful language.

## Components

Use shared primitives before creating a new control. Buttons, inputs, dialogs,
menus, tabs, switches, cards, and composers should come from the existing Shiba
component patterns where they exist. New reusable behavior belongs in a shared
component, not in a page-local copy.

Chat and run surfaces use one composer pattern: attachments and context controls
on the left, model or execution controls near the submit action, and one clear
submit or stop state. Tool and approval rows stay compact and text-first.

## Do's and Don'ts

Do:

- Read this file before adding visual rules.
- Use semantic tokens and keep light and dark themes working.
- Update this file in the same commit when a durable visual rule changes.
- Migrate older paper-OS surfaces toward this system when touching them.
- Keep controls keyboard accessible and at least 44px high where touch matters.

Do not:

- Invent page-specific colors or a second accent system.
- Use heavy borders where a fill change is enough.
- Add glass, gradients, glows, paper texture, dot grids, or retro window chrome.
- Copy Overlay code or assets wholesale; adopt the design principles and token
  discipline, not their brand or product identity.
- Treat the older `apps/web` paper-OS implementation as the target for new work.

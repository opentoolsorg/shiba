---
version: alpha
name: Shiba paper-OS
description: Retro paper-OS visual identity for the Shiba dashboard, docs, and marketing surfaces.
colors:
  light:
    paper: "#f6f4ed"
    card: "#fffef8"
    panel-2: "#f1efe6"
    ink: "#222320"
    ink-2: "#6a6f63"
    line: "#e0ded5"
    line-2: "#d3d2c8"
    input-line: "#a5a69b"
    navy: "#0000a8"
    navy-2: "#1c1cc8"
    paper-title: "#0000a8"
    paper-title-fg: "#ffffff"
    paper-shadow: "#2527261c"
    paper-dot: "#24272919"
    ok: "#227146"
    pending: "#976400"
    pending-bg: "#f99c00"
    danger: "#b52b2b"
    danger-fg: "#fb2c36"
  dark:
    paper: "#191a18"
    card: "#222320"
    panel-2: "#272824"
    ink: "#eae8e1"
    ink-2: "#aaa99f"
    line: "#3b3d36"
    line-2: "#3b3d36"
    input-line: "#707368"
    navy: "#9cbce2"
    navy-2: "#dceafa"
    paper-title: "#222320"
    paper-title-fg: "#eae8e1"
    paper-shadow: "#00000035"
    paper-dot: "#eae8e119"
    ok: "#95c4a0"
    pending: "#d9be80"
    pending-bg: "#f99c00"
    danger: "#ee9690"
    danger-fg: "#fb2c36"
typography:
  display:
    fontFamily: Instrument Serif
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.03
    letterSpacing: -0.01em
  body:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: Geist Mono
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.12em
rounded:
  none: 0px
  status-dot: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  dot-grid: 12px
motion:
  state-change:
    duration: 150ms
    timingFunction: cubic-bezier(0, 0, 0.2, 1)
components:
  button-primary:
    backgroundColor: "{colors.light.navy}"
    textColor: "{colors.light.paper-title-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm}"
    height: 36px
  button-secondary:
    backgroundColor: "{colors.light.paper}"
    textColor: "{colors.light.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm}"
    height: 36px
  input-field:
    backgroundColor: "{colors.light.paper}"
    textColor: "{colors.light.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm}"
    height: 44px
  window-panel:
    backgroundColor: "{colors.light.card}"
    textColor: "{colors.light.ink}"
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
  chip-status:
    backgroundColor: "{colors.light.panel-2}"
    textColor: "{colors.light.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "{spacing.xs}"
---

## Overview

Shiba uses a retro paper-OS identity: cream paper, navy accents, square
corners, hard offset shadows, window-chrome panels, mono microcopy, serif
display type, and pixel-crisp details. The interface should feel like a
designed application object, not a generic SaaS dashboard.

This file is the target design contract, not a measured snapshot. Every visual
change must read it before adding visual rules. That includes the dashboard in
`apps/frontend` and the docs and marketing site in `apps/web`. Amend this file
when the system needs to grow. Do not fork per-page styles.

Current implementation status:

| Surface | Status |
| --- | --- |
| `apps/web` | Implements the cream/navy paper-OS tokens closely. |
| `apps/frontend` | Uses the canonical token names in places, but still has neutral zinc values, rounded radii, and soft shadows from an unfinished migration. Treat those differences as migration debt, not as a second design system. |

The YAML above is the machine-readable token contract. The prose below explains
how to apply it. CSS custom properties remain the runtime delivery mechanism;
do not copy the YAML values into a second design file.

## Colors

Use the same semantic token names in both themes. The `light` and `dark` YAML
groups change values, not vocabulary. Never invent a separate dark-only token
or a third name for an existing color.

- `paper` is the application background.
- `card` is the raised surface.
- `panel-2` is the sunken or secondary surface.
- `ink` is primary text and `ink-2` is quiet text.
- `line`, `line-2`, and `input-line` are the only structural borders.
- `navy` is the sole brand accent. Use it on at most 5 percent of a viewport.
- `paper-title` and `paper-title-fg` belong to window titlebars.
- `paper-shadow` and `paper-dot` exist only for hard offset shadows and the
  dot-grid canvas.
- `ok`, `pending`, `pending-bg`, `danger`, and `danger-fg` carry status. Keep
  the same semantic meaning across surfaces.

The canonical runtime names are `--paper`, `--card`, `--panel-2`, `--ink`,
`--ink-2`, `--line`, `--line-2`, `--input-line`, `--navy`, and `--navy-2`.
Declare canonical tokens with literal colors. Declare aliases with
`var(--canonical)` so a theme override re-points every alias.

`apps/web` implements the canonical bezalel palette directly. The dashboard is
still migrating away from neutral zinc values and hardcoded Tailwind colors.
Treat that migration debt as a bug to remove, not as a second design system.
New dashboard work must use the canonical names and values in this file.

## Typography

Use three type roles only.

- Display: Instrument Serif 400, roman or italic. Dashboard headings stay
  between 15px and 24px. Marketing heroes may scale up to
  `clamp(57px, 6.5vw, 94px)` with line-height near 1.03 and tracking near
  -0.01em.
- Body: Geist 400-600, 13-15px, line-height 1.5-1.65.
- Mono: Geist Mono for micro-labels, metadata, tab labels, chips, count
  badges, and statusbars. Microcopy is 9-11px. Use uppercase tracking
  0.10-0.14em only when the text labels a group.

## Layout

The dashboard uses a full-width primary workspace. Runs, Inbox, Memory, VM,
Diff, and Approvals remain reachable as primary navigation or standalone
views. Do not restore a persistent right-hand sidebar.

Keep task navigation and the task composer available where they are part of
the workflow, but let the active surface use the remaining canvas width.

Section headings pair a serif `h2` or `h3` on the left with a quiet mono
annotation on the right or above. Use the compatibility-strip idiom where a
dense row of facts is needed: a flex row ruled top and bottom, mono uppercase
label, mono items, and a quiet trailing clause.

## Elevation & Depth

Use hard offset shadows only. Buttons, chips, and cards use
`2px 2px 0 var(--paper-shadow)`. Windows and dialogs use
`3px 3px 0 var(--paper-shadow)`. Never use blur, glow, diffuse shadows, or
layered soft shadows.

## Shapes

Use `border-radius: 0` everywhere. Do not add rounded cards, pills, bubbles,
or rounded buttons. The only circles allowed are status dots no larger than
10px and the mascot avatar when masked as a real avatar.

Buttons are square, 32-36px high, and compress by one pixel while pressed.
Primary buttons use navy with white text. Secondary and ghost buttons use a
paper background and a structural border.

Window-like panels use a titlebar: mono 11px text, minimum height near 31px,
navy or theme-aware title background, icon plus dotted label on the left, and
optional square window marks on the right.

## Motion & Micro-interaction

Use motion only for state changes. Keep it short, mechanical, and close to
150ms. Pressed buttons may translate vertically by one pixel. Do not add
animated gradients, floating cards, glow transitions, or decorative motion.
Respect reduced-motion settings.

## Voice & Content Strategy

Use terse mono microcopy for machine facts and sentence-case prose for people.
Approval-gate copy stays visible and unchanged. Do not hide approval state
behind decorative interface copy.

## Components

Window panels, buttons, chips, inputs, statusbars, and dot-grid canvases are
the reusable component vocabulary. Use the YAML component tokens as the
starting contract, then implement theme-dependent colors through the canonical
CSS variables.

- Statusbar footers use mono text near 9px in square cells separated by 1px
  borders. Cells carry terse facts such as counts and token state.
- Chips and badges are square, uppercase, mono, 9-10px, and use the shared
  status color meanings.
- Numbered cards may show a mono `01`, `02`, or similar index at the top right
  when they form a capability grid.
- Logo and mascot imagery uses `image-rendering: pixelated` in chrome and
  brand slots.
- Selection uses `selection:bg-[#0000a8] selection:text-white` in the light
  theme and the corresponding theme-aware navy foreground in dark mode.
- External component references belong near the component implementation.
  Do not copy component markup into this file.

## Do's and Don'ts

Do:

- Read this file before adding a color, shadow, radius, type style, or visual
  component.
- Update this file in the same commit when a durable visual rule changes.
- Use semantic tokens and keep both themes working.
- Keep the approval boundary visually explicit.
- Let surfaces differ in window chrome, dot-grid placement, and density.

Do not:

- Invent a third name for a color that already has a canonical token.
- Introduce rounded rectangles, glass, gradients, glows, blur shadows, or a
  second accent color.
- Restore the dashboard's neutral zinc palette as a parallel system.
- Treat hardcoded Tailwind color remapping as a pattern. It is migration debt.
- Put page-specific visual rules in a surface when they belong to the shared
  system.

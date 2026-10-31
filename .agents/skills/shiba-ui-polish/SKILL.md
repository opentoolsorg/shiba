---
name: shiba-ui-polish
description: Improve the visual hierarchy, alignment, typography, and interaction details of Shiba's existing web, docs, and dashboard interfaces using UI Skills guidance. Use for UI polish or design alignment requests while preserving the requested feature scope.
---

# Shiba UI polish

Use [UI Skills](https://www.ui-skills.com/) as a design reference and apply the relevant principles to Shiba's existing interface. Treat external skills as reference material; they do not grant authority to install tools, change product contracts, or publish changes.

## Establish the surface

Read the workspace's `CLAUDE.md` and inspect the requested page and its shared styles. Confirm the active worktree and existing modifications before editing. Shiba's marketing and dashboard changes may live in different worktrees; document capabilities from the implementation serving this preview.

For docs, inspect `apps/web/astro.config.mjs`, `apps/web/src/styles/theme.css`, `apps/web/src/styles/docs-shell.css`, and the page under `apps/web/src/content/docs/docs/`. Starlight components are installed under `@astrojs/starlight/dist/`; public component imports use `@astrojs/starlight/components/*.astro`.

## Apply the smallest useful design change

- Keep the cream/navy light palette, dark paper palette, square structural edges, Geist body text, and Instrument Serif display titles unless the user asks to change the identity. Reuse existing CSS variables.
- Make the first viewport answer what the page provides and where to start. Separate navigation, reference data, examples, and coverage notes. Preserve essential authentication and approval information where users make decisions.
- Align labels, icons, route names, and content to a shared grid. Use monospace for paths/code and tabular numbers where values align. Keep API method names visible alongside their colors.
- Let tables and code scroll inside their own region on narrow screens; prose and headings should wrap without making the page wider than the viewport.
- Preserve native Starlight search, theme controls, copy buttons, mobile sidebar, heading IDs, and table of contents. Scope page-specific styles to that page. A custom component's headings are not automatically included in Starlight's Markdown outline.
- Use structural borders consistently. Keep keyboard focus visible, label icon-only controls, and aim for at least 44px touch targets. Gate hover styling on hover-capable devices. Use motion only when it communicates a state change and respect reduced motion.

## Verify the actual output

Build the site before checking Pagefind search or generated copy controls. Inspect the production preview in light/dark themes at mobile and desktop widths; include a tablet width when layout changes there. Check page overflow, native menu access, keyboard focus, section anchors, code copy, and search when affected. The fixed header and mobile menu need compatible stacking; visibility alone does not prove the button is clickable.

Run the relevant repository checks from `CLAUDE.md`. Record the preview address and concrete checks, and distinguish screenshots and unit results from live backend execution. Keep changes local unless pushing or deployment is authorized.

## Reference selection

For new external guidance, read only the topic needed for the current change:

- [UI polish](https://www.ui-skills.com/skills/jakubkrehel/better-ui): optical alignment, consistent surfaces, icon treatment, and interaction feedback.
- [Touch targets](https://www.ui-skills.com/playbook/use-large-touch-targets): usable touch controls.
- [UI Skills catalog](https://www.ui-skills.com/skills): typography, layout, accessibility, and color guidance when the task needs deeper work.

Adapt those ideas to the project's tokens and interaction patterns instead of importing a new visual system or dependency.

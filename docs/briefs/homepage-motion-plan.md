# Shiba homepage motion plan

## Goal

Give the Shiba homepage the confident, animated product-story feel of [dusk.bot](https://dusk.bot/) while keeping Shiba's own cream/navy identity, accurate product claims, existing route structure, and approval-first message. Motion should clarify what Shiba does: plan work, wait for approval, return reviewable results.

## Reference research

Inspection of dusk.bot's live homepage and served styles shows a few reusable motion principles:

- A strong first viewport introduces the product, then moves quickly into a product demonstration.
- Motion is repeated with purpose: slow ambient drifting in the scene, small status pulses, animated paths, and short entrance transitions.
- The page uses a custom motion stylesheet and pauses some ambient elements when the scene is offscreen or hovered.
- The product's live demo is interactive, so motion is attached to meaningful states and examples rather than used only as decoration.
- The page includes reduced-motion handling. Shiba already has an `IntersectionObserver` reveal helper and reduced-motion-aware entrance styles; extend those patterns rather than adding an animation dependency.

## Shiba-specific direction

Use the existing Shiba mascot as the visual anchor, with a restrained orbit of three line icons representing **Plan → Approve → Review**. This makes the mascot feel like the host of Shiba's workflow, not a generic sticker. Keep the real Agents screenshot as the product proof directly after the introduction. Keep the existing palette, typography, copy, and accurate built-in versus custom-role distinctions.

For the role cards, keep the existing bespoke role mascots. Add gentle, staggered idle movement to the illustrations and clear pointer feedback to the cards. Keep normal keyboard focus indicators on the page's actual controls. Use the existing SVG art and CSS; do not introduce external icon packages or redraw the brand. Motion is supplementary: every label and workflow step remains understandable with animation disabled.

## Implementation sequence

1. **Hero story:** retain the existing headline and calls to action; add a small Shiba-led workflow scene beneath them, with accessible inline plan, approval, and review icons. Keep it visually subordinate to the headline and ensure it wraps cleanly on mobile.
2. **Mascot and role icons:** give the central mascot a slow, subtle float; let the workflow markers orbit/float at different phases. Animate role-card mascot images with slight stagger, plus modest card hover feedback.
3. **End-to-end scroll rhythm:** use the existing reveal utility on the product screenshot, employee cast, approval steps, comparison, trust points, and final CTA. Stagger related items, not whole paragraphs one by one. Keep content visible if scripts fail and clear entrance effects when keyboard focus arrives.
4. **Accessibility and performance:** disable nonessential movement under `prefers-reduced-motion: reduce`; pause offscreen continuous animation where practical; avoid layout-shifting animation and avoid adding dependencies.
5. **Responsive and build review:** inspect the changed markup and CSS, run the web build/type check, and review the generated home page output. Validate desktop and mobile structure in a browser if the available browser surface works.

## Acceptance checks

- Existing homepage copy, navigation targets, product screenshot, SEO metadata, and product-contract claims remain intact.
- The hero workflow icons have accessible context, and decorative mascot art stays hidden from assistive technology.
- Role cards remain understandable and usable without motion; hover effects do not replace keyboard focus indicators.
- No horizontal overflow at narrow widths; orbit scene scales or reflows without covering text or controls.
- Reduced-motion preference stops continuous mascot/icon movement and scroll entrance animation.
- The Astro web build succeeds. Report any browser inspection limitation separately from build evidence.

## Scope boundary

This plan updates the public marketing homepage only. It does not change dashboard behavior, approval semantics, product capabilities, documentation routes, or deployment configuration.

## Updated local experiment — OpenBot reference

The latest reference is [openbot.run](https://openbot.run/), inspected through its live homepage and browser on 16 November 2026. Its centered “Meet” headline includes an interactive logo, followed by a product preview. Shiba now tries that composition with original Shiba characters: a clickable mascot beside “Meet Shiba,” an illustrative Plan / Approve / Review selector, and the existing real product capture.

Reuse `ShibaMascot.astro` throughout the hero, workflow preview, employee cards and closing CTA. Its layered SVG gives each character moving ears, tail, paws and expressions; employee roles retain their own accessories. The workflow selector only changes local explanatory content. It neither starts a run nor grants approval.

Local validation: web build and Astro check pass. The local preview responds with HTTP 200. Browser inspection confirmed the page and controls are present, but window availability interrupted the full responsive and interaction review.

## Leina workspace experiment and directory cleanup

Updated from the supplied Leina chat screenshot: a dark workspace with three selectable Shiba examples, sample source chips, a proposed-work card, and a result card. Marketing shows an animated sample search chart; Engineering shows an illustrative diff; Research shows a source-oriented report outline. The brief advances to a proposal, then waits for an explicit local preview action before revealing the result. Pause, replay, reduced-motion handling and offscreen suspension apply to this illustrative scene. No messages or approvals reach a backend.

The integrations page previously repeated apps across the app catalog, MCP preset catalog and roadmap. MCP details now live with the matching app card. Alias-aware roadmap filtering leaves seven additional planned tools, with search and counts based on those rendered tools. Nine web tests pass, including roadmap deduplication and the existing focus/reduced-motion contract.

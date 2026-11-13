# Chat, employee roster and Knowledge UI integration

This frontend change uses the saved employee registry, thread metadata and existing
memory tools. It adds no backend endpoints or authorization paths.

## Composer integration

`ConversationModeSwitch` already uses the application's persisted conversation mode
and shared task draft. Its guidance now explains the Chat → Work → human review flow.
It does not submit work or infer approval commands.

`ChatMessageComposer` adds optional `onPrepareWork?: () => void`. The
`AgentComposerShell` forwards it. When provided, a **Review as work** action appears
below the composer. It is disabled for empty drafts, busy state and streaming.
Clicking calls only the supplied callback: the draft remains owned by the caller;
no submit, mutation, navigation, parsing or approval occurs in the composer.

The shared application's integrator should wire the existing `AgentComposerShell`
invocation with:

```tsx
onPrepareWork={() => setConversationMode("work")}
```

Use the existing `setConversationMode` callback, which preserves the current scoped
draft. Keep the existing Work composer, frozen payload creation and human approval
path. No second draft store or alternate submission path is needed. Shared
`app.tsx`, shell, routes and Work components are intentionally outside this slice.
The existing mode switch remains usable without this optional callback.

## Employee directory

The saved roster appears before the catalog/editor. Search filters saved name,
slug, role label, harness and model. Opening a profile shows its saved version,
full instructions, harness, model, sandbox and default repository. Opening and
closing a profile moves focus to the summary and back to its triggering button.
Profile inspection makes no writes. Existing edit, launch, archive, restore,
delete and scoped thread history controls remain available.

The roster makes no claim about live employee state, completion counts, approval
rates or team dispatch: those are not supplied by the registry contract.

## Knowledge layout

Knowledge introduces an overview and shortcuts to the current recall, source,
project, note and upload sections. Shortcuts scroll and focus existing controls
without navigation or remounting, preserving unsaved form state. Source retention,
versioned downloads, project context, errors and mutations retain their existing
handlers. Retrieval remains local keyword ranking; this change does not add
semantic retrieval or redefine Spaces as context bundles.

## Verification scope

Focused unit coverage checks the work-review callback boundary, busy/empty locks,
IME Enter handling, registry search, profile focus and read-only inspection, and
Knowledge navigation preserving unsaved text. Existing component tests cover
saving, conflicts, scoped async results, lifecycle controls and file operations.

Chromium component-fixture checks passed at 390, 768 and 1440px in light and dark
themes: no horizontal page overflow, roster filtering, profile focus/return,
Knowledge focus and unsaved text retention, and callback-based Chat/Work draft
retention. There were no page errors or mutation requests. These checks used
explicit local fixtures; they do not establish live backend execution, OAuth,
provider connectivity or production routing.

Validation on this branch:

- `pnpm -C apps/frontend test`: 198 files / 1,681 tests passed. The suite emitted
  existing localhost connection and timeout warnings but exited successfully.
- The final focused component reruns cover the added review forwarding and mode
  guidance assertions as well as the roster/Knowledge interactions.
- `pnpm -C apps/frontend typecheck`: passed.
- `pnpm -C apps/frontend lint`: passed.
- Scoped Biome checks: passed, with five pre-existing warnings in the employee
  view/tests (semantic-element suggestions, one unused test parameter and one
  non-null assertion).
- `pnpm -C apps/frontend build`: passed; `/app` prerendered. Main client chunk
  2,300.88 kB (591.06 kB gzip); build retains its large-chunk warning. This is a
  frontend measurement, not a Durable Object memory measurement.
- `git diff --check`: passed.

The monorepo/backend gate, integrated app callback wiring and live acceptance are
left to the shared integration pass. No backend, deployment, auth or route files
were changed.

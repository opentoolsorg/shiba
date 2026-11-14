# Multiplayer + Slack coworker: phased goal

Requested on November 6, 2026: preserve Shiba's existing features and stack while
using comparable multiplayer products, including [Viktor](https://viktor.com/), as product references.

## Product and implementation constraints

Keep React/TanStack, the Cloudflare Worker, D1, Durable Objects, the existing
harnesses, integrations, and approval contracts. Do not replace the application
with a Next.js/Convex stack from an outside product. That repository identifies its
first-party code as AGPL-3.0-only; this work uses feature concepts, not copied
source. Keep personal context, credentials, billing authority, room membership,
and Slack publication permissions distinct.

## Existing foundations, not new promises

| Capability | Current implementation |
| --- | --- |
| Team membership, roles, invitations | `TeamWorkspaceView.tsx`, backend `team-workspaces*` |
| Room chat, presence, cursors, selected shared notes | `CollaborationView.tsx`, `collaboration-room-realtime.ts` |
| Employee assignments and reviewed execution | `RoomApprovalReview.tsx`, `RoomExecutionPanel.tsx` |
| Managed Slack installation and identity linking | `SlackInstallationsPanel.tsx`, `SlackCoworkerPanel.tsx` |
| Exact-thread private intake and room handoff | `slack-coworker-client.ts`, backend `slack-coworker-*` |
| Reviewed outbound Slack messages | backend `slack-room-bridge.ts`, `slack-room-outbox.ts` |
| Optional schedules, connectors, shared computers | Existing founder schedule, workspace connector, and shared computer surfaces |

Presence in the repository is not proof that a live deployment has configured
these optional integrations or completed a real execution.

## First slice implemented

- A verified team workspace now explains the path from inviting teammates to
  shared rooms to Slack setup. Actions open existing surfaces; they do not
  create grants, start work, or publish messages.
- Invitation actions remain manager-only. Members can navigate to their own
  Slack setup; installation administration remains owner-only in Apps.
- Team rooms expose canonical `/threads/?workspace=…&room=…` links. Recipients
  must have verified workspace membership and pass a separate room read; copied
  links grant no access. Explicit workspace changes clear old link intent.
- Slack linking instructions are cleared when status verification fails, when
  the exact challenge is confirmed in Slack, and at the server-provided expiry.
  Native identity confirmation remains a separate explicit action.
- Regression coverage preserves scope changes, revoked memberships, and the
  explicit Slack-draft-to-room review boundary.

## Next release gates

1. **Multiplayer journey:** prove two distinct authenticated accounts joining one
   workspace, explicit room membership, live messages/presence, selected context,
   removal, and subsequent denial. Exercise canonical links across independent
   browser sessions; a copied URL must never grant membership.
2. **Slack coworker journey:** prove installation, two-sided identity linking,
   exact-thread intake, editable private draft, explicit room consent, frozen
   native approval, execution, and separately approved delivery with receipts.
   Test revoked sources and uncertain delivery without automatic retries.
3. **Broader workspace parity:** inventory projects, files, memory, skills,
   connected apps, schedules, and computer workflows against the references.
   Prioritize gaps rather than replacing existing capabilities. Give each
   accepted feature a scoped implementation and acceptance test.

## Verification limits

The deployed `/app/` URL reaches sign-in. The invitation-account form opens and
can return to sign-in; no production account was created. Signed-in production
workflows, real Slack OAuth/delivery, and paid model execution were not exercised.
Local browser fixtures prove UI behavior only; they do not establish live Slack
or multi-user backend acceptance. See the task handoff for commands and results.

The local backend authentication suite also exercises two independent signed-in
cookie sessions through the real product handlers: explicit room membership,
shared persisted messages, distinct realtime identities, and denial after member
removal. Its mailbox verification and realtime transport are test fixtures, not
production email delivery or a live two-browser presence proof.

Detailed live configuration and production-build findings: [production workflow audit](production-workflow-audit-20261106.md).

# Slack coworker execution V2 acceptance

This checkpoint implements native-reviewed execution of a verified coworker's
own retained Slack statement. It is not live installed-Slack or provider
certification. Prince narrowed the active task to Slack; the other five product
areas and the live preview remain on hold.

| Lifecycle | Implementation and evidence | Boundary |
| --- | --- | --- |
| Slack author → native account | Existing two-surface challenge, signed ingress, verified native UUID, exact managed installation and scoped intake. `slack-coworker.security-v3.test.ts` exercises signed ingress; the integration fixture uses the real identity store and native verification flows. | No imported thread history or assertion of current private-channel membership. Every edit/delete delivery is not proven. |
| Select runtime and audience | `SlackCoworkerPanel.tsx` selects accessible rooms, active employees and owned personal grants; `slack-coworker-execution.ts` freezes statement, readers, current profile and personal snapshot in an expiring digest-bound preview. | Local Claude/Codex native account and approved public repository only; no team/deployment billing or implicit app access. |
| One-shot submission | `0035_slack_coworker_execution_v2.sql`, strict shared DTOs, actual native session and Worker-only purpose HMAC; atomic D1 consumption before reserved handoff creation. | A lost response is inspected through minimal owner receipts. Unknown outcomes are never automatically retried. Legacy receipts cannot authorize execution. |
| Human approval → execution | Actual room/run/approval paths bind canonical task, grant, profile, handoff and input hash; child seal and local mailbox recheck current authority. | No model, bot, coworker label or automation may approve. No work starts on submission alone. |
| Result and revocation | Room handoff displays completion, summary and retained results; serialized coding payloads are reduced to their human summary in the room. Source revocation hides later context/result reads. | Only separately consented private status; full results remain in Shiba. D1 and mailbox are separate stores; checks narrow rather than eliminate cross-store races. Already started CLI work cannot be retroactively undone. |

## Deterministic integration evidence

`apps/backend/test/slack-coworker-execution.integration.test.ts` combines real
Better Auth native sessions and email-verification handlers, workspace
membership, Slack identity/intake stores, personal pairing/grant APIs,
collaboration and run intake, CodingOrchestrator approval/dispatch logic, child
seal validation, LocalRuntimeAdapter and LocalDispatch. A fixture CLI claims
once and returns a changed file through the real result endpoint. Another
verified member cannot retrieve or approve the request. Revoked intake blocks
pending approval and removes cached result disclosure.

Think persistence/transport, agent RPC, email transport and CLI execution are
fixtures. The only HTTP fetch fixture returns public GitHub repository metadata
without credentials. No real Slack message, provider inference, cloud sandbox,
credential creation, preview deployment or production modification is part of
these checks. This proof does not certify a live daemon or installation.

Focused proof suites additionally cover changed task/employee/grant snapshots,
unsigned reserved IDs, replay, actual session expiry, changed room/profile,
source revocation, abandoned queue recovery and refusal of legacy receipts.
The private-status suite additionally covers concurrent reservations, source and installation changes during authentication, frozen-target tampering, expiry, unknown-send replay refusal and metadata-only revocation while disabled. A configured encrypted fixture exercises private awaiting-review and completed notices against the actual local approval host, with zero task/result/file content in the intercepted payload. An available installation creates no grant without the separate consent.

Frontend tests exercise explicit audience consent, exact preview validation,
uncertain outcomes, one-shot submission and scoped room navigation.

Local verification after integration:

- Initial V2 core: **59 backend tests across seven files** and **seven frontend
  tests across three files** passed before the separate private-status increment.
- Private-status integration: **29 backend tests across three files** passed,
  including the five combined native lifecycle/consent cases and all eleven
  adversarial notice cases. The broader five-file run also passed all 37
  unchanged team-skills tests. **Thirteen frontend tests across three files**
  passed after the notice controls were added.
- Backend source and test-project typechecks passed.
- [Offline Chromium browser evidence](slack-coworker-v2-20261105-browser.md)
  includes desktop and 390px screenshots. No horizontal overflow or uncaught
  page errors were observed; all network responses are local fixtures. This is
  component evidence, not authenticated deployed-service acceptance.

## Remaining acceptance and decisions

- Prince selected private Slack status with full results in the authorized Shiba
  room. The implementation requires a separate per-user target consent and the
  default-off operator flag `SLACK_COWORKER_PRIVATE_STATUS_ENABLED=true`.
  Ephemeral delivery is best-effort; a successful receipt means API acceptance.
  No result content, shared-thread posting or delivery guarantee is granted.
- An authorized configured Slack installation, two actual human identities and
  a paired supported local account are needed to verify live link, signed event
  delivery, review, CLI execution, results and revocation. Live testing and
  preview remain paused; no credentials or external sends were requested here.
- Durable receipt capacity is bounded to 16 live previews and 1,000 retained
  attempts per native account. Exhaustion requires explicit maintenance.
- Both [CI](https://github.com/opentoolsorg/shiba/actions/runs/42102526893) and
  [Desktop](https://github.com/opentoolsorg/shiba/actions/runs/42102526633) passed
  at `6070992ffad5c64de72d683be554e51c040450cf`, including native-onboarding
  acceptance after awaiting the actual employee-save acknowledgment. These runs
  precede the private-status increment and do not certify it. Final-head checks
  are recorded in the PR summary after its push. No merge or release approval
  is implied; merging main triggers frontend deployment separately from backend.

The [six-feature report](pr188-six-features-20261105.md) remains the broader
historical scope inventory. This report supersedes only its Slack submission
implementation description, not its unverified external-flow boundaries.

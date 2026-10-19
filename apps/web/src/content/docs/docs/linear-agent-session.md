---
title: Linear agent sessions
description: How Shiba maps Linear AgentSession webhooks to approval-gated runs (OAuth actor=app, activities, and automations).
---

Shiba integrates with Linear’s **agent session** model: a delegated or @-mentioned issue opens an `AgentSession`, Linear delivers `AgentSessionEvent` webhooks, and the agent acknowledges with **agent activities** and optional `externalUrls` back to the dashboard thread.

This page summarizes the **official Linear API** (researched 2026-10-19 from [Agent interaction](https://linear.app/developers/agent-interaction), [OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication), [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization), and [Agents getting started](https://linear.app/developers/agents)). It is design notes for self-hosters, not a copy of Linear’s docs.

## OAuth and actor mode

- Register an OAuth application in Linear and set redirect URLs.
- For service-style agents, use **`actor=app`** on authorize so mutations appear as the app user, not the installing human. Optional `createAsUser` / `displayIconUrl` on `issueCreate` / `commentCreate` customize attribution.
- Agent-specific scopes (e.g. `app:assignable`, `app:mentionable`) are documented under app authentication in Linear’s OAuth guide.
- Token endpoint: `POST https://api.linear.app/oauth/token` with `authorization_code` or refresh grants. Refresh tokens are required for long-lived automation (Linear migrated apps in 2026).

## Agent session webhooks

Enable the **agent session events** category on the OAuth app.

| `action` | Meaning |
| --- | --- |
| `created` | New session (delegation or mention). Start a run within **10s** (thought activity or `externalUrls`) or Linear may mark the session unresponsive. |
| `prompted` | Follow-up user message in an existing session (`agentActivity.body`). |

Payload highlights:

- `promptContext` — formatted XML-ish string with issue, threads, and workspace **guidance**.
- Structured fields: `agentSession`, `agentSession.issue`, `previousComments`, `guidance`.
- Respond to HTTP webhook within **5 seconds**; heavy work belongs in `waitUntil` / a queue (Shiba uses the Automations DO + orchestrator approval path).

## Agent activities (outbound)

Create activities with GraphQL `agentActivityCreate` or the TypeScript SDK `createAgentActivity`. Allowed `content.type` values include `thought`, `elicitation`, `action`, `response`, and `error`. Shiba’s Worker posts a **`thought`** ack on `created` when `LINEAR_API_KEY` / OAuth access token is configured; without credentials the handler records a skip (mock mode).

Update session metadata with `agentSessionUpdate` (`externalUrls`, optional `plan`).

## Shiba mapping

| Linear | Shiba |
| --- | --- |
| `AgentSession` id | Thread key `linear:session:{id}` and automation command receipt |
| `promptContext` | Frozen task text on the approval card |
| Issue identifier (e.g. `ENG-123`) | Optional `linear` automation trigger filter on team key |
| PR opened from a run | Worker may call `agentSessionUpdate` with `externalUrls` when publish succeeds (future hook; session id stored on run metadata when present) |

Webhook ingress: `POST /api/linear/webhook` (signature-verified when `LINEAR_WEBHOOK_SECRET` is set). Automations may include a **`linear`** trigger (`linear.issue.delegated`, `linear.session.prompted`) alongside existing GitHub/Slack/webhook kinds.

Live Linear OAuth and workspace installs are **not verified** in CI; use mocks and label evidence **NOT VERIFIED** until an operator connects a test workspace.

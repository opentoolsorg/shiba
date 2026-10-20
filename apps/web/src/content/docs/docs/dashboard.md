---
title: Dashboard
description: Compose, approve, observe, and interpret the current interface.
---

Sign in at `/app/` — the first account created becomes the only account (sign-up closes after it). A first-run wizard then walks through channels, connecting an agent provider, and model routing; every step is skippable and it never re-opens once finished.

The sidebar groups surfaces for normal use: **Workspace** (Dashboard, Tasks, Activity, Analytics, Diff, Approvals, Automations), **Capabilities** (Agents & MCP, Providers, Skills, Integrations, Mailbox, Memory), and **System** (Settings). **Activity** streams the orchestrator's event spine (`GET /api/spine` — decide→append→apply events plus the side-effect outbox); **Analytics** is the run-record and usage surface (`/api/usage` aggregates). Light/dark theme follows the in-app toggle on every surface.

Enter an HTTPS GitHub URL, base branch, and bounded task. Start without publishing. The planning agent proposes `delegate_coding_task`; read the **exact tool input** on the approval card, then approve or reject. The same gate applies to queued runs from **Approvals** (`POST /api/runs`). Approval is a workflow gate, not installation authentication.

## Phase 1 thread panels (Tasks view)

After the first message in a session, the timeline footer shows run outcome panels for the latest retained run on that thread:

| Panel | Meaning |
| --- | --- |
| **Run progress** | Registry status (`pending`, `running`, `completed`, error family). Includes a direct **Open pull request** link when `pullUrl` is on the run row. |
| **Pull request** | Live GitHub status from `GET /api/v1/threads/:id/pr/status`, with a waiting state while publish is in flight and a fallback link from `pullUrl` when GitHub status is not ready. |
| **Review findings** | Review round from `GET /api/v1/threads/:id/pr/review` when **Read-only review after publish** was frozen at approval. Failed rounds expose **Retry review** (`POST …/pr/review/retry`), which re-runs the reviewer unless the only failure was posting an already finished review. |

The composer shows **Sending task…** while a submit is in flight and **Planner responding** while the orchestrator is still streaming — the Send button stays disabled in both cases.

## Progress and results

The SDK supplies connection state. Vite-only development has no Worker backend, so connection errors are expected there.

Clone/configure/code/collect phases stream, but the runtime awaits the OpenCode process before returning its output. Token-level OpenCode streaming is not implemented. Inspect the final transcript for changes, bounded diff, errors, and any PR URL. The retained run API also stores `pullUrl`, `reviewAfterPublish`, and review round metadata for the panels above.

The parent currently treats string child output as completed, including possible error text. **Read the transcript, not just a completed badge.** An empty diff is not evidence of successful edits.

## Missions, Gates, VM, Runs

These surfaces were deleted, not just hidden — recurring goals live in **Automations**, sandbox state is summarized on the **Dashboard**, run records live on **Analytics**, and approvals land in the **Approvals** queue. There are no `?tab=` deep links for them; the code is gone.

## Providers and Integrations

**Providers** lists ACP agent adapters (Claude Code via `claude-agent-acp`, Codex via `codex-acp`, Gemini CLI, OpenCode, and the Grok CLI). Each card connects with subscription sign-in (Claude and ChatGPT, reusing the deployment's subscription probe) or an API-credential fallback, then shows status, test, disconnect, and the org default. The page reads `GET /api/providers`. The first-run wizard reads that same registry and links here; it does not call `/api/auth/*-subscription`. Grok's pinned CLI is not an ACP server; its card says so. **Agents & MCP** holds only the MCP gateway: the `/mcp` endpoint, client configuration snippets, token minting, and registered agent principals. **Skills** is the saved-skill manager — name, optional GitHub repo, notes; picked skills ship in a run's preamble so the executing agent receives them. **Integrations** lists third-party apps (GitHub, and coming-soon rows for Notion/Linear/Jira/Asana), chat & approval channels (Slack, Telegram, Discord), and email — not AI providers.

The composer also offers saved repositories (autocomplete seeded from run history) and per-purpose model routing — connections and purpose pins come from `/api/model-config` (`{connections, policy, purposes}`), where `connectionId` picks the credential route and the harness/model pair rides the approved run's frozen route.

## Cancel and clear

Cancellation updates the registry before best-effort sandbox destruction. A successful request does not prove the process stopped. Verify shutdown for sensitive work.

Clear history asks for confirmation and clears chat plus retained registry records. It does not erase all child Durable Object data or stop active containers. Cancel and verify active work before clearing. If only part of the clear succeeds, the UI reports partial success; refresh to recheck retained state.

Review every generated diff and truncation marker. Run the target repository's tests before adoption. See [GitHub](/docs/github/) for publication fidelity limits.

---
title: Architecture
description: How a request moves from an AI employee to an approved, reviewable result.
---

Shiba brings your people, AI employees, instructions, and work together in a workspace you run. Its dashboard and connected channels send requests to a Cloudflare Worker, which coordinates the conversation, approvals, and execution.

A marketing brief, research report, operating checklist, and code change can all follow the same reviewable workflow. The employee's instructions and available tools shape the work; the configured runtime determines what it can actually do.

## From request to result

1. **Create an employee and start a thread.** Choose an employee or create one with your own instructions. Describe the outcome, supply context, and choose a repository or artifact workspace for file-producing work. Employee app tasks use their own granted resources.
2. **Review the request.** Shiba records the requested task and presents an approval. Check the exact task, work target, and settings before approving it. Queueing does not start a sandbox.
3. **Run the approved work.** The orchestrator dispatches the approved task to a configured execution target. For sandbox runs, the harness works in an isolated container and returns its result and status.
4. **Review the output.** Read the response, inspect the files and changes, and check the reported evidence. Continue in the thread or start a separate task. Publishing is a separate decision.

[Start your first task](/docs/getting-started/) · [Understand approvals](/docs/approval-gates/) · [Review a result](/docs/dashboard/)

## The workspace

| Part | What it does |
| --- | --- |
| **Employees** | Save a role, instructions, model connection, and task defaults for repeat work. |
| **Threads and work** | Keep conversations, tasks, results, and review decisions in context. |
| **Skills** | Store reusable instructions for work such as research, writing, or review. |
| **Connections and tools** | Make configured services available within the access and policies granted to the employee. |
| **Automations** | Request recurring or event driven work. Every execution waits for human approval. |

An employee's role does not grant access to a service by itself. Availability depends on the installation, connected accounts, and tool policy. See [Employees](/docs/employees/), [Skills](/docs/skills/), and [Product status](/docs/product-status/).

## Execution and boundaries

The dashboard and configured channels reach Worker routes that authenticate requests and connect them to an orchestrator. The orchestrator retains task and approval state, dispatches work after approval, and records the outcome. Storage bindings support account and audit data, credentials, attachments, and optional memory.

Model and subscription credentials are attached by the Worker egress proxy. The sandbox receives a placeholder rather than the real credential. GitHub access is denied until a repository scope is approved and is limited to that repository. See [Security and privacy](/docs/security/) for the boundaries and [Readiness](/docs/readiness/) for verification status.

A connected provider or listed integration is not proof of access to a particular account. Check the connection and test the relevant workflow in your installation. Non-code drafts can use an artifact workspace without a repository. An employee does not automatically publish a campaign, send a customer message, or perform a financial transaction. See [Connections and tools](/docs/connections/) for the distinction between accounts, employee grants, and actions.

## Source map

| Area | Where to look |
| --- | --- |
| Dashboard and navigation | `apps/frontend/src/app.tsx` and `apps/frontend/src/components/` |
| Worker routes and authentication | `apps/backend/src/index.ts` and `apps/backend/src/request-auth.ts` |
| Orchestration and approvals | `apps/backend/src/agents/orchestrator.ts` |
| Sandbox execution and egress | `apps/backend/src/runtime.ts` and `apps/backend/src/egress.ts` |
| Employee templates | `packages/shared/src/agent-templates.ts` |
| API contract | `apps/backend/src/v1/openapi.json` |

## Alternative runtimes

Execution options depend on the configured deployment. A paired local computer and supported sandbox providers have different setup requirements; consult [Remote access](/docs/remote-access/) and [Sandbox providers](/docs/sandbox-providers/) before choosing one. The computer adapter is not a production-ready default. See [Product status](/docs/product-status/) for current limitations.

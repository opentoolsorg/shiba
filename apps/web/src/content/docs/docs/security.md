---
title: Security
description: Authentication, credential boundaries, and known limitations.
---

## Installation boundary

Each installation is account-owned; the application does not provide cross-customer multi-tenant isolation. Configure and verify an identity system before exposing dashboard or runner endpoints. An obscure URL is not protection.

Shiba supports Cloudflare Access and the configured built-in Better Auth cookie-session lane. With `ACCESS_AUD`, Access JWT validation checks the issuer, signature, and audience before deriving the user's email. A client-supplied email header is not an identity proof. Better Auth checks the signed-in session when that lane is configured. Without an identity system, only loopback development hosts bypass the gate; deployed API requests fail closed.

Signature-authenticated Slack/GitHub routes, automation webhooks, bearer-token MCP/local-runtime routes, and supported authentication endpoints have their own route-specific checks. Configure matching Access policies or bypasses for integrations that need them. `OPEN_DASHBOARD` can expose the static dashboard shell, not private APIs, identity, or execution authority.

Authentication is only the first layer. Invited team membership is not deployment-operator authority. Provider setup, fleet administration, and deployment MCP configuration have separate restrictions. Room access, employee capabilities, account/resource grants, and action approval also remain separate. See [Permissions and roles](/docs/permissions/).

These are implementation and test claims, not proof that a deployed hostname has the intended policy. `VERIFICATION.md` records a dated forged-header 401 check but no cloud end-to-end coding run. Validate your actual hostname and account roles.

## The credential boundary

Provider credentials are not supplied to provider-backed harnesses in the container: they receive a dummy key and provider requests are forwarded at Sandbox egress (`apps/backend/src/egress.ts`). These boundaries have unit coverage; do not treat that as proof of a cloud deployment:

- **Model traffic.** The container is given a dummy key and calls its selected provider host. The Worker forwards supported provider requests through the configured AI Gateway binding; successful inference still depends on account configuration and credentials. There is no provider callback route.
- **ChatGPT plan traffic (standard SIWC).** `codex-subscription` receives an `ACCESS_TOKEN` placeholder. The Worker resolves the signed-in user and attaches the real bearer at the `api.openai.com` egress boundary; refresh stays in the per-user `ChatGptAuth` Durable Object. Real OAuth tokens and `auth.json` are not supplied to that run container.
- **Repository traffic.** `GITHUB_TOKEN` is attached in the Worker, never in the container.

Opt-in authentication modes can have different security limits. In particular, the Antigravity container-profile path does not meet the same Worker-only credential boundary. Review [Model authentication](/docs/model-auth/) and [Configuration](/docs/configuration/) before enabling a non-default lane. Do not move standard SIWC OAuth exchange or refresh into a task sandbox as a workaround.

### Deny-by-default egress

`Sandbox.allowedHosts` is an allowlist evaluated *before* any outbound handler. The Sandbox allowlist restricts outbound hosts; tests exercise the configured policy and handlers. This is an implementation/test claim, not a cloud penetration-test result. `registry.npmjs.org` is deliberately **not** on the list in v0.1: it would enable `npm install` inside runs and is simultaneously the widest exfiltration channel available.

### The GitHub credential is scoped per run

`github.com` defaults to **refusal**. Before the clone, the run calls `approveRepoScope("/owner/repo")`, which installs a scoped forwarder for that one path. Requests to any other repository get 403 with no `Authorization` header attached: repository code cannot reach every repo the token can. Sibling repositories that share a prefix (`/owner/repo-evil`) are refused too.

A run that never scoped itself gets no credential at all.

## Automation safety

An automation schedules requests; it cannot approve them. `authorizeAutomationRun` applies these controls:

1. **Every allowed workspace run requires human approval**, including artifact-workspace runs. Legacy `unattended` fields do not bypass the gate.
2. **Targets stay constrained.** Artifact-workspace automations support schedule triggers and cannot request PR publication or connected-app mutations. Completed repository changes require a separate publication approval.
3. **Per-automation daily request limits and enable switches apply.** A schedule or webhook loop can otherwise consume resources before somebody notices.

An optional `runWhen` condition is evaluated before the coding-run approval is queued. When `TYPESAFE_API_KEY` is configured, evaluation uses TypeSafe Noul; otherwise it uses Workers AI. The check sends the relevant condition/event context to that service and can incur usage even when no coding run is approved. Errors, empty answers, and answers that are not clearly affirmative fail closed and record a skip reason.

Use **Disable** in **Deployed Automations** to stop future requests. This does not cancel previously queued or running tasks. Operators also have the deployment-wide `AUTOMATIONS_ENABLED` switch. See the [automation reference](/docs/automation-reference/).

## Other implemented safeguards

- Repository URL validation requires HTTPS GitHub and rejects embedded credentials.
- Dynamic shell arguments use tested POSIX quoting helpers.
- The parent delegation tool requires human approval of the exact structured input that will execute, never a summary of it.
- Slack requests are verified with a v0 HMAC and a 5-minute replay bound; Block Kit approvals additionally require the clicker to be on `SLACK_APPROVERS`, because a signature authenticates Slack, not the human. An unset allowlist means nobody can approve from Slack.
- Run results are parsed from a structured envelope, so a failed run cannot display as a successful one.
- Output paths apply bounds and known-pattern redaction. This is not a guarantee against arbitrary secrets or binary data. Never put secrets in tasks or repositories.
- Cancellation keeps its terminal registry state against late completion; container destruction is best-effort.

## Retention and review

Clearing history or the run registry does not erase all child Durable Object data or stop running containers. Review retention and deletion requirements before using confidential repositories.

Owner-private memory retention excludes expired sources from recall; it does not delete uploaded originals or rewrite approved snapshots. Artifact ZIP links expire after seven days, but anyone holding the complete signed link can use it before expiry. See [Context and memory](/docs/context-and-memory/) and [Files and revisions](/docs/artifacts/) for deletion and sharing behavior.

Treat generated output as untrusted. Review changes and run tests. Use least-privilege credentials restricted to the needed resources. Publishing opens a PR and never merges it. Repository capture validates supported file types, bytes, and limits against an immutable snapshot, and fails rather than intentionally publishing a partial captured tree. A shortened diff display is not the complete review record.

Sources: [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/), [service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/), [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

Local implementation: `apps/backend/src/index.ts`, `apps/backend/src/request-auth.ts`, `apps/backend/src/team-member-auth.ts`, `apps/backend/src/employee-tool-policy.ts`, `apps/backend/src/egress.ts`, `apps/backend/src/sandbox.ts`, `apps/backend/src/security.ts`, `apps/backend/src/automations.ts`, and `apps/backend/src/agents/orchestrator.ts`. See [Readiness](/docs/readiness/).

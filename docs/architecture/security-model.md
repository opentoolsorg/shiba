# Security model

This is the architecture's real contract — the part that must not drift.
Five invariants, each with an existing enforcement point:

1. **Approval before execution.** No sandbox starts without a human approving
   the *frozen* input. The `ApprovedRoute` pattern freezes what was approved and
   revalidates at dispatch.
2. **Deny-by-default egress.** `allowedHosts` is set per run to the selected
   harness's provider host + git — **never the union across harnesses**.
3. **Scoped git credentials.** `github.com` defaults to *refusal*;
   `approveRepoScope("/owner/repo")` installs a repo-scoped forwarder before the
   clone, so repo code cannot reach any other repo the token can see.
4. **Secrets stay out of the container, logs, URLs, and UI.** Dummy key inside
   the container; automation webhooks are header-only; no secret in a query
   string or an error message.
5. **Per-surface authentication.** Access-gated APIs, signature-verified Slack
   and GitHub, header-secret Telegram/Discord/email, DMARC-verified email task
   intake (`channels/email`), bearer-token `/mcp`, and a
   narrow explicit bypass list. A new ingress surface must add its own
   mechanism, never inherit one.

   The dashboard itself has two interchangeable identity lanes
   (`better-auth.ts`): the Cloudflare Access email header, or — when
   `BETTER_AUTH_SECRET` is set — built-in email+password sign-in with
   signed-cookie sessions served at `/api/auth/*` and accounts stored in
   the AGENT_AUDIT D1 database. Access wins when both exist; sign-up
   closes after the first account. With neither configured the gate stays
   fail-closed — loopback only.

Two stated properties, not accidents:

- **Token revocation has no in-flight propagation.** `revokeToken` writes a KV
  tombstone; a request verified microseconds earlier still completes. For an
  approval-gated system that trade is acceptable, but it is a trade.
- **Audit stores arg hashes, never args.** A reader can prove two calls were
  identical but cannot see what was asked — the right trade for customer
  repos, and a weaker claim than "we logged it".

**Why this is architecture and not a feature:** every parity feature in
`PLAN.md` §17 that touches ingress — OAuth on `/mcp`, Teams, more repo
providers — is a chance to weaken one of these. That is why §17.3 lists the
invariants as non-negotiable acceptance criteria, not as context.

---

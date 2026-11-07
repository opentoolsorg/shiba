# Custom MCP OAuth: bounded public-client support

Base: PR #199 head `3c7b8c2709a70bc008f878d351b858bf458725c3`.

## Implemented

- Custom HTTPS Streamable HTTP servers can use the existing owner-scoped OAuth begin/callback routes with a pre-registered public client ID, exact issuer and optional scopes. The dashboard exposes this setup after saving an OAuth draft.
- Custom resource and issuer hosts must both be explicitly operator-allowlisted. Resource metadata stays on the MCP origin; authorization/token/revocation endpoints stay on the pinned issuer origin. Resource metadata must identify the exact MCP URL and advertise the pinned issuer. Public-client authentication, code response and PKCE S256 are required.
- Discovery requests reject redirects and invalid destinations. Every derived issuer metadata URL is checked before fetch, including OIDC fallback paths; network-path issuer ambiguity is rejected for curated and custom flows.
- Existing encrypted PKCE and token storage, one-use owner-bound state, generation binding, refresh locking, credential deletion and tool approval remain in use. Custom issuer trust is retained in encrypted state/credentials and rechecked before credential egress. Issuer response parameters are checked when present and required when advertised.
- Discovery before custom consent leaves the draft unchanged and returns `oauth_sign_in_required`. Dashboard discovery is disabled until consent. Changing endpoint or credential generation discards both ready and in-flight sign-in links. Disabling a server revokes local authority and cancels pending consent.

## Local evidence

- 119 tests passed across custom OAuth, existing OAuth, external MCP, employee external MCP and credential/approval tradeoff contracts.
- 29 dashboard tests passed across custom OAuth, existing external management, curated connections and the extension MCP registry view. Includes unsafe sign-in links, repeated start clicks, disable during sign-in, credential changes during/after sign-in, and refresh back to review.
- Backend source/test TypeScript checks and frontend TypeScript check passed.
- Frontend production build passed. Repository Biome lint and backend/frontend ESLint import checks passed with the existing warning backlog; changed-file lint also passed.

## Limits and incomplete aggregate checks

- No dynamic client registration, confidential-client secrets, cross-origin OAuth endpoint support, arbitrary-domain DNS/IP pinning, stdio or SSE-only support. Operators must trust the allowlisted domains and their public DNS.
- No live provider account consent, browser end-to-end acceptance, merge, deployment or publication was performed. Local fixtures do not establish provider/account compatibility.
- Provider-side revocation is best effort; local encrypted credentials are deleted even when the endpoint is missing, no longer trusted or unavailable.
- A full frontend run initially reported two failures: the default draft request-body regression was fixed and its extension registry tests now pass; the unrelated `FounderReconciliationAutomaticSlack` disabled-fieldset assertion remains outside this change.
- The full backend run did not complete: it encountered an unexpected external `api.typesafe.ai` request that was blocked. It was not retried. Earlier failures included employee-fixture process-group cleanup and a phase1 core-loop assertion; these are not claimed resolved.
- Aggregate Knip reports existing unused files/dependencies/exports beyond its issue threshold. Docs output verification could not run because the full assembled `public/` build is absent. A complete final repository gate remains required after integration.

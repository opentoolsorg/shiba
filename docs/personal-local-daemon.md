# Personal native CLI account execution

The personal daemon adapter is separate from the legacy deployment-operator
daemon. Its tests use fake CLIs, Git and Worker responses. No real subscription
login, model inference, entitlement or hosted deployment is verified by these
tests. The account receipt means **local account observed**, not provider
entitlement or hardware attestation.

| Adapter | Implemented account probe | Current boundary |
| --- | --- | --- |
| Claude Code | `auth status` JSON, first-party `claude.ai`, configuration-directory match, file login | Linux; CLI 2.1.268 or later within 2.1; keychain-only, API-key, external-token/provider routes unavailable |
| Codex | App-server `account/read` with `refreshToken:false`, ChatGPT identity plus selected file login | Non-Windows; CLI 0.157.1 or later within 0.x; API-key, Bedrock, external-token and missing identity routes unavailable |

Inspect one locally authenticated account without logging in or running a model:

```sh
node scripts/shiba-local-daemon.mjs --inspect-personal-auth codex
```

The command prints only the versioned receipt and nonsecret hashes. Select that
exact account using the dashboard's personal pairing command, with explicit
`--personal-harness`, `--personal-billing native-subscription` and
`--personal-account` fingerprint flags. Pairing obtains owner/workspace identity
from the authenticated server nonce. A local flag cannot assign an owner. The
saved machine token remains private mode 0600; never paste it into a room.

The initial execution slice accepts only an approved direct public HTTPS GitHub
repository task with an explicit matching provider/model, owned machine, current
membership/grant versions and unexpired original approval. No coordinator,
specialists, cloud/provider fallback, connected-app configuration, setup scripts,
test commands, alternate binaries or resumed sessions are accepted. The server
independently verifies frozen task/context hashes and consumes approvals.

## Execution route limits

The operator local runtime now has a bounded repository-free execution primitive.
The explicit artifact target and exact requested deliverables travel in the
validated mailbox envelope; an empty repository URL without that target is
rejected. The daemon creates a fresh work directory without Git clone/init,
then captures **only** the approved files using the existing complete-text
capture: at most eight non-hidden md/txt/json/csv files, 16 KiB each and 64 KiB
total. Missing, partial, binary, oversized, symlinked or hard-linked outputs fail
closed. The Worker rechecks the file set and content before existing private
artifact persistence. Unrequested files, repository diffs and base revisions
are not accepted as local artifact output. No automatic account/runtime fallback
or repository publication is allowed.

This is not broad local directory export or OS sandboxing. Fresh HOME/work
paths do not isolate a malicious same-user program. Personal native-account
grants remain repository-only and cannot use this operator primitive. Existing
cancellation, deadline, claim/retry and process-termination handling is reused;
process continuation and unacknowledged local output are not guaranteed after a
crash. Authenticated dashboard intake and route-picker enablement must be
integrated separately before advertising local artifact tasks in the product.
The sandbox route still supports broader ephemeral output discovery/archive;
local exports intentionally require nonempty explicit paths.

Native **cloud** Claude login is also unavailable. A generated per-user pathname
is not a mounted, authorized volume. The reserved harness reports no supported
runtime, returns no volume and refuses direct configuration/launch or successful
verification. Persisting native login credentials inside a cloud container would
violate the repository's credentials-never-container invariant, even if Shiba did
not read those files. Adding volume support alone would not resolve that conflict;
an invariant-preserving authentication design and explicit product/security
review are required. Do not relay native bearer/refresh tokens or run cloud
`claude auth login` as a workaround. API Claude Code and paired local Claude Code
remain distinct, explicitly selected routes; no real login or inference was used
to verify these guards.

Each run receives a fresh HOME containing only the selected provider's login.
Provider API keys, alternate endpoints, Git credentials/helpers, SSH, proxy and
daemon tokens are omitted from child environments. Public clone failures have no
credential or branch fallback. Known project and system CLI configuration is
unsupported; fixed native CLI options disable extra apps, MCPs, hooks and agents.
This prevents accidental fallback; a fresh HOME is **not an OS security sandbox**
against a malicious same-user program or compromised native CLI. Local status
also does not attest all remote or MDM policy. Real execution remains subject to
the selected provider's supported authentication and usage rules.

Credential bytes, native CLI version and account identity are hashed locally;
token refresh/account/version drift requires a new grant and approval.
Unrecognized credential-file fields or additional account/MCP credential maps
are rejected before staging, rather than copied into the run HOME. Receipts
refresh during active runs. Before clone and native launch the daemon rechecks
the exact account and remote claim. An uncertain command is never relaunched.

Interactive permissions bind the entire native request to a canonical SHA-256
hash and the original approval deadline. Only complete reviews up to 2,000
characters may reach the dashboard. A secret-bearing or oversized review is
denied locally rather than displayed partially. Generic/session-wide permissions
are unavailable. A human decision is first-click-only and consumed once; response
hash/expiry mismatches, revocation and cancellation stop execution. Selected auth
copies are removed after confirmed process termination.

Personal uploads are bounded as complete UTF-8 JSON bodies: 16 KiB for control
and account messages, 1 MiB for event messages, and 8 MiB for final results. An
oversized result becomes a small explicit transfer failure with no partial
files or diff. A server 413 receives at most one small failure receipt; neither
case relaunches the CLI. Event 413 stops execution. Ephemeral cleanup still
applies, so a failed transfer does not promise later local output inspection.

Primary interfaces checked on 2026-11-05:

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude managed settings](https://code.claude.com/docs/en/managed-settings)
- [Codex app-server account API](https://learn.chatgpt.com/docs/app-server)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Deterministic verification commands:

```sh
node --test scripts/personal-cli-auth.test.mjs scripts/personal-daemon.test.mjs
pnpm -C apps/desktop test test/daemon.test.ts test/link-operator-auth.test.ts
pnpm -C apps/backend test test/agent-harness.test.ts
```

The actual-daemon fixture covers account/owner mismatch, missing ambient fallback,
revoke/cancel, owned-process cleanup, unrelated-process survival, exact permission
hash/expiry, consumed/mismatched responses, private auth review denial and an
empty-mailbox restart. It substitutes the Worker, CLIs, Git and absence of managed
settings. Live native coding and quota behavior need a separately authorized
account and an installed compatible CLI; these fixtures do not establish them.

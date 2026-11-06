# Shared computer: online and agent boundary

Status: **blocked for online browsing and agent control; offline human desktop only**.
Inspected at `d424d0385ae632fda3f802356f845301bf1774b9`. This design does not enable
network access, change the API, approve execution, or certify live Cloudflare behavior.

## Design follow-up

The owner selected **online browsing design first** and **model funding only**
on November 6, 2026. The [staged proposal](shared-computer-online-design.md)
recommends a separate public, human-controlled browser mode, lists approval and
transport proof gates, and leaves activation and external catalog selection
unapproved. It does not relax this offline boundary or authorize agent control.

## Actual transport and enforced boundary

- `apps/backend/src/computer-session.ts` owns a dedicated raw Workers `Container`
  in a per-session Durable Object. It is not `Sandbox` and does not inherit that
  runtime's egress proxy, repository authority, credentials or provider adapters.
  `startSession` uses `enableInternet: false`, a pinned approved image, no snapshots
  or mounts, only an expiry environment value, and an offline purpose label.
- `packages/shared/src/shared-computers.ts` defines the strict
  `shiba.offline-computer.v1` contract: `internet: false`, `credentials: null`,
  `sources: []`, human viewers/controllers and no domain grant or agent control mode.
  Unknown preparation, funding, start, lease, input and capture fields are rejected,
  not silently treated as approved extensions.
- `apps/backend/src/shared-computer-routes.ts` requires a verified native account,
  explicit workspace header and current team/room membership. Bearer/agent
  principals and Access-only identity cannot authorize this surface. The owner
  reviews the immutable contract; a distinct bootstrap operator funds it; the
  owner separately consents to shared display before allocation.
- `shared-computer-store.ts` pins membership/account versions, room identity,
  participants and policy in the contract digest. Live source checks revoke
  capabilities when selected participants or room authority change. Input requires
  an exclusive expiring human lease. No application API grants an agent a lease.
- `shared-computer-auth.ts` signs backend-only, operation-specific, ten-second
  capsules with workspace, session, account, version and digest. The DO consumes
  operation and command IDs durably. Input is fixed argv, sequence-bound and
  hash-bound; typed text and frame bytes are not persisted in command audit rows.
- Revocation and STOP fence subsequent effects and frame release. STOP retains
  narrow immutable native owner/funder authority after workspace removal. The
  runtime alarm and independent image watchdog bound lifetime. These controls
  cannot retract pixels already delivered or undo an already-dispatched input.
  Unknown execution outcomes are not automatically replayed.

## Why an online switch is not a safe implementation

The current desktop has **no outbound policy handler**. The coding sandbox does
install `interceptAllOutboundHttp` and `interceptOutboundHttps("*", ...)` in
`apps/backend/src/sandbox/durable-object.ts`; copying its provider/repository
permissions into a computer would grant unrelated authority.

Installed Workers types expose raw interception methods, so online enforcement is
not inherently impossible. But `ContainerInfo` currently exposes image/labels,
not an attestation that all network paths are intercepted. This desktop has no
runtime HTTPS interception trust setup, approved host manifest, per-request
workspace grant check, browser request classifier, or agent approval contract.
Its image entrypoint launches Chromium with `--no-sandbox`; the Dockerfile creates
a desktop user but does not select it with `USER`. That is an existing offline
VM assumption, **not an acceptable reviewed hostile-web browser configuration**.
No new exploitable online path is enabled by this change.

Cloudflare's [outbound traffic documentation](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
(last updated October 29, 2026; consulted November 5) documents deny-by-default
networking with approved outbound handlers and warns that with internet enabled,
other ports bypass HTTP host filtering. HTTPS interception needs runtime CA trust.
The high-level `@cloudflare/containers` configuration described there is not an
API already used by this raw-Container desktop; it must not be assumed installed
or verified just because those examples exist.

## Public fetch into the offline desktop: feasibility finding

A smaller alternative is feasible **without any container network access**:
Worker-side retrieval of one explicitly approved public document, followed by
human-reviewed plain-text insertion into the existing offline notes field. This
would be an import of a static excerpt, not interactive online browsing. The
current fixed-argv `xdotool type -- ...` path accepts bounded text (1,024 bytes),
and `desktop.html` is a local page with no scripts and `default-src 'none'`.
Consequently literal URLs/HTML typed into its textarea do not acquire navigation,
script, subresource, cookie or agent authority. No new runtime isolation primitive
is necessary for that **inert-text** product; it does not need the Chromium
online-sandbox changes described above.

The repository's existing “prefetch” is specifically
`apps/backend/computer/precache-debs.mjs`, not a runtime web-content service. Its
adjacent `pinned-debs/README.md`, fixed manifest validation and fixture tests prove
that it accepts only reviewed content-addressed Debian package URLs with exact
sizes/hashes, rejects redirects and arbitrary URL/output CLI options, and writes
only to its local build cache. It is not shipped as a Worker document importer,
not bound to native workspace consent, and cannot write into an existing desktop.
Do not widen this build helper into an arbitrary user-URL fetcher or treat its
package retry policy as permission to replay browser actions.

**Precise remaining choice:** approve a reviewed fixed catalog of public document
URLs (or public content-addressed text snapshots) versus arbitrary user-entered
URLs. A fixed catalog can use credential-free HTTPS GET with no redirects,
cookies or authorization, strict text-only bytes/time limits and a digest-bound
human preview before the existing lease/input path inserts the excerpt. The
catalog must be selected explicitly; package-cache authority is not consent to
contact a different public service. A GET can have external effects even without
credentials, so “read-only” is a product description, not a universal guarantee.

Arbitrary user URLs need a distinct SSRF-safe retrieval policy and network proof.
`validateRunnerUrl`/`isPrivateOrLoopbackHost` in `security.ts` reject literal
private hosts but do not resolve DNS or pin public destination IPs; they are not
a DNS-rebinding defense for arbitrary documents. The current Worker fetch path
provides no repository-established per-request public-IP pinning primitive.
Thus adding an arbitrary URL parameter based on those checks would be unsafe.

The safe next increment is a separately reviewed **public text excerpt import**:
fixed catalog, native human initiation, current workspace/room membership,
explicit disclosure of URL and shared viewers, bounded retrieval with no automatic
retry, secret-text rejection, and current account/source/digest/lease checks both
before fetch and before display. Keep fetched content inert; never send it to a
model automatically. Revocation cannot recall already sent text or an already
issued HTTP request. No site credentials, public fetch endpoint, agent lease,
container egress or implicit catalog choice is introduced here.

## Required online implementation, separate from offline v1

1. **Immutable opt-in contract:** introduce a separately versioned online policy.
   Bind workspace, native requester/account versions, room audience, image, exact
   canonical HTTPS hosts, ports, time/byte/request budgets, allowed actions,
   human/agent mode and expiry into a reviewed digest. No wildcard, arbitrary IP,
   localhost, private/link-local address, metadata destination or credential field.
   A domain permission is not permission to log in, submit forms or spend money.
2. **Isolation first:** use a dedicated browser image and fresh per-session profile,
   unprivileged browser with validated Chromium sandboxing, no coding harness,
   host mounts, shared login state, extension loading, debugging listener or
   inherited model/repository tokens. Validate runtime CA trust without baking
   credentials or trusting a build-only CA. Prove compatibility before approval.
3. **Fail-closed network:** retain `enableInternet: false`. Install dedicated
   HTTP/HTTPS interception before browser readiness, with a computer-only policy
   service bound to session/workspace/digest/generation. Failure to install any
   interceptor retires and destroys the attempt. Recheck current grant, account,
   room and revocation on every forwarded request. Resolve destinations safely;
   reject private IPs, rebinding, authority confusion and disallowed ports. Disable
   direct DNS/DoH, QUIC, UDP, arbitrary TCP, CONNECT tunnels and unsupported
   WebSockets unless the actual transport proves deny-by-default enforcement.
   Check every redirect and subresource independently. Log metadata, not cookies,
   authorization headers, submitted text, page contents or response bodies.
4. **Read is not guaranteed by GET:** even a GET navigation can mutate a remote
   account. Start with unauthenticated public pages from approved fixtures/sites;
   deny uploads, downloads and authenticated profiles. URL/method restrictions
   alone do not prove a site is read-only. Authenticated browsing requires a
   separate credential/session design, explicit user consent and security review;
   no login credentials or browser cookies may be exposed to models or other teams.
5. **Separate human and agent authority:** keep current human lease behavior.
   Agent proposals must identify run, model/provider, exact session/digest, action
   and screenshot audience. A verified human approves a bounded agent lease;
   models cannot approve themselves, borrow a human capsule or widen domains.
   Human takeover revokes agent leases. Navigation/site content is untrusted data,
   not permission to submit, authenticate, upload, publish or purchase. Every
   external write requires a distinct action approval; payments remain disabled.
6. **Revocation and recovery:** atomically increment a policy generation on STOP,
   membership change, domain removal or takeover. Block new outbound requests,
   inputs and frame delivery; abort active streams where supported and destroy
   on uncertainty. Report requests already dispatched as potentially effective.
   Persist claims and minimal receipts; never retry an unknown navigation/action
   automatically, restore an authenticated browser profile silently, or promise
   zero-loss process/browser recovery.

## Acceptance and product decisions

Fixture regressions in `apps/backend/test/shared-computer.security-v3.test.ts`
now cover attempts to add internet, domains, credentials, agent mode or sources;
control-gate escalation without consuming a valid claim; and signed human capsule
reinterpretation. Existing `shared-computers.test.ts` and
`shared-computer-image-policy.test.ts` cover native identity, isolation, revocation,
expiry, duplicate effects and uncertain outcomes. These are SQLite/DO fixtures
with a fake Container, not browser networking or live-service acceptance.

Before online activation, require actual dedicated-image/Cloudflare transport
proof for denied HTTP/HTTPS, private destinations, redirects, DNS/rebinding,
nonstandard ports, QUIC/WebSocket/tunnel bypass, unavailable policy service,
revocation during streams and replacement after uncertain effects. Add tenant
cross-session and agent/human takeover tests, including prompt injection and
secret-bearing response redaction. Keep production and preview unchanged until
that proof and the user's approval exist.

Decisions needed: initial public-domain allowlist and redirect/subresource policy;
whether agent observation and any authenticated browsing are in scope; who may
approve agent control; and maximum per-session network/resource budgets. No live
accounts, credentials or payments are needed for the next fixture implementation.
Managed integrated browser, desktop/CI and deployed transport acceptance remain
with the parent task; historical screenshots are not evidence of this design.

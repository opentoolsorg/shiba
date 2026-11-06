# Shared computer: proposed online browsing design

Status: **design only; not approved for activation**. Requested November 6, 2026.
Baseline inspected: `ccc1b8d4e1822102a71cfb50f57c9da925ccfefc`.

The product decision is to keep funding limited to bounded model usage and to
review an online browsing design before implementation. This document does not
turn on networking, authorize agent control, choose external sites, or grant
permission to run live tests. Existing offline sessions remain unchanged.

## Proposed first release

Recommend a separate, default-off **public browsing, human control** mode, not an
extension that reinterprets `shiba.offline-computer.v1`. It would open only a
reviewed catalog of unauthenticated public pages in an isolated disposable browser.
The initial engineering target is a controlled fixture site, not a production
service. An external catalog requires a further owner decision before contact.

Exclude login, cookies imported from another session, credentials, arbitrary URL
entry, form submission, uploads, downloads, clipboard/file bridging, extensions,
payments, model observation and agent input. A navigable public page can still
cause external effects; describe the mode as public browsing, not guaranteed
read-only access. A page requiring an excluded capability fails closed instead
of requesting a broader grant implicitly.

Static document import is a separate possible product. It must be labeled an
inert excerpt, not interactive browsing. The baseline branch contains no runtime
public-document importer; the build-time Debian package cache is not one.

## Authority and review contract

Introduce a distinct strict schema, proposed name `shiba.public-browser.v1`, with
no compatibility fallback to the offline schema. Bind these values into one
immutable review digest:

- Native owner and account versions, workspace, room, exact viewers/controllers,
  current membership/source versions, expiry and policy generation.
- Dedicated image digest, network-policy version, catalog revision and explicit
  navigation targets. Each target declares exact HTTPS authority, permitted path
  and query shape, and separate redirect/subresource rules. No wildcard hosts,
  IP literals, userinfo, nonstandard ports or ambient domain inheritance.
- Human-only control, approved display audience, bounded runtime and network
  budgets, metadata retention and explicit disclosure that remote requests may
  be effective before STOP completes.

Retain separate owner review, existing distinct operator resource authorization,
and owner display consent. Do not turn a model-funding grant into computer or
network authority. Model funding stays bounded model usage only: no payment
processor, card charging, browser purchases or automatic funding fallback.

Proposed fixture ceilings, subject to review before any external pilot: ten
minutes, one outstanding navigation, 100 total outbound requests, 2 MiB per
response and 10 MiB total response bytes. Reserve budget before forwarding;
charge redirects, subresources and failed attempts conservatively. Bound headers,
URL length, decompressed bytes, connection time and stream lifetime too. These
are proposed policy limits, not claims about currently enforced behavior.

## Architecture and isolation gate

Keep the existing offline runtime intact. A separately configured runtime and
image must establish the following before a browser can become ready:

1. Disposable unprivileged browser profile with working Chromium sandboxing;
   no root/`--no-sandbox` hostile-web configuration, coding harness, shared mounts,
   inherited tokens, debugging port, service credentials or reusable login state.
2. Deny-by-default networking with dedicated computer policy interception, installed
   before navigation. Do not enable unrestricted internet and rely on browser
   preferences as the security boundary. The current raw Container transport must
   prove enforcement; coding-sandbox egress grants are not reusable authority.
3. HTTPS trust and policy enforcement established for the actual running image.
   Every request is bound to session, digest and policy generation, and checks
   current authority before dispatch. Missing/unreachable policy denies access.
4. Destination validation at connection time, including public address resolution
   and pinning or an equivalent verified transport guarantee. Reject private,
   loopback, link-local, metadata, IPv4-mapped IPv6 and rebinding destinations.
   Existing literal-host validators alone are insufficient.
5. Every redirect and subresource gets fresh checks. Deny raw TCP/UDP, QUIC, DoH,
   CONNECT, WebSockets and unsupported protocols; prove bypass denial outside the
   browser as well. Block service-worker persistence and background navigation.
   Disable cached/offline replay across sessions.

Canonicalize URLs once for review and dispatch: normalize IDNs and trailing
dots, reject ambiguous encodings and userinfo, and validate path/query shapes
without permitting secret-bearing free-form query parameters. Use a minimal
outbound header allowlist; permit only catalog-approved GET/HEAD with no request
bodies and constrained query values. Strip cookies, authorization, Referer and
Origin; reject responses requiring cookie state and discard Set-Cookie. A renderer must not bypass the policy by choosing its own headers.

The browser must enforce navigation versus subresource policy and block excluded
input paths, including scripted submissions and browser shortcuts. Deny popups,
unreviewed new tabs, WebRTC, browser-internal/file URLs, external protocol
handlers, clipboard access, device/geolocation permissions and permission prompts. Method filters
alone cannot establish harmlessness. Start with a controlled catalog whose page
behavior is reviewed; if runtime guarantees cannot be demonstrated, do not ship
interactive online mode. A fixed inert-text import remains a separate fallback,
not evidence that these networking gates passed.

## Lifecycle, revocation and data handling

Use an explicit lifecycle: draft → reviewed → resource-authorized → display-
consented → starting → active → stopping → stopped/expired, with a terminal
unknown-outcome state. Do not allocate before the required grants. Consume
operation IDs durably; bind input to the exact generation, lease and sequence.

STOP, expiry, participant removal, account/source revocation, catalog withdrawal
or policy failure fences outbound requests, input and frame delivery. Increment
the generation atomically, terminate the browser and abort streams where the
transport supports it. Preserve narrow native owner/operator STOP authority after
membership removal. Already-dispatched requests and delivered pixels cannot be
recalled; report them honestly. Unknown actions are never automatically retried,
refunded as certainly unused, or restored into a fresh authenticated profile.

Use exact viewer checks before each frame release and exclusive expiring human
control. No model sees screenshots or page text. Audit only identifiers, policy
revision, counts, byte totals, timestamps and bounded outcome codes. Do not log
full URLs/query strings, page bodies, input, cookies or authorization headers.
Dispose of profiles, caches and temporary files with the session; never reuse
them across participants or replacements. Disable snapshots and document the
provider storage/deletion boundary with evidence: container termination alone
is not proof of physical erasure. Do not retain screenshots by default.
Keep content out of room history and reports by default. Retention and any future
export need their own disclosed limits and authorization; redaction is not proof
that arbitrary page content is safe to share.

## Separate future agent design

Agent observation and control are **not included** in the first release or
approved by this design request. They would require a second reviewed contract:
exact model/provider and screenshot audience, consent to disclosure, bounded
proposed actions, an independent native human approver, separate expiring agent
leases and human takeover that immediately fences agent activity. Page content
is untrusted input, never authority to widen domains, log in, upload, publish or
spend. External writes would need distinct action approval; payments remain out
of scope. A human lease or model-funding grant cannot be converted into agent
browser authority.

## Implementation sequence and evidence gates

| Stage | Deliverable | Required evidence before proceeding |
| --- | --- | --- |
| 0 — design review | Owner accepts initial scope, catalog approach, audience, budgets and retention | Recorded decision; no network activation |
| 1 — contracts | Separate schema, grants, lifecycle and default-off configuration | Strict rejection of offline escalation, cross-tenant/session reuse, stale membership/digests, replay and budget races; no container starts before grants |
| 2 — isolation | Dedicated image and transport policy with a controlled fixture origin | Actual sandboxed-browser and runtime proof for every network/isolation requirement above; missing capabilities block progress |
| 3 — human flow | Catalog review, audience disclosure, human lease, STOP and truthful unknown states | Automated fixture UI/security tests, fresh screenshots, revocation during requests/frames, takeover and concurrent-request tests |
| 4 — external pilot | Exact owner-approved public catalog on a separately authorized deployment | User-owned live acceptance, bounded test plan and independent security review; no enablement merely because CI passed |

Engineering owns automated fixture and image evidence; an independent security
reviewer must accept isolation/transport evidence before the owner authorizes a
pilot. The user owns live acceptance; this design authorizes none of those calls.

Network proof must cover HTTP/HTTPS denial, redirects/subresources, DNS rebinding,
private destinations, alternate ports, tunnels, WebSockets, QUIC, policy outages,
resource exhaustion, cross-session isolation and revocation during streaming.
Adversarial acceptance also covers IDNs, trailing dots, encoded separators and
parser disagreement; popups/new tabs, file/internal/external protocols, WebRTC
and permission prompts. Exercise the kill switch across policy outages and
restarts: new grants remain disabled and retired generations stay fenced.
Image proof must cover actual non-root sandbox operation, no shared profile or
credentials, and expiry/STOP destruction. Fixtures and fake Containers cannot
certify deployed transport enforcement. Keep offline regression tests mandatory.

No online rollout, deployment, live provider/site call or payment is authorized
by this document. Rollback disables new online grants, fences active generations
and destroys online sessions; it never silently converts them to offline or
cloud coding sessions. Existing offline sessions keep their original contract.

## Decisions before implementation

Recommended defaults are human-only, unauthenticated public catalog browsing;
no model observation, external writes or exports; and conservative fixture
budgets above. Owner review must choose the first external catalog, exact
redirect/subresource policy, pilot audience, final resource caps and audit
retention period. These remain proposals, not inferred consent. Authenticated
browsing and agent control need separate designs even if this proposal is accepted.

## Source map

- [Current enforced boundary and transport limitations](shared-computer-online-boundary.md)
- [Existing offline product contract](shared-computers.md)
- `packages/shared/src/shared-computers.ts`: strict offline wire contracts.
- `apps/backend/src/shared-computer-routes.ts` and `shared-computer-store.ts`:
  native review, resource grants, membership and lease fences.
- `apps/backend/src/shared-computer-auth.ts`, `shared-computer-runtime.ts` and
  `computer-session.ts`: operation capsules, conservative outcomes and runtime.
- `apps/backend/Dockerfile.computer` and `computer/`: current offline image.

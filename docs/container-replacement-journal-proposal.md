# Container replacement output archive

Status: implemented in source with local acceptance evidence. This is not a live
Cloudflare Container or coding-provider certification. The implementation retains
sanitized output outside the source container; it does not restore a destroyed
process or automatically launch a replacement command.

## Precise boundary

An archive acknowledgment commits the sanitized payload, deduplication receipt,
source checkpoint, byte/event counters and hash chain in the same room SQLite
transaction. Retained payload has a separate table from the 2,048-event live
display history. A current authorized native owner can read that committed
projection after source replacement until the exact approved archive lease ends.

Unacknowledged bytes may exist only in a process pipe, the container journal or a
transient Worker buffer. Those bytes can be lost. Recovery returns the retained
projection, its source ACK and last observed source sequence, and an explicitly
unknown tail with no invented upper bound. Equal observed and ACKed frontiers do
not prove the CLI emitted nothing later. Split secrets/UTF-8 are assembled and
scrubbed before persistence; oversized lines retain the existing explicit safety
notice. This is a sanitized projection guarantee, not retention of every raw byte.

A verified source exit receipt is distinct from tests, workspace settlement,
artifact collection and publication. Terminal text alone cannot establish any of
those outcomes.

## Human approval and initial scope

New eligible explicit dashboard queue requests receive a server-authored optional
`outputArchive` policy **before** the human decides their frozen approval. Its
exact resource bounds, original native account ID, recovery limitation and
absolute UTC lease appear on the stored approval card. The policy participates
in `runInputHash`, decider queue/replay checks, the persisted run and the sealed
child envelope. An API request may set `outputArchive: null` to opt out; arbitrary
client-authored policies are rejected.

This first slice requires the actual verified native bootstrap owner's cookie,
its immutable account UUID, a private base/named dashboard session and a frozen
Cloudflare sandbox provider. It excludes employee profiles, skill pins,
onboarding/project context, collaboration handoffs/shared sources, children,
chained reviews, local and personal runs. It does not infer archive authority
from `runRoom`. Existing approvals/runs remain unchanged. The SDK chat approval
gate currently retains its legacy behavior: it does not add an archive policy
that its original tool-input card cannot display.

Archive reads are private to that original native account, not a room-sharing
contract. They do not claim current upstream repository authorization or expand
an external shared-source grant. Shared-source/team archives need their own
current membership/version/source checks before they can be admitted.

## Versioned resource reservation

Policy v1 freezes these limits into the approved run:

| Resource | Bound |
| --- | --- |
| Source journal | 4 MiB and 4,096 frames, unchanged |
| Archive per job | 8 MiB canonical UTF-8 bytes, including bounded metadata overhead; 8,192 events |
| Room reservations | 16 MiB / 2 unexpired archives |
| Native account reservations | 32 MiB / 4 unexpired archives |
| Absolute archive lease | At most 24 hours from policy creation; never extended on recovery |

`0022_run_output_archives.sql` adds the private `AGENT_AUDIT` reservation registry.
One conditional D1 statement reserves owner and room capacity before the CLI's
source `START`. Retrying the same exact reservation is idempotent. Unknown or
revoked work does not release its reservation early. Expired leases no longer
count; room maintenance alarms remove their payload. These are logical storage
resource limits, not an inference invoice or dollar cap.

When the archive budget is reached, the next transaction fails without advancing
ACK or evicting previously acknowledged leased payload. The independent source
journal may then reach its existing limit; that is explicit bounded failure,
never permission to retry or relaunch.

## Native claim and replacement fencing

A distinct Worker-only admission HMAC binds actual owner/account/session/run,
approval/input/envelope hashes, job, command identity, policy and deadlines. After
the one-shot native execution claim exists, a separate scoped seal binds its
original job digest and native container epoch. No archive token or signing key
enters the container.

`Sandbox.getExecutionClaim` only inspects retained metadata/current epoch. It
never starts a container or executes a control program. The room verifies the
native observation before accepting appends. Once replacement, cancellation or
unavailable original source is observed, an incomplete archive cannot reopen for
a late writer or a new epoch. Archive reads can return its committed projection
without relaunching the source.

Explicit sandbox destruction writes a sticky retirement tombstone before its
first destructive effect, including failed or uncertain destruction. It clears
egress/port/session configuration while retaining only nonsecret closed claim
identity. It never deletes all state and later recreates the tombstone. A fresh
DO cannot run another CLI or settlement command under that retired attempt ID;
a new human-approved attempt uses a different sandbox ID. Involuntary container
replacement retains the original one-shot claim.

Native epoch and D1/room observations are distributed point-in-time checks, not a
cross-service transaction or an instant remote-revocation notification. After a
replacement is observed locally, that archive is permanently fenced.

## Private read surface

`GET /api/run-output-archives` lists current private reservations;
`GET /api/run-output-archives/:id?after=0` returns at most 32 hash-chained terminal
entries. The explicit owner-only `POST /:id/revoke` stops later reads. These
routes use a native human cookie, not an API bearer or workspace selector, and
never probe/reconcile the parent agent, queue work, approve, start, send or make a
provider/model call.

After all DO/session awaits, a final D1 statement joins the exact native session,
account provenance and reservation digest/state/lease. The response checks the
clock again synchronously after that proof. Directory snapshots are filtered
against fresh session/reservation authority and the current clock. A removed
account, same-email replacement account, revoked session/reservation or expired
lease cannot use the old archive. Deleting a named session revokes its archive
reservations before removing the registry record. Responses are private,
`no-store` and have no bearer download URL.

The native live-run panel has an explicit read-only retained-archive button.
Opening it validates the selected run/session, native account and contiguous
hash chain. Current-access failures and scope switches clear cached bytes; an
exact local lease timer hides them before the next poll. The UI shows a bounded
250,000-character tail of loaded pages and offers explicit next-page reads. It
labels an unacknowledged tail as unknown and has no command-start, approval,
Slack or download controls. Source revocation checks poll/focus refresh; the UI
does not promise instantaneous notification of an unseen account change.

## Evidence and remaining acceptance

`test/run-output-archives.test.ts` uses actual SQLite/D1-interface statements and
the production room/publisher with a fixture native claim. It covers policy and
seal mutation, owner/room reservations, no early quota refund, display pruning,
UTF-8/redaction, reply loss/deduplication, atomic backpressure, completion versus
unknown tail, current native/session/source fences and held final-proof expiry.
`test/execution-journal.test.ts` exercises the actual Sandbox class against a
fixed local Node process/native-container fixture, including retirement before
failed destroy, fresh DOs, held settlement inspection and a new attempt ID.

`test/acceptance/worker-archive-replacement.test.mjs` starts three actual local
workerd runtimes with persistent SQLite **and D1**, uses a real TCP WebSocket and
the production Node journal. The fixed producer launches once. It commits a
sanitized prefix including split secret/UTF-8 output, loses an append reply after
commit, emits a later unacknowledged frame, then loses its owned source process
and local journal. After fixture epoch replacement/restart it recovers the same
committed projection/hash, reports the unknown tail, refuses old-epoch appends,
performs zero replacement starts and denies a revoked read. All outbound traffic
is denied; the single reserved-domain probe is intentionally blocked.

The Container epoch/claim RPC in that drill is a fixture, not an actual Container
binding. Native cookie authorization is covered separately by scoped HTTP tests,
not by its test-only fixed-identity endpoints. The earlier same-container drill
remains in [local-journal-recovery.md](local-journal-recovery.md). Neither fixture
establishes live Cloudflare Container replacement, real coding-provider execution,
or the complete parent Think/child-agent SDK eviction chain. Those remain
separate authorized live acceptance tasks. No process-memory, uncommitted
filesystem checkpoint, arbitrary environment restoration, universal zero-tail-loss
or autonomous replacement execution is claimed.

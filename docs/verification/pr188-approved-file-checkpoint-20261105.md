# PR188: opt-in approved-file checkpoint storage increment

Base: `7a96effab47d56820ae24f2c869d7d70eb1709f2`. This is a **disabled-by-default
private storage primitive**, not a completed replacement execution journey. It
adds no ingress, approval policy, runtime launch, file export helper, deployment
binding, UI or automatic retry. The output archive schema is unchanged.

## Implemented boundary

`RunFileCheckpointStore` accepts an explicitly consented policy and already
exported regular UTF-8 file contents. The policy binds account, session, run,
approval, sealed-envelope hash, source epoch, lease ID, exact relative path list
and absolute expiry. It shares the existing deliverable limits: eight non-hidden
md/txt/json/csv files, 16 KiB each and 64 KiB total. The lease is at most 24 hours.
Credential-like assignments, PEM private-key headers, known secret patterns,
credential filenames, invalid Unicode and unsafe control bytes fail closed.
Secret detection is conservative defense in depth, **not proof that arbitrary
user content contains no secrets**.

One immutable snapshot contains a manifest with per-file raw UTF-8 SHA-256 and a
policy hash. Its object hash is anchored in a private run-owned transactional
receipt. Raw files never enter that receipt. An opaque hash-only namespace uses
the existing private `ARTIFACTS`-compatible object storage, without download URLs.
This does not defend against an attacker rewriting both trusted receipt and
object storage. File data is bounded to one snapshot per run/lease, not a rolling
backup or an account-wide quota implementation.

A pending claim precedes the upload; a committed receipt follows it. Missing,
partial, corrupt, expired, mismatched or revoked snapshots cannot release restore
payloads. Only explicit identical-content upload retries are allowed; a changed
attempt cannot replace the committed checkpoint. Revocation writes a sticky
transactional tombstone before deleting the object. Expiry cleanup can run after
session expiry, including retry after uncertain deletion. An in-flight upload can
finish after deletion; capture reconciles a retired object on settlement, and
`cleanupRetired` must run from alarms to reconcile late or uncertain storage
effects. Physical deletion is not an atomic cross-service revocation guarantee;
the sticky receipt blocks reads while bytes await reconciliation. A pending or revoked
claim is never interpreted as permission to execute anything.

The mandatory caller authorization callback is rechecked around storage awaits.
It must verify the frozen signed envelope, current native account/session,
approval, tenant/source/installation revocation fences and lease for the given
action. These are point-in-time distributed checks, not instant remote revocation.
For capture it must also prove the original source epoch is current. A restore
read may inspect retained data after source loss only under its separate current
read authority; it cannot reopen the original command claim.

`read` returns `kind: approved-files`, `outputAcknowledgment: null`,
`unknownTail: true` and `processRestored: false`. This is a **verified restore
payload**, not evidence that bytes have been written into a replacement runtime.
An output ACK is a separate checkpoint. Unsaved files, mutations after capture,
unacknowledged terminal output and process memory can be lost. No zero-loss or
live end-to-end claim is made.

## Required integration before enabling

The coordinator must coordinate these with execution/approval owners; this branch
does not change their shared schemas or duplicate their filesystem helpers:

1. Freeze a default-off file policy and exact path list into the human approval,
   run input hash and signed child envelope. Do not infer file retention consent
   from the existing output archive policy. Display its separate bounds and loss
   disclosures before approval. Reuse current reservation enforcement to account
   for aggregate tenant/room storage; this store only bounds an individual run.
2. Instantiate only with a run-isolated transactional Durable Object receipt,
   private `ARTIFACTS`, and the real current authorization/source/lease verifier.
   No direct client-provided policy may become authority. Wire alarms to
   `purgeExpired`/`cleanupRetired` and source/session revocation to sticky retirement.
3. Use the execution owner's descriptor-anchored exporter. Reject symlinks in
   every ancestor and leaf, hard links, special files and changed-file races.
   This store takes strings and cannot independently inspect filesystem identity.
4. A replacement filesystem writer must stage all verified files in an isolated
   empty destination, use descriptor-anchored no-follow/create-only operations,
   recheck authority, and publish only an all-files commit receipt. A partial
   filesystem write is an unknown/failed restore, never a runnable workspace.
   Retrying that write needs an explicit idempotency/cleanup protocol, not an
   automatic execution retry. No restored file is executable authorization.
5. Keep replacement process start disabled. A distinct frozen human approval,
   new attempt identity, scoped egress and credential-free runtime would be
   required for any later command; this storage increment grants none of them.

## Fixture evidence

The focused suite uses fixture object storage and transactional private receipts.
One case captures an actual temporary UTF-8 file, deletes its original, reads the
verified payload and writes a new temporary file. That is not a production
filesystem adapter or a symlink/race-safety certificate. Other cases cover identity
mismatch, corruption, partial uploads, identical/changed retries, concurrent
claims, revocation during I/O, sticky retirement on deletion failure, expiry,
unsafe paths, credential-like contents and byte bounds. No live provider,
container, account, Slack, paid inference, managed preview or deployment is used.

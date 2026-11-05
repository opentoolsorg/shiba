# Container replacement journal proposal

Status: design for review. This is not implemented or live-verified. The local
workerd drill in [local-journal-recovery.md](local-journal-recovery.md) covers a
surviving Node source process and a fixture container bridge. It does not test a
Cloudflare Container replacement.

## Precise guarantee

After a container is replaced, a current authorized viewer can recover the
sanitized output already committed to storage outside that container, until its
explicit archive lease expires. An output acknowledgment means the payload and
its checkpoint committed together. It does not mean every byte emitted by the
CLI reached that checkpoint.

Unacknowledged bytes may exist only in a process pipe, the container journal, or
a transient Worker buffer. Those bytes can be lost with the container. Recovery
must show the durable prefix and an incomplete or unknown tail. It must not infer
a successful command from terminal text, reconstruct process memory, or start a
replacement command under the old approval.

## Existing pieces and the missing boundary

`Sandbox` stores a one-shot execution claim outside the container and refuses
journal reads when the original container epoch changes. The Node supervisor
writes a bounded local journal. `createRunJournalPublisher` scrubs complete lines
and publishes through the `ConversationRoom` binding. The room already commits
redacted events, deduplication receipts and source acknowledgment in one SQLite
transaction before fanout.

That is useful external durability already. It is not a retained archive:
`room_run_events` prunes display payload after 2,048 events, while
`room_run_journal_receipts` retains only a digest and sequence. An acknowledged
payload can therefore disappear from display history even before source bounds
are reached. An archive must retain payload independently of that display cap.

## Smallest proposed implementation

Extend the existing private room DO with a separate per-job archive. Reuse its
SQLite transaction and current binding-only writer instead of adding an R2
upload protocol or a container-held writer token. The Worker continues pulling
the original journal and redacting it before persistence. If that Worker cannot
pull before replacement, the unacknowledged tail remains unknown.

The immutable archive identity binds:

- Current owner/audience scope and run ID.
- Original approval ID, canonical input hash and dispatch envelope hash.
- Original job ID, command identity and native container epoch.
- Original write/observation deadline, plus a separate output archive lease.
- A versioned bounded storage policy frozen with the approved run.

A private read-only Sandbox binding can expose the retained claim/epoch identity
without starting a container. The archive must never trust an epoch supplied by
a viewer, CLI environment variable or model. Existing same-instance supervisor
checks remain necessary.

Each archived chunk records a monotonic archive sequence, deterministic event
ID, stream, source coverage range, bounded UTF-8 payload and digest. A hash chain
or equivalent complete manifest binds ordering and detects missing or changed
chunks. Its transaction inserts payload and deduplication receipt, updates byte
and event counters, and advances the acknowledged source frontier atomically.
An uncertain reply can replay the same event ID and identical payload; changed
bytes under that ID are rejected.

Keep two frontiers distinct: committed output events and complete source
coverage. A complete stderr line may already be durable while an unfinished
stdout line prevents the global source checkpoint advancing. Never treat a
partially buffered line or incomplete UTF-8/secret fragment as safely archived.

## Replacement and execution authority

On verified native epoch mismatch, freeze the old journal as incomplete. Retain
its committed prefix; reject new-epoch appends or old-job START attempts. Do not
clear its one-shot claim/tombstone while the old executable authorization could
still be valid. A late old writer cannot reopen a journal marked incomplete.

Report at least the committed source frontier, last observed source sequence,
archive event frontier and whether a verified final receipt exists. When no
verified final receipt exists, the upper extent of the tail is unknown: the CLI
could have emitted more output since the last read. Even equal observed and
committed frontiers do not prove the process produced nothing afterward.

A Worker-verified final source receipt can establish the old CLI exit status
only when bound to the same job/epoch/input and complete acknowledged coverage.
It does not establish successful artifact collection, tests, publication or
settlement. Existing preparing/harness/settling/complete phase distinctions stay
in force.

A subsequent command requires a new explicit human approval with a distinct
attempt/job identity. Archived text is untrusted evidence, not instructions or
permission. Reusing an immutable patch or artifact checkpoint would require
explicit selection, current source authority and its exact bytes/hash in that
new approval. This first proposal does not promise restoration of uncommitted
files or arbitrary process/filesystem checkpoints and does not pause active CLI
turns to create them.

## Budgets, backpressure and privacy

Choose explicit per-run UTF-8 storage bytes, chunk/event counts, archive lifetime,
and per-owner aggregate reservation limits before implementation. Keep source
limits of 4 MiB/4,096 frames and current line-redaction limits; a character count
is not a storage byte budget. Chunk values must remain small and each row's
canonical stored bytes must count toward the reservation. These are resource
limits, not an inference invoice or dollar cap.

Reserve capacity before starting the approved source job. A full archive must
not evict acknowledged payload inside its promised lease to accept new data.
Fail the next append without advancing its acknowledgment and expose bounded
storage/backpressure failure. The independent source journal can itself reach
its existing limit; that is an explicit limited/unknown outcome, not evidence of
complete terminal replay. Do not auto-refund, retry or relaunch an uncertain
execution.

Redaction occurs in the Worker before archive payload or fanout. Store only the
sanitized terminal projection and nonsecret identity metadata. Raw source frames,
executable command envelopes, environment maps, model/subscription keys and
container-held archive credentials must not enter the archive. Preserve split-line/UTF-8 and multiline secret
handling and scrub before applying storage bounds. Oversized lines retain an
explicit safety notice rather than silently disappearing.

Read, replay and export require the exact current native/Access owner or
approved room audience and current source grants. Reuse the existing before/after
source fences; a guessed job ID or viewer nonce grants nothing. Archive reads
must not start a container, resume an agent, queue work or approve anything.
Authenticated no-store reads are preferable to bearer download links because
source revocation must withhold cached output on later reads. Display history
and archive cursors must be distinguished; never reset a viewer to another
run/generation silently.

The write deadline is not automatically the output retention deadline. Completed
or incomplete output can remain readable under its separately approved archive
lease while audience/source authority remains current. Expired or revoked read
leases must hide protected content locally and deny subsequent server reads.

## Proposed deterministic acceptance

Use actual local workerd/SQLite and the fixed Node source fixture, with all
outbound traffic denied. This is separate from live Cloudflare acceptance.

1. Commit a known sanitized prefix and its checkpoint. Emit more source bytes
   without external acknowledgment, stop only the owned fixture process and
   replace its fixture epoch. Restart workerd with the same external storage.
2. Recover the exact acknowledged prefix/hash; report an unknown unacknowledged
   tail. Assert old source launch count remains one, recovery START count zero,
   and a new epoch or forged generation cannot append to the old journal.
3. Inject a crash before the archive transaction commits: neither payload nor
   checkpoint becomes visible. Inject a lost reply after commit: identical
   replay is idempotent and changed-body replay is rejected.
4. Cross a split UTF-8 code point and approved synthetic secret over source
   chunks. Confirm unfinished raw bytes never enter external storage and the
   recovered projection matches the expected sanitized digest.
5. Reach the archive budget. Existing acknowledged data remains available;
   the next append is explicitly rejected without an advanced frontier.
   Ordinary 2,048-event display pruning must not delete leased archive payload.
6. Revoke membership/source authority or expire the read lease during a read.
   No protected bytes cross the final response boundary. Viewer injection,
   guessed IDs, stale epochs and cross-user/workspace requests have zero effects.
7. Supply a valid complete final receipt separately from an incomplete one.
   Only verified source completion changes the CLI outcome, and neither case
   fabricates settlement, publication or a replacement execution.

A real Cloudflare same-container/replacement drill remains a distinct authorized
prerequisite. Until those tests exist, the guarantee above is a design contract,
not a claim that deployed recovery or every emitted CLI byte is lossless.

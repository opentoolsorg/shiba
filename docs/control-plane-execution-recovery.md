# Container execution recovery boundaries

Cloudflare harness execution uses a container-local source journal. This can reconnect a surviving runtime to the same supervised process after a Sandbox RPC or reader failure. It does not resume the whole coding turn after parent or facet eviction, and it does not preserve a process across container replacement.

## Execution protocol

Before dispatch, the runtime derives a stable job ID from the sandbox, approval, frozen input hash and harness. Its absolute execution deadline is the earlier of the original signed dispatch deadline and the fifteen minute harness limit. Clone, setup, checkpoint capture and collection remain ordinary scoped operations. Other sandbox providers retain their existing single-attempt execution behavior.

The Cloudflare adapter calls `startExecution` once. A lost response causes it to read the retained claim; it never sends another launch. The Sandbox DO writes an immutable command/environment digest and deadline before launching the fixed supervisor. It stores no command body or environment values in that claim. The supervisor receives the approved environment on stdin and gives it only to the CLI child. Managed provider and subscription credentials remain in Worker egress.

The supervisor uses a create-only job directory, a container epoch and Linux process identity. It writes sequenced stdout/stderr records and a final receipt after stream closure. Later reads are stateless and bounded. They require the same retained claim and container epoch and never start or restore a container. Replacing the container or restoring a filesystem snapshot produces a lost outcome rather than starting another CLI.

The adapter validates page identity, contiguous sequences, canonical base64, output limits and the terminal receipt. It retains separate UTF-8 decoders for stdout and stderr. It advances its in-memory source cursor after each accepted page's callbacks complete. A callback failure is never replayed. This cursor survives transport failures in the same runtime lifetime; it is not a durable acknowledgment across runtime eviction.

Cancellation creates a sticky claim and a supervisor cancellation marker, including when launch acknowledgment is ambiguous. The supervisor owns the original deadline independently of the reader. Control requests never signal a later PID found in a file. An escaped descendant or incomplete shutdown is reported as lost, with a matching-instance lifecycle backstop. Recovery does not extend the approved deadline or grant publication permission.

## Explicit bounds

- Source output is limited to 4 MiB and 4,096 frames. Each raw frame is at most 4,096 bytes; a page contains at most 64 frames.
- Returned stdout and stderr tails each retain at most 512,000 characters. Source records within the journal remain available until container cleanup.
- Launch/read RPC waits are bounded to five seconds. Repeated read failures have a thirty second recovery budget within the original execution deadline.
- A cancellation RPC has a two second client wait. Supervisor deadline and native lifecycle fencing remain independent of that wait.
- Output overflow, malformed data, changed boot identity, missing claims and unconfirmed launch fail closed. They never become a successful CLI result or an automatic relaunch.

Raw source records stay in the private container and are excluded from artifact export. Existing Worker redaction still runs before room persistence. Source journaling does not make agent output trusted.

## Remaining recovery work

| Failure boundary | Current result |
| --- | --- |
| Browser disconnect | Existing durable room cursor replay, with retention gaps. |
| Sandbox transport failure while runtime and container survive | Attach/read the same supervised job without another CLI launch. Local failure tests cover this path. |
| Sandbox DO recreation while the original container survives | Retained job claim plus matching container epoch permits reading the existing source journal. |
| Child facet or parent runtime eviction | Still unknown. Runtime preparation and settlement are not durably resumable, and the parent currently releases interrupted execution sandboxes. |
| Room delivery failure | Existing room limits and explicit gaps still apply. Source acknowledgment and deterministic frame IDs are not integrated across this boundary. |
| Container instance loss | Running process and unsynchronized source bytes can be lost. A filesystem snapshot does not resume the process. |

The smallest next step for facet recovery is a durable prepared-execution record containing the original base revision, baseline checkpoint, approved command/config identity, generation, source acknowledgment and settlement phase before launch. A dedicated recovery entry must attach to that record instead of calling `runCodingTask` again. The parent restart path must retain and reconcile a proven live job under its existing generation and deadline. Publication continues to require review of immutable captured bytes and a separate human decision.

Room recovery additionally needs deterministic redacted frame IDs and a durable source watermark advanced only after room persistence. Incomplete secret-bearing lines must remain unacknowledged so a replacement runtime can reread and redact them without storing plaintext fragments in the Worker journal. The current random frame IDs and in-memory line buffer cannot safely provide that guarantee.

Cloudflare documents application-owned [background process supervision](https://developers.cloudflare.com/sandbox/commands/run-background-processes/), [following output](https://developers.cloudflare.com/sandbox/commands/follow-a-background-process/) and the distinction between filesystem snapshots and processes in [sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/). No live Cloudflare disconnect, eviction or installed Slack acceptance was performed for this change. The [acceptance matrix](control-plane-acceptance.md) keeps these gaps explicit.

## Local verification

The final serialized workspace gate passed 4,960 tests with three opt-in live tests skipped. It includes 28 real local supervisor tests, 26 native DO/controller tests, 40 provider journal regressions and the runtime forwarding and approval-bound identity checks. Typecheck, lint, import lint, build, deployment checks and `check:ci` passed. The container controllers in these tests are simulated; their supervisor processes, files and Linux process identities are real local fixtures.

The aggregate run caught two valid-transition races. Startup metadata now publishes once after the trusted anchor exists and before it receives CLI input. A reader also rechecks the atomic final receipt if the supervisor disappears between its first receipt read and liveness check. Deterministic regressions reproduced both false lost outcomes with the original behavior and passed with the fixes, including rejection of altered receipt bindings and counts. No filesystem guard was weakened.

An existing daemon cancellation fixture also revoked its claim before its grandchild necessarily began writing. The fixture now arms the parent's signal handler and waits for the grandchild's output before revocation, preserving the real descendant-stop assertion. The production daemon was unchanged.

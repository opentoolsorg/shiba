# AI employee deliverable acceptance

Validated on 2026-10-28 on `codex/overlay-parity-audit`. The implementation
adds role-based Bot drafts and required repository deliverables. It is a tested
increment toward the [full employee contract](../product/ai-employees.md),
not completion of general employee or 1:1 reference-product parity.

## Implemented behavior

- Engineering, Marketing, Research and Operations starters fill editable Bot
  drafts. They preserve routing/repository choices, confirm replacement of an
  existing draft and protect saved-Bot editing. Selecting one neither saves
  the Bot nor starts execution.
- Required paths are validated, saved in the versioned profile and frozen
  through approval, run, execution envelope and retries. Client-supplied empty
  requirements cannot remove a profile's requirements. The composer and actual
  approval card show the appropriate current/frozen file contract.
- Runtime prompts include the exact approved paths. Missing, empty, invalid,
  truncated or oversized files fail capture; JSON syntax is checked. The local
  daemon refuses symlink parents/leaves, hardlinks and changing files. Cloud
  capture reads a settled regular-file Git blob with byte-size validation.
- Only requested, bounded bodies are retained in private R2. Run/list/spine
  and child result surfaces carry metadata rather than those document bodies.
  Cancellation fences late manifests, including cancellation during storage.
- Downloads resolve the authenticated owner's exact conversation/run, then
  derive the object key from trusted metadata. Actual byte count and SHA-256
  must match before an attachment is returned. No arbitrary storage key is
  accepted, and a cancelled/error run cannot expose a partial bundle.
- The desktop bundle includes the daemon's new capture helper. The public v1
  path, OpenAPI and generated SDK preserve the supported optional contracts.

The limits are eight unique safe relative non-hidden `.md`, `.txt`, `.json` or
`.csv` paths, 16 KiB per file and 64 KiB total. File checks establish capture
and structural properties, not the accuracy or quality of business outputs.

## Executed UI and runtime acceptance

The actual Marketing role passed in **both browser and sandboxed Linux
Electron** on fresh isolated state, each completing **14 UI steps and 18
protocol checks** after the authorization, cancellation and binary-safe capture
fixes. The run used the real Worker, Durable Objects, D1 identity, R2, Bot form,
selected paired computer, local daemon, native Git, filesystem, approval
buttons and downloads. The model CLI alone was a deterministic fixture;
`liveInference: false` is recorded in every result.

| Target | Main successful run | Missing-file failure | Cancellation |
| --- | --- | --- | --- |
| Browser | `agent-tool:47737f19-f26b-4eda-9efe-0e09306b98d7` | `agent-tool:c6affd8f-cd30-46f3-a52a-9ebbc863de21` | `agent-tool:6c695825-b59f-4a73-8c49-e2256ef5a8ed` |
| Linux Electron | `agent-tool:7cb366ce-d1ef-4281-b58f-5adaa1549ed7` | `agent-tool:0748e80b-6c86-4717-b9df-d4674c4c4310` | `agent-tool:375b8ea4-c677-414d-a1ec-bd519e1aa772` |

Both targets exercised actual role selection, edited/saved configuration,
bound-thread creation, composer queueing, frozen approval requirements, human
task/tool approval, file generation, refreshed retained results and metadata,
session-scoped downloads with exact bytes/hashes, missing-file failure and
cancellation of the CLI/tool process group. Web also clicked the actual
download links and compared the saved attachments with the native files.
Electron verified links and authenticated response bodies; its operating-system
download dialog/installation was not certified.

The two captured Marketing files contain 381 and 337 bytes. A deliberately
missing `marketing/campaign.md` makes the run fail even though the brief exists;
no partial download is exposed. Missing/wrong conversation routing and an
out-of-range index return 404. The main run APIs contain metadata without
private document bodies. No assertions were disabled or timeouts increased.

The journeys began with fresh isolated Worker state. Their logs contain no
container-attachment or failed-sandbox-destroy entries. Expected negative runs
log an error; optional remote-AI session distillation cannot run with
local-only bindings. An earlier disconnected request also produced a workerd
broken-pipe diagnostic. These are not evidence of successful live inference,
remote memory distillation or a clean zero-warning production deployment.

## Regression and review evidence

Independent review reproduced and closed two defects: an outside-root hardlink
was accepted by the initial local capture, and valid UTF-8 BOM Markdown was
initially rejected by server decoding. Native before/after reproductions now
reject the alias and preserve the BOM file's exact bytes. Focused regressions
also cover approval hashing/profile edits, late cancellation, storage failures,
cross-session access, modified bytes/hashes and content-addressed collisions.

Later independent review also fixed v1 approval ownership and dashboard
organization scoping, binary-safe Git blob transport (including a valid literal
U+FFFD character), cancellation/deadline fencing across capture and test
phases, and concurrent review-triage rollback. The current full repository
suite passes **3,342 tests with 3 credential-dependent skips** across 8
packages. Typechecks, imports, CI, all 6 build tasks, documentation checks,
built-output/deployment drift checks and the Worker bundle dry run also passed.
The browser and Electron results above are the fresh post-fix acceptance. An
initial web attempt failed because its fixture owner was not allowlisted; the
runner was corrected to use the allowlisted `BETTER_AUTH_OWNER_EMAIL` and
rerun with authentication enabled. The failed attempt is retained in
`.verify/employee-ci-7dCOc2/result.json`. The successful runners returned 200
for the app and 401 for unauthenticated sessions, confirming auth remained on.

Local ignored evidence:

- `.verify/employee/acceptance-summary.json`.
- `.verify/employee/fresh-acceptance-summary.json` and
  `.verify/employee/{web,desktop}-fresh-result.json`.
- `.verify/employee-ci-gWkc9D/result.json` and
  `.verify/employee-ci-ZrjEJ9/result.json`: fresh authenticated web and
  Electron runs.
- `.verify/employee-ci-7dCOc2/result.json`: initial allowlist fixture failure.
- `.verify/local-daemon-e2e/ui-employee-{web,desktop}/evidence.json`, screenshots
  and web attachments.
- `/tmp/shiba-employee-shell.log`: Linux Electron shell tests, 5 passed across
  3 files.
- `/tmp/shiba-employee-{web,desktop,local-worker,build,ui-final}.log`.

The current repository-gate totals are recorded in the
[final working-state recheck](final-recheck.md). Focused suite totals overlap
and must not be summed into the repository total.

## Remaining scope and prerequisites

These employee drafts still use a real approved repository. General business
workspaces, a versioned goal/plan ledger, per-employee connector permissions,
live research/source verification, marketing analytics/social publication,
general scheduled business actions and the complete employee contract remain
unfinished. The product guide is [role-based Bots and required
deliverables](../product/employee-deliverables.md).

Live Bot/model execution requires a securely authenticated supported provider
or paired CLI. Native macOS installation/signing/notarization and actual cloud
containers require separate acceptance. The requested reference sites still
return proxy 403, so their authenticated behavior has not been compared 1:1.
Cloudflare deployment and live Morph remain blocked as documented earlier.

# Effect-TS review and fixes

## Scope and method

Ten OMX Team workers reviewed the ten requested dimensions using `devin/swe-2`. Reviewed the backend Effect boundary, retry, lifecycle, delegated-run/cleanup paths, fleet schemas, related tests, and Alchemy integration—not every repository file. Existing unrelated work was preserved.

Installed API: **Effect 4.0.0**. Findings were checked against installed declarations/source. Some examples in the supplied checklist are Effect 3 APIs or preferences rather than correctness requirements. Historical findings below include applied fixes; remaining recommendations are explicitly marked. Snippets are focused excerpts using the surrounding names/imports, not standalone replacements.

**Overall: Needs Fixes** for the remaining SDK-destroy deadline and optional architectural/telemetry work. Applied fixes are regression-tested; this is not a claim of production infallibility.

### `apps/backend/src/run-errors.ts`

#### Issues Found

**1. Schema-backed error vocabulary — Info (Applied)**

- **Location**: 137–146
- **Problem**: Data.TaggedError was typed already, but its fields did not provide the requested runtime schema validation.
- **Why it matters**: A malformed code must not reach wire-vocabulary lookups.
- **Fix**:
```ts
const RUN_ERROR_CODES = Object.keys(RUN_ERROR_DEFS) as ReadonlyArray<RunErrorCode>;
export class RunError extends Schema.TaggedError<RunError>()("RunError", {
  code: Schema.Literals(RUN_ERROR_CODES),
  message: Schema.String,
}) {}
```

#### Summary
- Errors (Critical): 0
- Warnings: 0
- Info: 1
- Overall: Pass after fixes

### `apps/backend/src/harness/retry.ts`

#### Issues Found

**1. Unknown/raw retry failures inside Effect — Warning (Applied)**

- **Location**: 141–143, 176–204
- **Problem**: The retry pipeline previously carried unknown task rejections/finalized legacy errors instead of a concrete schema-tagged error channel.
- **Why it matters**: Typed retry predicates and exhaustive failure handling are lost; changing the Promise rejection identity would break existing callers.
- **Fix**:
```ts
class RetryTaskError extends Schema.TaggedError<RetryTaskError>()("RetryTaskError", {
  cause: Schema.Unknown,
}) {}
// Keep the wrapper through retry and finalization.
Effect.tryPromise({ try: task, catch: cause => new RetryTaskError({ cause }) });
// At the Promise boundary only:
const error = Cause.squash(exit.cause);
throw error instanceof RetryTaskError ? error.cause : error;
```

**2. Cancellation comment overstated failure preservation — Info (Applied)**

- **Location**: 145–162
- **Problem**: The comment promised only transient errors could be replaced by cancellation, but the existing contract gives an aborted signal precedence over all late failures.
- **Why it matters**: Misleading documentation can prompt an incompatible race-policy change.
- **Fix**:
```ts
// An abort signal wins over a late error (cancellation is authoritative).
// Permanent-error identity is retained when cancellation has not won.
```

#### Summary
- Errors (Critical): 0
- Warnings: 1
- Info: 1
- Overall: Pass after fixes

### `apps/backend/src/effect/runtime.ts`

#### Issues Found

**1. Hand-written Promise callback bridge — Info (Applied)**

- **Location**: 78–91
- **Problem**: Custom callback/Promise continuation code duplicated Effect.tryPromise semantics.
- **Why it matters**: Extra edge code increases sync-throw, cancellation and rejection-mapping maintenance risk.
- **Fix**:
```ts
export const tryRunPromise = <A>(
  thunk: (signal: AbortSignal) => Promise<A>, codeHint?: RunErrorCode,
): Effect.Effect<A, RunError> => Effect.tryPromise({
  try: thunk,
  catch: error => {
    const classified = classifyRunError(error);
    const code = classified.code === "internal_error" && codeHint ? codeHint : classified.code;
    return toTaggedError(code, classified.message);
  },
});
```

**2. Inaccurate single-runtime claim — Info (Applied)**

- **Location**: 1–14
- **Problem**: The header said this was the only Effect execution site, though retry/lifecycle deliberately fork to bridge cancellation.
- **Why it matters**: Reviewers could mistake sanctioned Promise-boundary execution for nested runtimes.
- **Fix**:
```ts
// runWorkerEffect is the classified execution boundary.
// Retry preserves legacy identity at its own Promise boundary;
// retry/lifecycle also fork fibers to bridge cancellation.
```

#### Summary
- Errors (Critical): 0
- Warnings: 0
- Info: 2
- Overall: Pass after fixes

### `apps/backend/src/local-fleet-schema.ts`

#### Issues Found

**1. Decoder defects disguised as invalid client input — Warning (Applied)**

- **Location**: 49–52
- **Problem**: A blanket catch converted decoder implementation bugs into null, indistinguishable from validation failure.
- **Why it matters**: Server bugs become misleading 400 responses and lose their diagnostic signal.
- **Fix**:
```ts
export function decodeOrNull<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S, input: unknown,
): S["Type"] | null {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  return Result.isSuccess(decoded) ? decoded.success : null;
}
```

#### Summary
- Errors (Critical): 0
- Warnings: 1
- Info: 0
- Overall: Pass after fixes

### `apps/backend/src/sandbox/lifecycle.ts`

#### Issues Found

**1. Leak hooks could replace real cleanup outcomes — Warning (Applied)**

- **Location**: 140–170
- **Problem**: Throwing onLeak/onForget callbacks escaped the registry update.
- **Why it matters**: A successfully destroyed container could appear leaked; a mirror failure could mask the original release error.
- **Fix**:
```ts
leakedRegistry.delete(sandboxId);
try { hooks?.onForget?.(sandboxId); }
catch (error) { console.warn(`Leak-forget hook failed: ${redactSecrets(String(error))}`); }
// recordLeak writes registry state BEFORE calling onLeak; that hook is guarded too.
```

**2. Release failure masked the primary task failure — Warning (Applied)**

- **Location**: 199–220
- **Problem**: The finalizer re-raised its error even when the task had already failed/interrupted.
- **Why it matters**: The stored/reported error could describe cleanup rather than the actual executor/security failure.
- **Fix**:
```ts
const exit = yield* Effect.exit(releaseEffect);
if (Exit.isSuccess(exit)) { container.markReleased(); return; }
container.markLeaked();
recordLeak(opts.sandboxId, Cause.squash(exit.cause), opts.hooks);
console.error(`Failed to release sandbox container ${opts.sandboxId}`);
// Effect 4 finalizers require E=never. Only failed cleanup of a successful
// task becomes a defect; the Promise boundary classifies its tagged cause.
if (Exit.isSuccess(scopeExit)) yield* Effect.die(Cause.squash(exit.cause));
```

**3. Expected acquisition/task errors were defects — Warning (Applied)**

- **Location**: 187–198, 250–273
- **Problem**: Effect.promise and synchronous abort checks did not expose expected failures in the RunError channel.
- **Why it matters**: Expected SDK/task/cancellation failures looked like unexpected defects.
- **Fix**:
```ts
const acquired = tryRunPromise(async () =>
  new ManagedContainerImpl(opts.sandboxId, await opts.acquire(), opts.signal));
const taskEffect = tryRunPromise(async () => task(container));
// The abort checkpoint uses Effect.try with classifyRunError → toTaggedError.
```

**4. A hung scoped release never settled — Warning (Applied)**

- **Location**: 193, 201–209
- **Problem**: The release SDK Promise had no deadline.
- **Why it matters**: A stuck release could hold scope close indefinitely even though the task had finished.
- **Fix**:
```ts
const releaseEffect = tryRunPromise(() => opts.release(opts.sandboxId)).pipe(
  Effect.interruptible, // child wait only; finalizer retains its cleanup mask
  Effect.timeoutOrElse({
    duration: opts.releaseTimeoutMs ?? 30_000,
    orElse: () => Effect.fail(toTaggedError("request_timeout", "Sandbox release timed out.")),
  }),
);
// Existing exit handling fences the container and records the leak on timeout.
```

**5. Direct reclaim destroy still lacks a deadline — Warning (Deferred: Promise/SDK boundary migration)**

- **Location**: 320–333; orchestrator reclaimSweep
- **Problem**: destroyManagedContainer directly awaits an SDK destroy that offers no AbortSignal. Scoped-release timeout does not bound this standalone path.
- **Why it matters**: A hung destroy can stall the serial reclaim pass. A timeout cannot prove the underlying remote resource was destroyed.
- **Fix**:
```ts
// Proposed migration: expose an Effect-returning destroy operation, compose
// it directly into the reclaim pipeline (not runPromise inside that pipeline).
const destroy = tryRunPromise(() => handle.destroy()).pipe(
  Effect.timeoutOrElse({
    duration: 30_000,
    orElse: () => Effect.fail(toTaggedError("request_timeout", "Sandbox destroy timed out.")),
  }),
  Effect.catchCause(cause => Effect.sync(() => {
    recordLeak(sandboxId, Cause.squash(cause), hooks);
    console.warn(`Failed to destroy sandbox ${sandboxId}`);
  })),
);
// Keep the leak record until a later SDK destroy actually succeeds.
```

**6. Ambient mutable test seams — Warning (Deferred: compatibility-sensitive DI refactor)**

- **Location**: 303–312, 344–358
- **Problem**: Global resolver/factory setters can affect another test or DO in the same isolate if not reset. The leak registry itself is intentionally per-isolate.
- **Why it matters**: Ambient overrides complicate isolation; merely wrapping globals in Ref would not solve ownership.
- **Fix**:
```ts
// Proposed per-call structural injection, without adding a Layer hierarchy:
type SandboxDependencies = {
  resolve: SandboxHandleResolver;
  create: SandboxOpsFactory;
};
// Pass dependencies to acquire/destroy, defaulting at the host boundary.
// In existing tests, reset setter overrides in teardown when safe.
```

#### Summary
- Errors (Critical): 0
- Warnings: 6
- Info: 0
- Overall: Needs Fixes: standalone destroy deadline; seam isolation recommendation

### `apps/backend/src/agents/orchestrator.ts`

#### Issues Found

**1. Unbounded batch cleanup — Warning (Applied)**

- **Location**: 517–530, 2370–2397, 2470–2555, 2782–2783
- **Problem**: Dynamic Promise.all batches launched all cleanup/cancel operations at once.
- **Why it matters**: Large run/leak batches can overload sandbox bindings and delay reliable teardown.
- **Fix**:
```ts
// Signal every run first; do not delay cancellation behind slow cleanup.
for (const run of activeRuns) this.runControllers.get(run.runId)?.abort();
for (const run of activeRuns) await this.cancelRun(run.runId);
// Other cleanup batches similarly use serial loops: concurrency bound = 1.
```

**2. Silent advisory failures — Warning (Applied)**

- **Location**: 1024–1028, 1133–1137
- **Problem**: catchCause returned Effect.void without logging.
- **Why it matters**: Provider failure/defect/interruption disappeared, obscuring missing triage/quality output.
- **Fix**:
```ts
Effect.catchCause(cause =>
  Effect.logWarning("Advisory triage failed", redactSecrets(toRunFailure(cause).message)).pipe(
    Effect.annotateLogs({ runId, stage: "triage" }),
  ),
); // Same pattern for quality; advisory failure remains non-fatal.
```

**3. Triage could outlive its parent — Warning (Applied)**

- **Location**: 990–1029
- **Problem**: The advisory triage fiber was detached although tied to the active run.
- **Why it matters**: Parent completion/cancellation could leave irrelevant HTTP work alive.
- **Fix**:
```ts
yield* Effect.forkChild(triageEffect);
// Effect 4 forkChild is parent-supervised; not an Effect 3 forkScoped rename.
```

**4. Detached grading was not registered with the host — Warning (Applied)**

- **Location**: 1108–1148
- **Problem**: Independent quality grading was not held by ctx.waitUntil.
- **Why it matters**: Cloudflare could evict the host before grading finished.
- **Fix**:
```ts
const grading = yield* Effect.forkDetach(gradingEffect);
if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
  this.ctx.waitUntil(new Promise<void>(resolve => grading.addObserver(() => resolve())));
}
```

**5. Advisory HTTP waits were unbounded/non-abort-aware — Warning (Applied)**

- **Location**: 990–996, 1108–1112
- **Problem**: The helper HTTP work lacked an Effect timeout and did not forward the fiber signal.
- **Why it matters**: A timeout alone would not stop underlying fetch work.
- **Fix**:
```ts
tryRunPromise(signal => evaluateResultQuality(tsKey, output.slice(0, 2000),
  (url, init) => fetch(url, { ...init, signal }),
)).pipe(Effect.timeout(15_000));
// Triage uses the same deadline/signal wiring; catchCause logs the timeout.
```

**6. Expected pre-start faults thrown inside Effect — Warning (Applied)**

- **Location**: 787–990
- **Problem**: Route/config/token checks used promise defects or thrown Error inside the generator.
- **Why it matters**: RunError typing missed expected error paths.
- **Fix**:
```ts
const route = yield* tryRunPromise(() => this.resolveRoute(input));
if (!token) return yield* Effect.fail(toTaggedError("internal_error", "GITHUB_TOKEN is missing."));
// Synchronous parsing/abort checkpoints use Effect.try with tagged mapping.
```

**7. Pre-start failure left an approved run nonterminal — Critical (Applied)**

- **Location**: 793–815, 1224–1248
- **Problem**: Only the child use-phase caught failures; failures after reservation but before child dispatch skipped the terminal state write.
- **Why it matters**: A failed request consumed a live run slot until deadline reclaim.
- **Fix**:
```ts
Effect.catchCause(cause => Effect.andThen(Effect.sync(() => {
  if (failureRun === undefined) return;
  const failure = toRunFailure(cause);
  const updated = this.store.transition(failureRun.runId, terminalStatusFor(failure.code), {
    error: redactSecrets(failure.message).slice(0, 4000), errorCode: failure.code,
  }, failureRun.generation);
  if (updated === null) return; // cancellation/inner finish already won
  // Post redacted failure and dispatch error distillation, as in source.
}), Effect.failCause(cause)));
```

**8. Outbox drain failure prevented stale-run reclamation — Warning (Applied)**

- **Location**: 2334–2355
- **Problem**: A drain-level exception escaped before the reclaim sweep.
- **Why it matters**: A durable write/send failure could stop container cleanup and make run polling fail.
- **Fix**:
```ts
await this.drainEffectOutbox().catch(error => {
  console.error("Run effect outbox drain failed", redactSecrets(String(error)));
});
await this.reclaimSweep(); // durable outbox remains retryable; do not fake delivery
```

**9. Structured child error leaked to Slack — Critical (Applied)**

- **Location**: 1175–1188
- **Problem**: JSON-derived failure detail was posted without redaction.
- **Why it matters**: Executor output can contain credentials; Slack is an external sink.
- **Fix**:
```ts
detail: redactSecrets(message).slice(0, 1000),
```

**10. Missing host-context guard stranded post-back bookkeeping — Warning (Applied)**

- **Location**: 2183–2220
- **Problem**: postToThread directly called this.ctx.waitUntil unlike other host seams.
- **Why it matters**: The supported ctx-less test seam threw before the handlers settled; cancel cleanup stopped and the claim remained stuck.
- **Fix**:
```ts
const settled = send.then(onSuccess).catch(onFailure);
if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
  this.ctx.waitUntil(settled);
} else {
  void settled;
}
```

**11. Incomplete metrics/traces and concentrated pipeline — Info (Deferred: architectural/observability follow-up)**

- **Location**: 787–1249; lifecycle/retry boundaries
- **Problem**: The long generator mixes admission, dispatch, finish and advisory work; log annotations are not counters or distributed spans.
- **Why it matters**: It is harder to reason about branch invariants and measure retry/cleanup reliability.
- **Fix**:
```ts
// Proposed follow-up (no new dependency):
const started = Metric.counter("delegated_runs_started");
const dispatch = Effect.gen(function* () {
  yield* Metric.update(started, 1); // Effect 4 API; Metric.increment is not exported
  return yield* dispatchApprovedRun;
}).pipe(Effect.withSpan("delegated-run"));
// Extract admission and fenced finish functions before moving their behavior.
// Never use runId/sessionId as metric labels; keep those in logs/spans.
```

#### Summary
- Errors (Critical): 2
- Warnings: 8
- Info: 1
- Overall: Needs Fixes: telemetry/organization recommendations; applied correctness fixes verified

### `alchemy.run.ts`

#### Issues Found

**1. Stale version comment and duplicate config binding — Info (Applied)**

- **Location**: 23–26, configVars near 330
- **Problem**: Comment referred to a different Effect version; AGENT_MAILBOX appeared twice.
- **Why it matters**: Misleading API assumptions and duplicated declarations invite drift.
- **Fix**:
```ts
// Both repository and Alchemy use Effect 4.
// Keep exactly one "AGENT_MAILBOX" entry in configVars([...]).
```

#### Summary
- Errors (Critical): 0
- Warnings: 0
- Info: 1
- Overall: Pass after fixes

### `apps/backend/test/container-lifecycle.test.ts and local-fleet-schema.test.ts`

#### Issues Found

**1. Global registry pollution and sparse boundary negatives — Warning (Applied)**

- **Location**: lifecycle afterEach; schema validation tests
- **Problem**: Some leak tests left registry entries; schema tests covered few invalid field shapes.
- **Why it matters**: Test order can hide leaked state and boundary regressions can escape.
- **Fix**:
```ts
afterEach(() => {
  for (const leak of leakedContainers()) forgetLeaked(leak.sandboxId);
});
// Added fleet cases: numeric machineId, oversized hostname/token,
// non-array harnesses, >16 harnesses and >32-character harness names.
```

#### Summary
- Errors (Critical): 0
- Warnings: 1
- Info: 0
- Overall: Pass after fixes

## Non-findings and rejected blanket rules

- `Data.TaggedError` was already typed; migrating it is not evidence of raw errors. `Schema.Unknown` is appropriate for a wrapped external cause, not an untyped error union.
- No proven nested `Effect.runPromise` remains in the reviewed Effect pipelines. `runPromiseExit`, `runFork`, and the Promise host bridges are explicit terminal boundaries.
- `acquireRelease` already protects acquisition by default in Effect 4. The review claim that interruption drops a newly acquired container was **retracted** after inspecting `uninterruptibleMask`.
- Existing scopes already release on success/failure/interruption. A timeout cannot cancel SDK methods that expose no signal; leak records must remain until actual cleanup succeeds.
- Framework-owned sockets/HTTP responses do not require replacing the entire host with Layers. Structural injection is deliberate here; missing Context/Layer classes alone are not a defect.
- Retry is already bounded with exponential full-jitter/capped scheduling. No infinite retry or unnecessary concurrency rewrites were added.
- Console logs at Promise/host boundaries are not silently swallowed failures. Inside the reviewed advisory Effects, logs are structured and redacted. Release logs deliberately omit raw failure text (an existing regression contract).
- TestClock/TestContext are not main-index exports in this installed Effect version; no new @effect/vitest dependency was added. The short scoped-release deadline test uses a 10 ms budget without a timing-performance assertion.

## Evidence and remaining risks

Red/green regressions cover batch cleanup, advisory logs, host-held grading, triage cancellation, hook failures, primary-vs-cleanup errors, decoder defects, pre-start terminalization, outbox cleanup continuation, Slack redaction, ctx-less post-back, and hung scoped release. Direct typed error/retry identity tests were preserved.

Final gate results and counts: see `.omx/reports/effect-review/final-gates.txt` and `final-*.log`. Docker-dependent deployment dry-run is unavailable because Docker is not running; no deployment was attempted. Existing lint warnings and unrelated workspace changes are not claimed fixed.

Review reports from all ten dimensions are preserved in `.omx/reports/effect-review/EFFECT-DIMENSION-{1..10}.md`; these intermediate reports may precede the final fixes and are superseded by this consolidated disposition. Minor optional nits there (regex splitting, duplicate helpers, serial teardown latency, extra wire assertions) do not establish current production defects.

Standalone SDK destroy/acquisition calls can still hang; scoped release is bounded, but the SDK exposes no reliable underlying cancellation. Module test setters remain ambient. Metrics, spans, and extraction of the large generator remain follow-up work rather than a risky repository-wide architecture rewrite.

### Final validation (2026-10-10)

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass; 957 warnings and 1 info remain |
| `pnpm lint:imports` | Pass |
| `pnpm test` | Pass; backend 1,843 passed / 3 skipped; desktop 152 passed; auth 10 passed; frontend 31 passed |
| `pnpm build` | Pass; 49 HTML pages and 2,503 local links/assets/anchors verified |
| `pnpm test:built` | Pass |
| `pnpm check:ci` | Pass |
| `pnpm env:load`, `pnpm env:scan` | Pass |
| Changed-file `git diff --check` | Pass |
| Extra `biome check` (format/import assists included) | Not clean: 13 formatting/import diagnostics, 51 warnings across reviewed files; no wholesale reformat of mixed existing work |
| Docker-dependent Wrangler dry-run | Not run: `docker info` fails |

Counts in per-file summaries count historical findings, including fixed issues, not current outstanding runtime errors. Source fixes are limited to seven reviewed source/config files, with direct regression suites in backend tests. No dependencies added; approval and credential-isolation contracts unchanged.

### Team execution evidence

- Team: `perform-the-final-ten-a217d31e`; ten primary `devin/swe-2` workers, ten worker ACKs; isolated snapshot worktrees protected existing workspace changes.
- Terminal status: **complete**, 19 durable tasks completed, 0 pending/in-progress/failed (ten dimension lanes plus nine duplicate coordination tasks).
- Evidence: `.omx/reports/effect-review/team-launch.log`, `team-evidence.json`, `team-final-status.log`, `team-final-state/`, and `team-shutdown.log`.
- The leader verified/integrated the ten reports and final original-workspace gates. Worker-9's delivered performance report was terminalized by the leader using the runtime API after worker bookkeeping stalled; no report or test success was fabricated.

- Shutdown succeeded; runtime team state and owned worker windows were removed. The original leader window was preserved; no active OMX modes remain.

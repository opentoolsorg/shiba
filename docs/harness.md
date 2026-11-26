# Harness and session-layer architecture

A harness is the execution transport inside a runtime lane. It is not the
Employee Orchestrator, and it is not the product center. A run selects exactly
one harness after approval. The control plane remains responsible for identity,
workspace scope, approval, lineage, cancellation, evidence, and publication.

## Layers

```text
Employee Orchestrator
  → approved structured run envelope
  → Run Execution Agent / runtime adapter
  → scoped executor
  → selected harness process or protocol
  → normalized progress, files, diffs, verification, and errors
```

The shared seam is the harness interface in `apps/backend/src/harness/`.
Provider-specific CLIs or protocols plug into that seam. The same approved
result shape can be produced by the sandbox runtime or by the local runtime.

## Required harness contract

A harness must declare or implement:

- supported providers and models;
- supported runtimes;
- egress hosts for the selected model/provider route;
- configuration file behavior, when needed;
- environment variables safe for the execution environment;
- command construction;
- structured event parsing;
- capability limits such as resume, verification, reasoning levels, and local
  execution support.

Egress hosts are composed for the selected harness only. Do not union every
harness's provider hosts into one sandbox policy.

## Error behavior

Provider error envelopes must throw or become structured failure events. They
must not become normal progress text. A harness may report partial output, but
it must not convert a failed turn into a completed run.

## Credential behavior

Real provider and subscription credentials stay outside the container. The
execution environment receives placeholders, dummy keys, or scoped capabilities.
Worker-side egress attaches the real credential only for the approved provider
route. Subscription lanes are separate harnesses and remain dark unless their
deployment flag is explicitly enabled.

## Checkpoint and evidence behavior

Repository and artifact sandbox runs can capture hidden git refs before and
after execution. Those refs let the control plane calculate what changed without
trusting prose. Oversize diffs and files must export through the owning artifact
path rather than being silently truncated.

Verification is evidence only when the run records the command, outcome, and
relevant output. Missing verification must remain missing. It must not be
rounded up to success.

## Local runtime behavior

The local daemon uses the same result shape as the sandbox lane. It does not
become a second orchestrator. It claims approved work through `LocalDispatch`,
executes it on the paired machine, and posts evidence back. A local harness must
explicitly support the local runtime.

## Adding a harness

When adding a harness, update all of these in one change:

1. harness implementation and registry;
2. capabilities and supported runtimes;
3. egress hosts;
4. default model and environment variable mapping;
5. catalog/version metadata;
6. container image or local daemon installation path;
7. admission/preflight validation;
8. tests for success, provider error, cancellation, and unsupported runtime;
9. documentation for what is verified and what is not.

Do not register a harness as production-capable because the CLI exists. Register
it only when its approval, credential, egress, evidence, and runtime behavior
are implemented and tested.

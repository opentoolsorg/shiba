# Backend ports

## Sandbox

`apps/backend/src/ports/sandbox/interface.ts` exposes the existing shared
`@shiba/sandbox` types. `get(id)` retains the existing lazy creation semantics;
there is no new eager create step before approval. The contract includes streamed
execution, file IO, preview ports, optional snapshots, capabilities and destruction.
Old `sandbox/interface.ts`, `sandbox/provider.ts`, `sandbox/client.ts` and
`sandbox/computesdk-lazy.ts` paths remain compatibility exports.

`createSandboxRegistry(env, dependencies?)` creates an execution-context registry.
Pass it into `createSandboxOps` or the static-preview dependency context. Legacy
helpers use one registry per Worker env. Provider instances are cached within that
context; organization runner rotation retains its existing versioned cache keys.
Selection remains task, custom agent, organization, deployment env, then Cloudflare.
The existing egress opt-in guard still applies to providers without edge enforcement.

Backend Cloudflare RPC resolution and the Sandbox Durable Object live in
`adapters/sandbox/cloudflare/`. The separately approved offline desktop's file
transport uses the sandbox file port. ComputeSDK host loading and remote runner
construction are in `adapters/sandbox/computesdk/`. Both reuse the existing
`packages/sandbox` transport implementations to retain compatibility with its
non-Worker consumers. Backend core imports no Cloudflare Sandbox SDK directly.
The legacy RPC port still exposes Cloudflare-specific diagnostics used by sandbox
routes; replacing that diagnostic API is a separate behavior/API change.

Run the backend `sandbox-port-contract`, `sandbox-port-registry` and
`sandbox-port-boundary` tests. The contract executes both adapters with in-memory
RPC/client fakes. The boundary test restricts Cloudflare SDK imports to its adapter
folder (and permits the Worker entry's Durable Object class export).

### Adding Docker or E2B

1. Implement a backend adapter under `adapters/sandbox/<vendor>/` using the shared
   `SandboxProvider` and `SandboxInstance` contracts; keep vendor clients there.
2. Register its factory with the shared provider registry consumed by the backend
   registry. Preserve custom registration overrides and existing selection precedence.
3. Declare truthful capabilities and retain the existing unenforced-egress opt-in.
   Reject unsupported operations explicitly. Do not move credentials into containers.
4. Add the adapter to `sandbox-port-contract.test.ts` with a fake native client,
   including creation, streaming output, IO, preview, optional snapshots and teardown.
5. Add selection/preflight tests and separate host integration tests before enabling
   real execution. Existing Docker and E2B package adapters are unchanged by this PR.

Follow-ups: the ComputeSDK capability catalog can advertise snapshots for a backend
while its current instance wrapper has no snapshot method. The port keeps that
method optional to preserve behavior; a later adapter change should align them.

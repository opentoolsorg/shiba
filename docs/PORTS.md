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

---

# Connector port

The connector boundary lives in `apps/backend/src/ports/connector/`.
`ConnectorProvider` owns app catalog metadata (including auth types), action
search, owned connections, connect, revoke and invocation. The existing method
names remain `listCatalog`, `searchActions`, `listConnections`, `beginConnect`,
`disconnect` and `executeTool` to preserve callers and response shapes.

`registry.ts` creates adapters from an environment and accepts a provider
instance for dependency injection. Set `CONNECTOR_PROVIDER=openconnector` for
the current service or `CONNECTOR_PROVIDER=none` to disable it. With no selector,
the registry preserves the existing OpenConnector default. Adapter selection is
reported by `adapterId`; the existing integration wire identifier stays
`openconnector` for compatibility with current shared schemas.

The OpenConnector adapter supports OAuth redirects. API-key and custom-credential
accounts remain operator-managed and cannot acquire execution authority through
this OAuth path. Its capabilities declare this limit. Supporting a credential
form requires a separate approved enrollment path; this extraction adds none.

`ConnectorProviderError` distinguishes `not_configured`, `auth_expired`,
`forbidden`, `rate_limited` and `unavailable`. Missing configuration must produce
a setup state. Catalog and connections reads return HTTP 200 with
`configured:false` when setup is absent. Provider failures never include upstream
response bodies.

Permissions remain Worker-owned: `approvedConnectionId` binds the current consent
generation, `approvedUntil` bounds human approval, and `beforeDispatch` rechecks
trusted authority after provider preflight. These fields are internal function
arguments, never model input or browser authority. The port does not replace
workspace, employee or exact-action checks.

The reusable contract suite is `ports/connector/contract.ts`, registered by
`test/connector-port.test.ts` for both adapters. It exercises a fake gateway;
existing provider and route tests retain coverage of the service protocol and
security boundaries.

## Adding Composio

1. Implement `ConnectorProvider` under `adapters/connector/composio/`. Keep all
   Composio SDK or HTTP access inside that directory.
2. Map app/action/auth metadata and owned account identifiers to the port types.
   Preserve server-derived identity, consent generations, cancellation and the
   final permission hook. Declare only capabilities the implementation supports.
3. Translate service errors to `ConnectorProviderError`; keep credentials and
   upstream error bodies out of returned errors.
4. Add the adapter to the single connector registry and register a fake-gateway
   factory with `connectorProviderContract`. Run the same contract suite and add
   service-specific tests for identity and authorization behavior.
5. Extend shared wire identifiers and credential-form contracts in a separate
   behavior change with API and frontend coverage before enabling the adapter.

No Composio implementation or dependency is included here. PR #260 owns the
richer integrations setup card; this extraction keeps the route change to the
unconfigured read response.

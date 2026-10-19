# Adapter template

1. **Pick an id** — add to `SandboxProviderId` in `src/types.ts` if new.
2. **Declare capabilities** — every boolean must reflect reality (do not set `edgeEgressEnforcement: true` without Worker-side outbound filtering).
3. **Implement `SandboxProvider`**:
   - `get(id)` — lazy start; cache per provider instance if helpful.
   - `destroy(id)` — idempotent teardown.
4. **Map errors** to `SandboxError` with a stable `code`.
5. **Export factory** from `src/adapters/<name>.ts` and add a subpath export in `package.json`.
6. **Register** in `apps/backend/src/sandbox/provider.ts` behind `SHIBA_SANDBOX_PROVIDER`.
7. **Tests** — call `describeSandboxProviderContract` from `src/contract-suite.ts` with mocks.

```ts
import { createCloudflareSandboxProvider } from "@shiba/sandbox/adapters/cloudflare";

export function createMyProvider(deps: MyDeps): SandboxProvider {
  return {
    id: "my-provider",
    capabilities: { /* ... */ },
    async get(instanceId) { /* ... */ },
    async destroy(instanceId) { /* ... */ },
  };
}
```

Keep Worker-only bindings (Durable Object namespaces, `SandboxOutbound`) in the backend — pass a `resolveRpc` closure into `createCloudflareSandboxProvider`, do not import `cloudflare:workers` from the package.

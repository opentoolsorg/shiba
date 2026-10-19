---
title: Write your own sandbox provider
description: Register a custom @shiba/sandbox adapter without forking shiba.
---

Shiba sandboxes are pluggable through **`@shiba/sandbox`**. Built-ins (`cloudflare`, `docker-local`, `computesdk`, `e2b`) use the same **`registerSandboxProvider(name, factory)`** API you do.

## Minimal example

```typescript
import {
  registerSandboxProvider,
  type SandboxProvider,
  type SandboxProviderFactoryContext,
} from "@shiba/sandbox";

registerSandboxProvider("my-hypervisor", (ctx: SandboxProviderFactoryContext): SandboxProvider => {
  const timeoutMs = ctx.config.options.timeoutMs;
  return {
    id: "my-hypervisor",
    capabilities: {
      edgeEgressEnforcement: false,
      previewUrls: false,
      snapshots: false,
      streamingExec: true,
      backgroundProcesses: false,
      rawProviderHandle: true,
    },
    async get(instanceId) {
      // start or attach VM/container for instanceId
      return {
        id: instanceId,
        capabilities: this.capabilities,
        async exec(command, opts) {
          // ...
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async writeFile() {},
        async readFile() {
          return { kind: "utf8", content: "" };
        },
        async gitCheckout() {},
        async destroy() {},
        raw() {
          return { hypervisor: "native-handle" };
        },
      };
    },
    async destroy(instanceId) {
      // idempotent teardown
    },
  };
});
```

Wire it in your deployment by importing the file **before** the Worker resolves sandboxes, e.g. add `import "./sandbox/my-provider.js"` to `apps/backend/src/sandbox/custom-providers.ts` and import that once from your bootstrap path.

Set `SHIBA_SANDBOX_PROVIDER=my-hypervisor`. If you cannot enforce Worker-side egress, also set `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1`.

## Conformance tests

```typescript
import { describeSandboxProviderContract } from "@shiba/sandbox";

describeSandboxProviderContract("my-hypervisor", () => createMyProvider());
```

Run the same suite built-in adapters use (`packages/sandbox/src/contract-suite.ts`).

## Config reference (env)

| Variable | Default | Applies to |
| --- | --- | --- |
| `SHIBA_SANDBOX_PROVIDER` | `cloudflare` | All |
| `SHIBA_SANDBOX_TIMEOUT_MS` | `900000` (15m) | Default exec timeout |
| `SHIBA_SANDBOX_REGION` | unset | Hosted backends (provider-specific) |
| `SHIBA_SANDBOX_EGRESS_ALLOWLIST` | unset | Extra hosts merged on cloudflare egress pin |
| `SHIBA_SANDBOX_ENV_PASSTHROUGH` | unset | `KEY=value,...` non-secret exec env |
| `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS` | off | Required for docker-local / computesdk / most custom |
| `INSTANCE_TYPE` | `standard-1` | Cloudflare container size |
| `SHIBA_DOCKER_SANDBOX_IMAGE` | `shiba-sandbox:local` | docker-local |
| `SHIBA_COMPUTESDK_PROVIDER` | required if computesdk | e2b, modal, daytona, … |

See [Sandbox providers](/docs/sandbox-providers/) and [Sandbox cost guide](/docs/sandbox-cheapest-provider/).

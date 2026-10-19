import type { CloudflareSandboxRpc } from "./adapters/cloudflare.js";
import type { ComputesdkClient } from "./adapters/computesdk-types.js";
import type { SandboxProvider } from "./types.js";

/** Injected by the host runtime (Worker, Node agent) — not serializable env vars. */
export interface SandboxHostDeps {
  cloudflareResolveRpc?: (instanceId: string) => CloudflareSandboxRpc;
  /** Lazy ComputeSDK provider (Node/Bun only). */
  computesdkLoadProvider?: () => Promise<SandboxProvider>;
  computesdkClient?: ComputesdkClient;
}

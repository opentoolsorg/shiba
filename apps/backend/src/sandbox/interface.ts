/**
 * Sandbox SDK port (Phase 2b). Production still uses @cloudflare/sandbox@0.12.9
 * via `acquireSandboxOps` / `SandboxOps`; SDK 1.0 migration should replace
 * only the factory behind this seam, not orchestration or approval code.
 */
export type { SandboxOps } from "../runtime.js";

/**
 * Sandbox seams consumed by orchestration, browser E2E, and subagent paths.
 * SDK 1.0 stays behind @shiba/sandbox's Cloudflare adapter — swap providers via
 * SHIBA_SANDBOX_PROVIDER without touching approval or egress policy code.
 */
export type { SandboxOps } from "../runtime.js";
export type {
  PreviewPortGateway,
  SandboxInstance,
  SandboxProvider,
} from "@shiba/sandbox";

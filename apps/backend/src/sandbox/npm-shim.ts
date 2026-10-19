/**
 * Vitest / Node resolution shim for imports that still target
 * `@cloudflare/sandbox` (mostly test mocks). Production code imports
 * `./sandbox/client.js` directly.
 */
export { getSandbox } from "./client.js";
export { proxyToSandbox } from "./proxy.js";

/** Removed in SDK 1.0 — kept so legacy test mocks type-check. */
export class ContainerProxy {}

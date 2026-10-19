import { vi } from "vitest";

// @shiba/auth (pulled by src/auth/index.ts) imports @cloudflare/sandbox for
// antigravity OAuth — Node cannot resolve that specifier without a stub.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  Container: class {},
  proxyToSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getContainer: vi.fn(),
}));

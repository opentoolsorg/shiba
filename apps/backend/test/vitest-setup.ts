import { vi } from "vitest";

// Node fixture only. The local Worker integration test exercises the native API.
if (!("FixedLengthStream" in globalThis)) {
  class FixtureFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(length: number | bigint) {
      let written = 0;
      const expected = Number(length);
      super({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > expected) throw new TypeError("FixedLengthStream received too many bytes.");
          controller.enqueue(chunk);
        },
        flush() {
          if (written !== expected) throw new TypeError("FixedLengthStream received too few bytes.");
        },
      });
    }
  }
  Object.defineProperty(globalThis, "FixedLengthStream", { value: FixtureFixedLengthStream, configurable: true });
}

// @shiba/auth (pulled by src/auth/index.ts) imports @cloudflare/sandbox for
// antigravity OAuth — Node cannot resolve that specifier without a stub.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  Container: class {},
  proxyToSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getContainer: vi.fn(),
}));

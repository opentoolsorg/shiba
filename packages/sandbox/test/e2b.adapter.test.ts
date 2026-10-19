import { describe, expect, it } from "vitest";
import { createE2bSandboxProvider } from "../src/adapters/e2b.js";
import { describeSandboxProviderContract } from "../src/contract-suite.js";
import { SandboxError } from "../src/errors.js";

describeSandboxProviderContract("e2b (mock)", () =>
  createE2bSandboxProvider({ mockInstance: true }),
);

describe("e2b live guard", () => {
  it("refuses without api key", async () => {
    const provider = createE2bSandboxProvider({});
    await expect(provider.get("x")).rejects.toBeInstanceOf(SandboxError);
  });
});

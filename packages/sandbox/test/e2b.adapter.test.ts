import { describe, expect, it } from "vitest";
import { createE2bSandboxProvider } from "../src/adapters/e2b.js";
import { describeSandboxProviderContract } from "../src/contract-suite.js";
import { SandboxError } from "../src/errors.js";

describeSandboxProviderContract("e2b (mock)", () =>
  createE2bSandboxProvider({ mockInstance: true }),
);

describe("e2b live guard", () => {
  it("refuses a native journal attach instead of executing an ordinary command", async () => {
    const instance = await createE2bSandboxProvider({ mockInstance: true }).get("refuse-resume");
    await expect(instance.exec("do-not-run", { journal: { jobId: "a".repeat(64), deadline: Date.now() + 60_000,
      mode: "attach", observationDeadline: Date.now() + 60_000 } })).rejects.toMatchObject({ code: "capability_unsupported" });
    await expect(instance.exec("do-not-run", { requiredJournalJobId: "a".repeat(64) })).rejects.toMatchObject({ code: "capability_unsupported" });
  });
  it("refuses without api key", async () => {
    const provider = createE2bSandboxProvider({});
    await expect(provider.get("x")).rejects.toBeInstanceOf(SandboxError);
  });
});

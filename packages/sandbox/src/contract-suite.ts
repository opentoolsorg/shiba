import { describe, expect, it } from "vitest";
import type { SandboxProvider } from "./types.js";

/**
 * Shared behavioral contract every adapter should pass (with mocks where needed).
 * Import in adapter test files: `describeContract(createProvider)`.
 */
export function describeSandboxProviderContract(
  label: string,
  createProvider: () => SandboxProvider | Promise<SandboxProvider>,
) {
  describe(`sandbox contract: ${label}`, () => {
    it("exposes stable id and capabilities", async () => {
      const provider = await createProvider();
      expect(provider.id).toBeTruthy();
      expect(typeof provider.capabilities.edgeEgressEnforcement).toBe("boolean");
      expect(typeof provider.capabilities.previewUrls).toBe("boolean");
    });

    it("get returns an instance with matching id", async () => {
      const provider = await createProvider();
      const instance = await provider.get("contract-test-id");
      expect(instance.id).toBe("contract-test-id");
      expect(instance.capabilities).toEqual(provider.capabilities);
    });

    it("writeFile + readFile round-trip text", async () => {
      const provider = await createProvider();
      const instance = await provider.get("contract-io");
      if (!instance.writeFile || !instance.readFile) return;
      await instance.writeFile("/tmp/shiba-contract.txt", "hello-shiba");
      const read = await instance.readFile("/tmp/shiba-contract.txt");
      expect(read.kind).toBe("utf8");
      if (read.kind === "utf8") expect(read.content).toBe("hello-shiba");
    });

    it("exec runs a trivial command", async () => {
      const provider = await createProvider();
      const instance = await provider.get("contract-exec");
      const result = await instance.exec("echo contract-ok");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("contract-ok");
    });

    it("destroy is idempotent", async () => {
      const provider = await createProvider();
      await provider.destroy("contract-destroy");
      await provider.destroy("contract-destroy");
    });
  });
}

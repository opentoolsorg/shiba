import { describe, expect, it } from "vitest";
import type { SandboxProvider } from "./interface.js";

export interface SandboxContractFixture {
  provider: SandboxProvider;
  resources: Set<string>;
  executions: Array<{
    command: string;
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  }>;
}

/** Run against each adapter with fake transport dependencies, never a live service. */
export function describeSandboxProviderContract(
  label: string,
  createFixture: () => SandboxContractFixture,
): void {
  describe(`sandbox port contract: ${label}`, () => {
    it("does not materialize resources until get, and preserves the requested id", async () => {
      const { provider, resources } = createFixture();
      expect(resources.size).toBe(0);
      const first = await provider.get("contract-id");
      const again = await provider.get("contract-id");
      expect(first.id).toBe("contract-id");
      expect(again.id).toBe(first.id);
      expect(resources.size).toBe(1);
      expect(first.capabilities).toEqual(provider.capabilities);
      expect(typeof provider.capabilities.streamingExec).toBe("boolean");
      expect(typeof provider.capabilities.previewUrls).toBe("boolean");
    });

    it("round-trips files and enforces the read size limit", async () => {
      const { provider } = createFixture();
      const instance = await provider.get("contract-files");
      await instance.writeFile("/tmp/contract.txt", "hello-shiba");
      expect(await instance.readFile("/tmp/contract.txt")).toEqual({ kind: "utf8", content: "hello-shiba" });
      await expect(instance.readFile("/tmp/contract.txt", { maxBytes: 2 })).rejects.toMatchObject({ code: "io_failed" });
    });

    it("forwards execution options and returns normalized output with streamed chunks", async () => {
      const { provider, executions } = createFixture();
      const instance = await provider.get("contract-exec");
      const chunks: Array<[string, string]> = [];
      const result = await instance.exec("echo contract-ok", {
        cwd: "/workspace",
        timeoutMs: 1234,
        env: { CONTRACT: "yes" },
        onOutput: (stream, chunk) => chunks.push([stream, chunk]),
      });
      expect(result).toEqual({ stdout: "contract-ok\n", stderr: "diagnostic\n", exitCode: 7 });
      expect(executions).toEqual([{
        command: "echo contract-ok",
        cwd: "/workspace",
        timeout: 1234,
        env: { BASE: "base", CONTRACT: "yes" },
      }]);
      if (provider.capabilities.streamingExec) {
        expect(chunks).toEqual([["stdout", "contract-ok\n"], ["stderr", "diagnostic\n"]]);
      }
    });

    it("rejects an already cancelled execution before invoking the transport", async () => {
      const { provider, executions } = createFixture();
      const instance = await provider.get("contract-abort");
      const controller = new AbortController();
      controller.abort();
      await expect(instance.exec("must-not-run", { signal: controller.signal })).rejects.toThrow();
      expect(executions).toEqual([]);
    });

    it("provides a preview URL when advertised", async () => {
      const { provider } = createFixture();
      const instance = await provider.get("contract-preview");
      if (!provider.capabilities.previewUrls) return;
      expect(instance.exposePort).toBeTypeOf("function");
      const preview = await instance.exposePort?.(8080, { hostname: "preview.example" });
      expect(preview?.url).toBe("https://preview.example/8080/");
    });

    it("supports snapshots when the instance implements them", async () => {
      const { provider } = createFixture();
      const instance = await provider.get("contract-snapshot");
      if (!instance.snapshot) return;
      expect(provider.capabilities.snapshots).toBe(true);
      expect(await instance.snapshot("checkpoint")).toEqual({ id: "checkpoint", size: 12 });
    });

    it("destroys a materialized resource and permits repeated provider cleanup", async () => {
      const { provider, resources } = createFixture();
      await provider.get("contract-destroy");
      expect(resources.size).toBe(1);
      await provider.destroy("contract-destroy");
      expect(resources.size).toBe(0);
      await provider.destroy("contract-destroy");
      expect(resources.size).toBe(0);
    });

    it("supports cleanup through the instance", async () => {
      const { provider, resources } = createFixture();
      const instance = await provider.get("contract-instance-destroy");
      await instance.destroy();
      expect(resources.size).toBe(0);
    });
  });
}

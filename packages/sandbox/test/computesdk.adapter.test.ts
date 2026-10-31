import { describe, expect, it, vi } from "vitest";
import { createComputesdkSandboxProvider } from "../src/adapters/computesdk.js";
import type { ComputesdkClient, ComputesdkInstance } from "../src/adapters/computesdk-types.js";
import { describeSandboxProviderContract } from "../src/contract-suite.js";
import { SandboxError } from "../src/errors.js";

function makeFakeClient(): ComputesdkClient & { instances: ComputesdkClient["instances"] & { store: Map<string, ComputesdkInstance> } } {
  const store = new Map<string, ComputesdkInstance>();
  const files = new Map<string, string>();

  const makeInstance = (instanceId: string): ComputesdkInstance => ({
    instanceId,
    provider: "fake",
    async runCommand(command, options) {
      if (command.includes("echo contract-ok")) {
        return { stdout: "contract-ok\n", stderr: "", exitCode: 0, durationMs: 1 };
      }
      options?.onStdout?.("partial\n");
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
    async startProcess() {
      return {
        async kill() {},
        async wait() {
          return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, signal: null };
        },
      };
    },
    async getUrl({ port }) {
      return `https://fake.example/${instanceId}/${port}/`;
    },
    async destroy() {
      store.delete(instanceId);
    },
    filesystem: {
      async writeFile(path, content) {
        files.set(path, content);
      },
      async readFile(path) {
        const v = files.get(path);
        if (v === undefined) throw new Error("missing");
        return v;
      },
      async mkdir() {},
    },
  });

  return {
    backendProvider: "e2b",
    instances: {
      store,
      async create(options) {
        const id = `cs-${store.size + 1}`;
        const inst = makeInstance(id);
        store.set(id, inst);
        return inst;
      },
      async getById(id) {
        return store.get(id) ?? null;
      },
      async destroy(id) {
        store.delete(id);
      },
    },
  };
}

describeSandboxProviderContract("computesdk (fake client)", () =>
  createComputesdkSandboxProvider({ client: makeFakeClient() }),
);

describe("computesdk raw()", () => {
  it("returns native instance when capability is set", async () => {
    const client = makeFakeClient();
    const provider = createComputesdkSandboxProvider({ client });
    const instance = await provider.get("raw-test");
    const native = instance.raw?.();
    expect(native).toBeTruthy();
    expect((native as ComputesdkInstance).provider).toBe("fake");
  });

  it("refuses pinEgress", async () => {
    const provider = createComputesdkSandboxProvider({ client: makeFakeClient() });
    const instance = await provider.get("egress-test");
    await expect(instance.pinEgress?.({ allowedHosts: ["x"] })).rejects.toBeInstanceOf(SandboxError);
  });
});

describe("computesdk destroy", () => {
  it("is idempotent when mapping is cleared", async () => {
    const client = makeFakeClient();
    const provider = createComputesdkSandboxProvider({ client });
    await provider.get("d1");
    await provider.destroy("d1");
    await provider.destroy("d1");
  });

  it("retains the provider mapping when destroy fails so a retry can run", async () => {
    const client = makeFakeClient();
    const originalDestroy = client.instances.destroy.bind(client.instances);
    let calls = 0;
    client.instances.destroy = async (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("provider unavailable");
      return originalDestroy(id);
    };
    const provider = createComputesdkSandboxProvider({ client });
    await provider.get("d1");
    await expect(provider.destroy("d1")).rejects.toBeInstanceOf(SandboxError);
    await provider.destroy("d1");
    expect(calls).toBe(2);
  });
});

describe("computesdk gitCheckout", () => {
  it("terminates git option parsing before operands", async () => {
    const client = makeFakeClient();
    let lastCommand = "";
    const provider = createComputesdkSandboxProvider({ client });
    const instance = await provider.get("clone-test");
    const native = instance.raw?.() as ComputesdkInstance;
    native.runCommand = async (command) => {
      lastCommand = command;
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    };
    await instance.gitCheckout("git@github.com:o/r.git", { branch: "", targetDir: "/workspace/r" });
    expect(lastCommand).toContain(" -- ");
  });
});

describe("computesdk unexposePort", () => {
  it("reports unsupported instead of silently succeeding", async () => {
    const provider = createComputesdkSandboxProvider({ client: makeFakeClient() });
    const instance = await provider.get("preview-test");
    await expect(instance.unexposePort?.(8080)).rejects.toBeInstanceOf(SandboxError);
  });
});

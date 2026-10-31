import { resolveSandboxDurableObjectId } from "@shiba/shared";
import { describe, expect, it } from "vitest";
import { Sandbox } from "../src/sandbox/durable-object.js";

describe("resolveSandboxDurableObjectId", () => {
  const namespace = {
    idFromName: (name: string) => ({ kind: "name", name }) as unknown as DurableObjectId,
    idFromString: (id: string) => ({ kind: "string", id }) as unknown as DurableObjectId,
  };

  it("uses idFromName for run-scoped sandbox ids", () => {
    const id = resolveSandboxDurableObjectId(namespace, "run-deadbeefcafe01");
    expect(id).toEqual({ kind: "name", name: "run-deadbeefcafe01" });
  });

  it("uses idFromString for 64-char durable object ids", () => {
    const hex = "a".repeat(64);
    const id = resolveSandboxDurableObjectId(namespace, hex);
    expect(id).toEqual({ kind: "string", id: hex });
  });
});

describe("Sandbox organization binding", () => {
  function sandboxForTest(): { sandbox: Sandbox; stored: Map<string, unknown> } {
    const stored = new Map<string, unknown>();
    const sandbox = Object.assign(Object.create(Sandbox.prototype), {
      ctx: {
        storage: {
          kv: {
            get: (key: string) => stored.get(key),
            put: (key: string, value: unknown) => stored.set(key, value),
          },
        },
      },
    }) as Sandbox;
    return { sandbox, stored };
  }

  it("pins the outbound org to the first run and allows idempotent setup", async () => {
    const { sandbox } = sandboxForTest();
    await sandbox.setOutboundOrgId(" org-a ");
    await sandbox.setOutboundOrgId("org-a");
    expect(sandbox.getOutboundConfig().orgId).toBe("org-a");
  });

  it("rejects rebinding an existing sandbox to another org", async () => {
    const { sandbox, stored } = sandboxForTest();
    await sandbox.setOutboundOrgId("org-a");
    const prior = stored.get("outbound-config-v1");
    await expect(sandbox.setOutboundOrgId("org-b")).rejects.toThrow(/different organization/);
    expect(stored.get("outbound-config-v1")).toBe(prior);
  });

  it("rejects an empty org id", async () => {
    const { sandbox } = sandboxForTest();
    await expect(sandbox.setOutboundOrgId("  ")).rejects.toThrow(/required/);
  });
  it("persists the initiator and rejects changing its credential identity", async () => {
    const { sandbox } = sandboxForTest();
    await sandbox.setOutboundInitiatorUserId(" alice ");
    await sandbox.setOutboundInitiatorUserId("alice");
    expect(sandbox.getOutboundConfig().initiatorUserId).toBe("alice");
    await expect(sandbox.setOutboundInitiatorUserId("bob")).rejects.toThrow(/different initiator/);
    expect(sandbox.getOutboundConfig().initiatorUserId).toBe("alice");
    await expect(sandbox.setOutboundInitiatorUserId(" ")).rejects.toThrow(/required/);
  });

});

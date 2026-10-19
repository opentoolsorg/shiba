import { resolveSandboxDurableObjectId } from "@shiba/shared";
import { describe, expect, it } from "vitest";

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

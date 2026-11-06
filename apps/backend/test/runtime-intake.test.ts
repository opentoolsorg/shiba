import { describe, expect, it } from "vitest";
import { LOCAL_INTAKE_DASHBOARD } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { freezeRuntimeForApproval } from "../src/runtime-intake.js";

describe("freezeRuntimeForApproval", () => {
  it("requires an explicit local selection for artifacts even on a local-default dashboard", () => {
    const input = { intake: LOCAL_INTAKE_DASHBOARD, executionTarget: { kind: "artifact-workspace" as const, expectedDeliverables: ["out/brief.md"] } };
    expect(freezeRuntimeForApproval({ RUNTIME: "local" } as Env, input)).toBe("sandbox");
    expect(freezeRuntimeForApproval({ RUNTIME: "sandbox" } as Env, { ...input, runtime: "local" })).toBe("local");
  });

  it("freezes sandbox for MCP-style intake without an explicit runtime", () => {
    expect(
      freezeRuntimeForApproval({ RUNTIME: "local" } as Env, {}),
    ).toBe("sandbox");
  });

  it("preserves explicit sandbox on non-dashboard intake", () => {
    expect(
      freezeRuntimeForApproval({ RUNTIME: "local" } as Env, { runtime: "sandbox" }),
    ).toBe("sandbox");
  });

  it("allows dashboard intake to inherit deployment local default", () => {
    expect(
      freezeRuntimeForApproval(
        { RUNTIME: "local" } as Env,
        { intake: LOCAL_INTAKE_DASHBOARD },
      ),
    ).toBe("local");
  });
});

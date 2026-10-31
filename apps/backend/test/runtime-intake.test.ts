import { describe, expect, it } from "vitest";
import { LOCAL_INTAKE_DASHBOARD } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { freezeRuntimeForApproval } from "../src/runtime-intake.js";

describe("freezeRuntimeForApproval", () => {
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

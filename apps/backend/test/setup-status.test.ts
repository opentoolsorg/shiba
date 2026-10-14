import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { readSetupStatus } from "../src/setup-status.js";

function setupStatusEnv(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "",
    CODING_MODEL: "",
    ...overrides,
  } as Env;
}

describe("readSetupStatus mailbox signals", () => {
  it("reports mailbox binding booleans without exposing the address", async () => {
    const status = await readSetupStatus(
      setupStatusEnv({ AGENT_MAILBOX: "private@example.test", SEND_EMAIL: {} as never }),
      false,
    );

    expect(status.mailbox).toEqual({ addressOverride: true, sendEnabled: true });
    expect(JSON.stringify(status)).not.toContain("private@example.test");
  });

  it("reports default address and absent sending binding honestly", async () => {
    const status = await readSetupStatus(setupStatusEnv(), false);

    expect(status.mailbox).toEqual({ addressOverride: false, sendEnabled: false });
  });
});

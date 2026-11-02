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

describe("readSetupStatus Slack configuration honesty", () => {
  it("does not mark whitespace secrets or invalid channel mappings configured", async () => {
    for (const channelRepos of [" ", "not-json", "{}", "[]", '{"C1":"not-a-repo"}', '{"":"https://github.com/o/r"}']) {
      const status = await readSetupStatus(setupStatusEnv({
        SLACK_SIGNING_SECRET: " ", SLACK_BOT_TOKEN: "\n", SLACK_APPROVERS: " , ",
        SLACK_CHANNEL_REPOS: channelRepos, AI_GATEWAY_TOKEN: " ",
      }), false);
      expect(status.slack).toEqual({ signingSecret: false, botToken: false, approvers: 0, channelRepos: false });
      expect(status.gateway.token).toBe(false);
    }
  });

  it("recognizes usable mapping configuration without returning its private values", async () => {
    const status = await readSetupStatus(setupStatusEnv({
      SLACK_SIGNING_SECRET: "private-signing-secret", SLACK_BOT_TOKEN: "private-bot-token",
      SLACK_APPROVERS: " U1, U2 ",
      SLACK_CHANNEL_REPOS: '{"C-private":"https://github.com/private-owner/private-repo"}',
    }), false);
    expect(status.slack).toEqual({ signingSecret: true, botToken: true, approvers: 2, channelRepos: true });
    for (const privateValue of ["private-signing-secret", "private-bot-token", "C-private", "private-owner"]) {
      expect(JSON.stringify(status)).not.toContain(privateValue);
    }
  });
});

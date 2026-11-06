import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  beginSlackCoworkerBinding,
  confirmSlackCoworkerBinding,
  confirmSlackCoworkerOnSlack,
  grantSlackCoworkerIntake,
  intakeSlackCoworkerEvent,
  observeSlackCoworkerChallenge,
  readSlackCoworkerDrafts,
} from "../src/slack-coworker-store.js";
import {
  installationSnapshot,
  type SlackInstallationEnv,
  type SlackInstallationRow,
} from "../src/slack-installations-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("private coworker exact-thread acceptance", () => {
  it("denies other threads, channels and users without consuming the authorized event", async () => {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');
      for (const migration of ["0018_slack_installations.sql", "0024_slack_coworker.sql"])
        sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      const member = {
        workspaceId: `ws_${"1".repeat(24)}`,
        userId: "owner@example.test",
        accountId: "native1",
        version: 1,
        role: "owner" as const,
        joinedAt: 1,
      };
      sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(member.accountId, member.userId);
      sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(member.accountId, member.userId);
      sqlite.prepare("INSERT INTO team_workspaces VALUES(?,?,?,?,?)").run("self-hosted", member.workspaceId, "Test", 1, 1);
      sqlite.prepare("INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES('self-hosted',?,?,?,'active',1,1)").run(member.workspaceId, member.userId, member.role);
      sqlite.prepare(`INSERT INTO slack_installations(id,workspace_id,owner_id,owner_account_id,owner_member_json,app_id,team_id,bot_user_id,bot_id,installer_slack_user_id,scopes_json,generation,version,token_revision,state,digest,token_cipher,activation_expires_at,created_at)
        VALUES('i1',?,?,?,?,'A1','T1','UBOT','B1','UINSTALL','["chat:write","commands","app_mentions:read"]',1,1,1,'active','digest','cipher',?,1)`)
        .run(member.workspaceId, member.userId, member.accountId, JSON.stringify(member), Date.now() + 600_000);
      const installation = installationSnapshot(sqlite.prepare("SELECT * FROM slack_installations").get() as unknown as SlackInstallationRow);
      const env = { AGENT_AUDIT: database } as SlackInstallationEnv;
      const challenge = await beginSlackCoworkerBinding(env, member, installation);
      await observeSlackCoworkerChallenge(env, installation, challenge.secret, "U1");
      expect(await confirmSlackCoworkerOnSlack(env, installation, challenge.id, "U1", true)).toBe(true);
      const binding = await confirmSlackCoworkerBinding(env, member, installation, challenge.id, "U1");
      await grantSlackCoworkerIntake(env, member, binding.id, "C1", "123.000001");
      const event = {
        user: "U1", channel: "C1", thread_ts: "123.000001",
        ts: `${Math.floor(Date.now() / 1000) + 1}.000002`, text: "Private task fixture",
      };
      for (const change of [
        { thread_ts: "123.000002" },
        { thread_ts: undefined },
        { channel: "C2" },
        { user: "U2" },
      ]) {
        expect(await intakeSlackCoworkerEvent(env, installation, "EEXACT", { ...event, ...change })).toBe(false);
        expect(await readSlackCoworkerDrafts(env, member)).toEqual([]);
      }
      expect(await intakeSlackCoworkerEvent(env, installation, "EEXACT", event)).toBe(true);
      expect(await readSlackCoworkerDrafts(env, member)).toEqual([
        expect.objectContaining({ channelId: "C1", threadTs: "123.000001", slackUserId: "U1", text: event.text }),
      ]);
      expect(await intakeSlackCoworkerEvent(env, installation, "EEXACT", event)).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

import type { ConnectedComputer } from "@shiba/shared";
import type { PersonalExecutionGrant } from "./personal-execution-client";

export const PERSONAL_WORKSPACE = "ws_" + "a".repeat(24);
export const PERSONAL_ACTOR = "member@example.test";
export function personalFixture(now = Date.now()): { computer: ConnectedComputer; grant: PersonalExecutionGrant } {
  const scope = { version: 2 as const, ownerAccountId: "fixture-owner", actorId: PERSONAL_ACTOR, workspaceId: PERSONAL_WORKSPACE,
    membershipVersion: 2, membershipRole: "member" as const, origin: "https://shiba.example" };
  const account = { schemaVersion: 1 as const, harness: "codex" as const, billingMode: "native-subscription" as const,
    accountFingerprint: "a".repeat(64), authVersion: "b".repeat(64), cliVersion: "0.157.1", probeMethod: "codex-account-read" as const,
    probedAt: now, receivedAt: now };
  return {
    computer: { machineId: "machine-personal", hostname: "My computer", platform: "linux-x64", daemonVersion: "1",
      harnesses: ["codex"], status: "idle", lastHeartbeat: now,
      personalExecution: { version: 1, revision: 3, scope, accounts: [account] } },
    grant: { status: "active", version: 1, snapshot: { version: 1, grantId: "plex_" + "c".repeat(32), grantVersion: 1,
      ownerAccountId: scope.ownerAccountId, actorId: PERSONAL_ACTOR, workspaceId: PERSONAL_WORKSPACE, membershipVersion: 2,
      machineId: "machine-personal", machineRevision: 3, harness: "codex", billingMode: "native-subscription",
      accountFingerprint: account.accountFingerprint, authVersion: account.authVersion, codingModel: "openai/fixture-model",
      repoUrl: "https://github.com/owner/public-repo", expiresAt: now + 3_600_000, allowedPhases: ["local_repository_task"] } },
  };
}

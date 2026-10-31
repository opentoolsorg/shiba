import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDecisionData } from "@shiba/shared";
import type { OrchestratorStub } from "../src/chat-lane.js";
import {
  clearBotFrameworkConnectorTokenCache,
  verifyTeamsBearerToken,
} from "../src/teams-auth.js";
import {
  TEAMS_WEBHOOK_PATH,
  handleTeamsWebhook,
  type TeamsDeps,
} from "../src/teams.js";

const REPO = "https://github.com/owner/repo";
const APPROVAL_ID = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
const APP_ID = "11122233-4444-5555-6666-777788889999";
const SERVICE_URL = "https://smba.example.com/";
const CONVERSATION_ID = "19:channel@thread.tacv2";

type SendCall = {
  serviceUrl: string;
  conversationId: string;
  activity: Record<string, unknown>;
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    TEAMS_MICROSOFT_APP_ID: APP_ID,
    TEAMS_MICROSOFT_APP_PASSWORD: "app-password",
    ...overrides,
  } as never;
}

async function makeJwt(input: {
  appId?: string;
  serviceUrl?: string;
  iss?: string;
} = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  const token = await new SignJWT({ serviceurl: input.serviceUrl ?? SERVICE_URL })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(input.iss ?? "https://api.botframework.com")
    .setAudience(input.appId ?? APP_ID)
    .setExpirationTime("2h")
    .sign(privateKey);
  return {
    token,
    verify: (authorization: string | null, serviceUrl: string) =>
      verifyTeamsBearerToken({
        authorization,
        appId: APP_ID,
        serviceUrl,
        jwks,
      }),
  };
}

function activityRequest(
  activity: Record<string, unknown>,
  auth: { authorization?: string; verifyAuth?: TeamsDeps["verifyAuth"] },
) {
  return new Request(`https://worker.test${TEAMS_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth.authorization ? { Authorization: auth.authorization } : {}),
    },
    body: JSON.stringify(activity),
  });
}

function messageActivity(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "act-message-1",
    serviceUrl: SERVICE_URL,
    text,
    from: { id: "29:user", aadObjectId: "aad-alice", name: "Alice" },
    recipient: { id: "28:bot" },
    conversation: { id: CONVERSATION_ID, conversationType: "channel" },
    entities: [
      { type: "mention", text: "<at>Shiba</at>", mentioned: { id: "28:bot" } },
    ],
    ...overrides,
  };
}

function invokeActivity(customId: string, userId = "aad-alice") {
  return {
    type: "invoke",
    id: "act-invoke-1",
    name: "adaptiveCard/action",
    serviceUrl: SERVICE_URL,
    from: { id: "29:user", aadObjectId: userId, name: "Alice" },
    recipient: { id: "28:bot" },
    conversation: { id: CONVERSATION_ID, conversationType: "channel" },
    value: {
      action: { type: "Action.Submit", data: { shiba: customId } },
      messageId: "card-1",
    },
  };
}

function makeDeps(overrides: Partial<TeamsDeps> = {}) {
  const sends: SendCall[] = [];
  const updates: Array<{ activityId: string; activity: Record<string, unknown> }> = [];
  const sendActivity = vi.fn(async (input: SendCall) => {
    sends.push(input);
  });
  const updateActivity = vi.fn(async (input: { activityId: string; activity: Record<string, unknown> }) => {
    updates.push(input);
  });
  const runBodies: Record<string, unknown>[] = [];
  const approvalBodies: Record<string, unknown>[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      const url = request.url;
      const body = (await request.json()) as Record<string, unknown>;
      if (url.endsWith("/api/runs")) {
        runBodies.push(body);
        return Response.json({ ok: true, approvalId: APPROVAL_ID });
      }
      approvalBodies.push(body);
      return Response.json({ result: (body.approved as boolean) ? "approved" : "rejected" });
    },
  };
  const resolveOrchestrator = vi.fn(async () => stub);
  return {
    sends,
    updates,
    runBodies,
    approvalBodies,
    resolveOrchestrator,
    deps: {
      sendActivity,
      updateActivity,
      resolveOrchestrator,
      connectorToken: async () => "connector-token",
      ...overrides,
    } satisfies TeamsDeps,
  };
}

function webhookDeps(overrides: Partial<TeamsDeps> = {}) {
  const verifyAuth = vi.fn(async () => true);
  const built = makeDeps(overrides);
  return {
    ...built,
    verifyAuth,
    deps: { ...built.deps, verifyAuth, ...overrides } satisfies TeamsDeps,
  };
}

describe("verifyTeamsBearerToken", () => {
  beforeEach(() => {
    clearBotFrameworkConnectorTokenCache();
  });

  it("accepts a valid Bot Framework JWT for the activity serviceUrl", async () => {
    const { token, verify } = await makeJwt();
    await expect(verify(`Bearer ${token}`, SERVICE_URL)).resolves.toBe(true);
  });

  it("rejects a mismatched serviceUrl claim", async () => {
    const { token, verify } = await makeJwt({ serviceUrl: "https://other.example/" });
    await expect(verify(`Bearer ${token}`, SERVICE_URL)).resolves.toBe(false);
  });

  it("rejects a missing Authorization header", async () => {
    const { verify } = await makeJwt();
    await expect(verify(null, SERVICE_URL)).resolves.toBe(false);
  });
});

describe("handleTeamsWebhook", () => {
  beforeEach(() => {
    clearBotFrameworkConnectorTokenCache();
  });

  it("returns null for unrelated paths", async () => {
    const request = new Request("https://worker.test/api/other", { method: "POST", body: "{}" });
    await expect(handleTeamsWebhook(request, env())).resolves.toBeNull();
  });

  it("returns 503 when Teams credentials are unset", async () => {
    const request = activityRequest(messageActivity("hi"), {});
    const response = await handleTeamsWebhook(request, env({ TEAMS_MICROSOFT_APP_ID: "", TEAMS_MICROSOFT_APP_PASSWORD: "" }));
    expect(response?.status).toBe(503);
  });

  it("returns 401 when JWT verification fails", async () => {
    const request = activityRequest(messageActivity("/shiba x"), { authorization: "Bearer bad" });
    const response = await handleTeamsWebhook(request, env(), undefined, {
      verifyAuth: vi.fn(async () => false),
    });
    expect(response?.status).toBe(401);
  });

  it("dedupes on activity id", async () => {
    const dedupe = vi.fn(async () => true);
    const { deps } = webhookDeps({ dedupe });
    const request = activityRequest(messageActivity("/shiba x"), {});
    const first = await handleTeamsWebhook(request, env(), undefined, deps);
    expect(first?.status).toBe(200);
    expect(dedupe).toHaveBeenCalledWith("act-message-1");
    expect(deps.sendActivity).not.toHaveBeenCalled();
  });

  it("queues a run from a @mention message and posts an approval card", async () => {
    const { deps, sends, runBodies, resolveOrchestrator } = webhookDeps();
    const request = activityRequest(messageActivity(`${REPO} fix login`), {});
    const response = await handleTeamsWebhook(request, env(), undefined, deps);
    expect(response?.status).toBe(200);
    expect(resolveOrchestrator).toHaveBeenCalledWith(`teams:${CONVERSATION_ID}`);
    expect(runBodies[0]).toMatchObject({
      repoUrl: REPO,
      task: "fix login",
      threadKey: `teams:${CONVERSATION_ID}`,
      source: "teams",
    });
    expect(sends[0]?.activity.attachments).toBeDefined();
  });

  it("refuses approval invoke when TEAMS_APPROVERS is empty", async () => {
    const { deps } = webhookDeps();
    const request = activityRequest(invokeActivity(buildDecisionData(true, APPROVAL_ID)), {});
    const response = await handleTeamsWebhook(request, env({ TEAMS_APPROVERS: "" }), undefined, deps);
    const body = (await response?.json()) as { value?: string };
    expect(body.value).toMatch(/not on the approver list/i);
    expect(deps.updateActivity).not.toHaveBeenCalled();
  });

  it("records approval when the user is allowlisted", async () => {
    const { deps, approvalBodies, updates } = webhookDeps();
    const request = activityRequest(invokeActivity(buildDecisionData(true, APPROVAL_ID)), {});
    const response = await handleTeamsWebhook(
      request,
      env({ TEAMS_APPROVERS: "aad-alice" }),
      undefined,
      deps,
    );
    const body = (await response?.json()) as { value?: string };
    expect(body.value).toMatch(/Approved/);
    expect(approvalBodies[0]).toMatchObject({
      approvalId: APPROVAL_ID,
      approved: true,
      decidedBy: "teams:aad-alice",
      source: "teams",
    });
    expect(updates[0]?.activityId).toBe("card-1");
  });
});

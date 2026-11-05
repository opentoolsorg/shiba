import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackAgentSessionOutbox, type SlackAgentSessionIntent, type SlackAgentSessionStorage } from "../src/slack-agent-sessions.js";
import { resolveSlackCanvasBinding } from "../src/slack-canvas.js";

const ORIGIN = "slack:T1:C1:1700.0001";
const SCOPES = "chat:write,assistant:write,chat:write.customize";
const owners = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: "owner@example.com" }]);
function env() {
  return { SLACK_AGENT_SESSIONS_ENABLED: "true", SLACK_AGENT_SESSIONS_TEAM_ID: "T1", SLACK_BOT_TOKEN: "xoxb-fixture-only", SLACK_CANVAS_OWNERS: owners };
}
function storage(): SlackAgentSessionStorage {
  const values = new Map<string, unknown>();
  let pending: Promise<unknown> = Promise.resolve();
  return { transaction: (callback) => {
    const operation = pending.then(() => callback({
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    }));
    pending = operation.catch(() => {});
    return operation;
  } };
}
async function intent(revision = 1, status: SlackAgentSessionIntent["status"] = "processing"): Promise<SlackAgentSessionIntent> {
  const binding = await resolveSlackCanvasBinding(env(), ORIGIN, "approval-1");
  return { origin: ORIGIN, approvalId: "approval-1", binding: binding!, revision, status, persona: "fixer" };
}
/** All HTTP requests in this suite are fixtures. No installed Slack app is contacted. */
function slackFixture(options: { team?: string; scopes?: string | null; statusResponse?: () => Response | Promise<Response>; authResponse?: () => Response | Promise<Response> } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://slack.com/api/auth.test") {
      return options.authResponse?.() ?? Response.json({ ok: true, team_id: options.team ?? "T1", user_id: "U1", bot_id: "B1" }, {
        headers: options.scopes === null ? {} : { "x-oauth-scopes": options.scopes ?? SCOPES },
      });
    }
    expect(url).toBe("https://slack.com/api/agents.sessions.setStatus");
    const requested = new URLSearchParams(init?.body as URLSearchParams).get("status");
    return options.statusResponse?.() ?? Response.json({ ok: true, status: requested, agent_status: requested });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, writes: () => calls.filter((call) => call.url.endsWith("setStatus")) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("optional Slack native session outbox with fixture HTTP", () => {
  it("stays dark by default and accepts only the exact opt-in", async () => {
    for (const enabled of [undefined, "false", "1", "TRUE", " true "]) {
      const fixture = slackFixture();
      const outbox = new SlackAgentSessionOutbox(storage(), { ...env(), SLACK_AGENT_SESSIONS_ENABLED: enabled });
      expect(await outbox.enqueue(await intent())).toBeNull();
      expect(await outbox.drain()).toBeNull();
      expect(fixture.calls).toHaveLength(0);
    }
  });

  it("persists the intent before delivery and replays an unclaimed intent once after object replacement", async () => {
    const saved = storage();
    const first = new SlackAgentSessionOutbox(saved, env());
    const desired = await intent();
    expect(await first.enqueue(desired)).toMatchObject({ state: "pending", revision: 1 });
    const fixture = slackFixture({ authResponse: async () => {
      expect(await first.inspect()).toMatchObject({ state: "sending", revision: 1 });
      return Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": SCOPES } });
    } });
    const restarted = new SlackAgentSessionOutbox(saved, env());
    expect(await restarted.drain()).toMatchObject({ state: "sent", agentStatus: "processing", sessionStatus: "processing" });
    const write = fixture.writes()[0]!;
    expect(new URLSearchParams(write.init?.body as URLSearchParams)).toEqual(new URLSearchParams({
      channel_id: "C1", thread_ts: "1700.0001", status: "processing", username: "Shiba Fixer", icon_emoji: ":hammer_and_wrench:",
    }));
    expect(write.init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" });
    await restarted.enqueue(desired);
    await new SlackAgentSessionOutbox(saved, env()).drain();
    expect(fixture.writes()).toHaveLength(1);
  });

  it("makes no network call when saving the durable intent fails", async () => {
    const fixture = slackFixture();
    const outbox = new SlackAgentSessionOutbox({ transaction: async () => { throw new Error("Injected persistence failure"); } }, env());
    await expect(outbox.enqueue(await intent())).rejects.toThrow("Injected persistence failure");
    expect(fixture.calls).toHaveLength(0);
  });

  it("refuses forged owner, run, session, origin and configured team before auth.test", async () => {
    const desired = await intent();
    const variants = [
      { ...desired, binding: { ...desired.binding, ownerId: "other@example.com" } },
      { ...desired, binding: { ...desired.binding, runId: "agent-tool:other" } },
      { ...desired, binding: { ...desired.binding, sessionId: crypto.randomUUID() } },
      { ...desired, origin: "slack:T1:C2:1700.0001" },
      { ...desired, origin: "slack-command:T1:C1" },
    ];
    for (const changed of variants) {
      const fixture = slackFixture();
      expect(await new SlackAgentSessionOutbox(storage(), env()).enqueue(changed)).toMatchObject({ state: "blocked", errorCode: "destination_not_authorized" });
      expect(fixture.calls).toHaveLength(0);
    }
    const fixture = slackFixture();
    expect(await new SlackAgentSessionOutbox(storage(), { ...env(), SLACK_AGENT_SESSIONS_TEAM_ID: "T2" }).enqueue(desired)).toMatchObject({ state: "blocked" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("rechecks revocation after enqueue and before network", async () => {
    const configured = env();
    const outbox = new SlackAgentSessionOutbox(storage(), configured);
    await outbox.enqueue(await intent());
    configured.SLACK_CANVAS_OWNERS = "[]";
    const fixture = slackFixture();
    expect(await outbox.drain()).toMatchObject({ state: "blocked", errorCode: "destination_not_authorized" });
    expect(fixture.calls).toHaveLength(0);
  });

  it.each(["owner policy", "retained source"])("rechecks %s revocation during auth.test before setStatus", async (scope) => {
    const configured = env();
    let allowed = true;
    const outbox = new SlackAgentSessionOutbox(storage(), configured, () => allowed);
    await outbox.enqueue(await intent());
    const fixture = slackFixture({ authResponse: () => {
      if (scope === "owner policy") configured.SLACK_CANVAS_OWNERS = "[]";
      else allowed = false;
      return Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": SCOPES } });
    } });
    expect(await outbox.drain()).toMatchObject({ state: "blocked", errorCode: "destination_not_authorized" });
    expect(fixture.writes()).toHaveLength(0);
  });

  it.each([
    { options: { team: "T2" }, errorCode: "bot_workspace_mismatch" },
    { options: { scopes: "chat:write,chat:write.customize" }, errorCode: "agent_scopes_missing" },
    { options: { scopes: "assistant:write,chat:write.customize" }, errorCode: "agent_scopes_missing" },
    { options: { scopes: null }, errorCode: "scope_verification_unavailable" },
  ])("does not claim readiness or send with unavailable installation: $errorCode", async ({ options, errorCode }) => {
    const fixture = slackFixture(options);
    const outbox = new SlackAgentSessionOutbox(storage(), env());
    await outbox.enqueue(await intent());
    expect(await outbox.drain()).toMatchObject({ state: "blocked", errorCode });
    expect(fixture.writes()).toHaveLength(0);
  });

  it("retains a feature-disabled error when agent_view is not available", async () => {
    const fixture = slackFixture({ statusResponse: () => Response.json({ ok: false, error: "feature_disabled" }) });
    const outbox = new SlackAgentSessionOutbox(storage(), env());
    await outbox.enqueue(await intent());
    expect(await outbox.drain()).toMatchObject({ state: "blocked", errorCode: "feature_disabled" });
    await outbox.drain();
    expect(fixture.writes()).toHaveLength(1);
  });

  it.each([
    { label: "transport failure", response: async (): Promise<Response> => { throw new Error("Timeout fixture"); } },
    { label: "unreadable response", response: () => new Response("not json") },
    { label: "partial receipt", response: () => Response.json({ ok: true }) },
    { label: "fatal partial effect", response: () => Response.json({ ok: false, error: "fatal_error" }) },
    { label: "server failure", response: () => Response.json({ ok: false, error: "server_error" }, { status: 503 }) },
  ])("does not blindly retry an unknown $label", async ({ response }) => {
    const saved = storage();
    const fixture = slackFixture({ statusResponse: response });
    const outbox = new SlackAgentSessionOutbox(saved, env());
    await outbox.enqueue(await intent());
    expect(await outbox.drain()).toMatchObject({ state: "unknown" });
    expect(await new SlackAgentSessionOutbox(saved, env()).drain()).toMatchObject({ state: "unknown" });
    expect(fixture.writes()).toHaveLength(1);
  });

  it("records the calling agent status separately from a busier multi-agent session", async () => {
    slackFixture({ statusResponse: () => Response.json({ ok: true, agent_status: "active", status: "processing" }) });
    const outbox = new SlackAgentSessionOutbox(storage(), env());
    await outbox.enqueue(await intent(1, "active"));
    expect(await outbox.drain()).toMatchObject({ state: "sent", agentStatus: "active", sessionStatus: "processing" });
  });

  it("supersedes older revisions and refuses a conflicting same-revision write", async () => {
    const fixture = slackFixture();
    const outbox = new SlackAgentSessionOutbox(storage(), env());
    await outbox.enqueue(await intent(2, "active"));
    expect(await outbox.enqueue(await intent(1))).toMatchObject({ revision: 2 });
    await expect(outbox.enqueue(await intent(2, "processing"))).rejects.toThrow("conflicts");
    await outbox.drain();
    expect(new URLSearchParams(fixture.writes()[0]?.init?.body as URLSearchParams).get("status")).toBe("active");
  });

  it("coalesces unchanged lifecycle state without retrying unknown writes as unrelated event revisions advance", async () => {
    const fixture = slackFixture({ statusResponse: async () => { throw new Error("Unknown delivery fixture"); } });
    const outbox = new SlackAgentSessionOutbox(storage(), env());
    await outbox.enqueue(await intent());
    await outbox.drain();
    await outbox.enqueue(await intent(3));
    expect(await outbox.drain()).toMatchObject({ state: "unknown", revision: 1 });
    await outbox.enqueue(await intent(2, "active"));
    expect(await outbox.drain()).toMatchObject({ state: "unknown", revision: 1 });
    expect(fixture.writes()).toHaveLength(1);
  });

  it("does not repeat a successful Slack write when saving its receipt failed", async () => {
    const saved = storage();
    const failing: SlackAgentSessionStorage = { transaction: (callback) => saved.transaction((transaction) => callback({
      get: transaction.get,
      put: async (key, value) => {
        if ((value as { delivery?: { state?: string } }).delivery?.state === "sent") throw new Error("Injected receipt persistence failure");
        await transaction.put(key, value);
      },
    })) };
    const fixture = slackFixture();
    const outbox = new SlackAgentSessionOutbox(failing, env());
    await outbox.enqueue(await intent());
    await expect(outbox.drain(1000)).rejects.toThrow("Injected receipt persistence failure");
    expect(await new SlackAgentSessionOutbox(saved, env()).drain(40_000)).toMatchObject({ state: "unknown", errorCode: "delivery_receipt_missing" });
    expect(fixture.writes()).toHaveLength(1);
  });

  it("sends only the newest desired status if it changes during installation verification", async () => {
    let releaseAuth!: (value: Response) => void;
    const authResponse = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseAuth = resolve; }))
      .mockImplementation(() => Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": SCOPES } }));
    const fixture = slackFixture({ authResponse });
    const saved = storage();
    const outbox = new SlackAgentSessionOutbox(saved, env());
    await outbox.enqueue(await intent());
    const draining = outbox.drain(1000);
    await vi.waitFor(() => expect(authResponse).toHaveBeenCalledOnce());
    await outbox.enqueue(await intent(2, "active"));
    await new SlackAgentSessionOutbox(saved, env()).drain(1001);
    releaseAuth(Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": SCOPES } }));
    expect(await draining).toMatchObject({ state: "sent", revision: 2, agentStatus: "active" });
    expect(fixture.writes()).toHaveLength(1);
  });

  it("retains an abandoned claim as unknown after eviction and accepts a newer terminal intent", async () => {
    const saved = storage();
    const outbox = new SlackAgentSessionOutbox(saved, env());
    const desired = await intent();
    await outbox.enqueue(desired);
    await saved.transaction(async (transaction) => {
      const state = await transaction.get<Record<string, unknown>>("slack:agent-session-outbox:v1");
      await transaction.put("slack:agent-session-outbox:v1", { ...state, delivery: { revision: 1, state: "sending", attempts: 1, startedAt: 1000, claimId: "lost-parent" } });
    });
    const fixture = slackFixture();
    expect(await new SlackAgentSessionOutbox(saved, env()).drain(40_000)).toMatchObject({ state: "unknown", errorCode: "delivery_receipt_missing" });
    expect(fixture.calls).toHaveLength(0);
    await outbox.enqueue(await intent(2, "active"));
    expect(await outbox.drain()).toMatchObject({ state: "sent", revision: 2 });
  });

  it("refreshes claim time for later drain passes after an awaited installation check", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const outbox = new SlackAgentSessionOutbox(storage(), env());
    await outbox.enqueue(await intent());
    let checks = 0;
    slackFixture({ authResponse: async () => {
      if (++checks === 1) {
        clock.mockReturnValue(20_000);
        await outbox.enqueue(await intent(2, "active"));
      }
      return Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": SCOPES } });
    } });
    expect(await outbox.drain()).toMatchObject({ state: "sent", revision: 2, startedAt: 20_000 });
  });
});

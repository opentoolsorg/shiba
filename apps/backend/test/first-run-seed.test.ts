import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCustomAgent,
  getCustomAgentBySlug,
  listCustomAgents,
  setCustomAgentArchived,
  updateCustomAgent,
} from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";
import {
  ensureFirstRunSeed,
  handleFirstRunSeed,
  seedWorkspaceName,
} from "../src/first-run-seed.js";
import {
  acceptTeamWorkspaceInvitation,
  createTeamWorkspace,
  createTeamWorkspaceInvitation,
  listTeamWorkspaces,
} from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({
  userId: "alice@example.test" as string | null,
  authorized: true,
  restricted: false,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: vi.fn(async () => auth.authorized),
  resolveUserId: vi.fn(async () => auth.userId),
}));
vi.mock("../src/team-member-auth.js", () => ({
  isRestrictedTeamMember: vi.fn(async () => auth.restricted),
}));

const alice = "alice@example.test",
  bob = "bob@example.test";
const STARTERS = ["chief-of-staff", "coding-coworker", "pr-reviewer", "standup-summarizer"];
const env = () => ({ AGENT_AUDIT: customAgentD1().database }) as unknown as Env;
const slugs = async (e: Env, workspaceId: string | null) =>
  (await listCustomAgents(e, `team:${workspaceId}`)).map((a) => a.slug).sort();
async function agent(e: Env, org: string, slug: string) {
  const found = await getCustomAgentBySlug(e, org, slug);
  if (!found) throw new Error(`Missing ${slug}`);
  return found;
}
const post = (headers: Record<string, string> = {}) =>
  new Request("https://worker.test/api/first-run-seed", {
    method: "POST",
    headers: { origin: "https://worker.test", "content-type": "application/json", ...headers },
  });
beforeEach(() => {
  auth.userId = alice;
  auth.authorized = true;
  auth.restricted = false;
});

describe("ensureFirstRunSeed", () => {
  it("creates the user's workspace and the starter roster on a fresh account", async () => {
    const e = env();
    const result = await ensureFirstRunSeed(e, alice);
    expect(result.createdWorkspace).toBe(true);
    expect(result.createdAgents).toEqual(STARTERS);
    const workspaces = await listTeamWorkspaces(e, alice);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      workspaceId: result.workspaceId,
      name: "alice's workspace",
      membership: { role: "owner" },
    });
    expect(await slugs(e, result.workspaceId)).toEqual([...STARTERS].sort());
    expect(
      (await getCustomAgentBySlug(e, `team:${result.workspaceId}`, "chief-of-staff"))?.config,
    ).toMatchObject({ name: "Shiba", harness: "opencode" });
    expect(
      (await getCustomAgentBySlug(e, `team:${result.workspaceId}`, "pr-reviewer"))?.config.name,
    ).toBe("PR Reviewer");
  });

  it("is idempotent: repeated calls create no duplicates", async () => {
    const e = env();
    const first = await ensureFirstRunSeed(e, alice);
    const second = await ensureFirstRunSeed(e, alice);
    const third = await ensureFirstRunSeed(e, " Alice@Example.Test ");
    expect(second).toEqual({
      workspaceId: first.workspaceId,
      createdWorkspace: false,
      createdAgents: [],
    });
    expect(third).toEqual(second);
    expect(await listTeamWorkspaces(e, alice)).toHaveLength(1);
    expect(await listCustomAgents(e, `team:${first.workspaceId}`)).toHaveLength(4);
  });

  it("never overwrites edits and never recreates archived or deleted starters", async () => {
    const e = env();
    const { workspaceId } = await ensureFirstRunSeed(e, alice);
    const org = `team:${workspaceId}`;
    const reviewer = await agent(e, org, "pr-reviewer");
    await updateCustomAgent(e, org, reviewer.id, { ...reviewer.config, name: "My Reviewer" });
    await setCustomAgentArchived(e, org, (await agent(e, org, "coding-coworker")).id, true);
    await deleteCustomAgent(e, org, (await agent(e, org, "standup-summarizer")).id);
    const again = await ensureFirstRunSeed(e, alice);
    expect(again.createdAgents).toEqual([]);
    expect((await getCustomAgentBySlug(e, org, "pr-reviewer"))?.config.name).toBe("My Reviewer");
    expect(await slugs(e, workspaceId)).toEqual(["chief-of-staff", "pr-reviewer"]);
  });

  it("finishes a partial seed in the seed workspace", async () => {
    const e = env();
    const ws = await createTeamWorkspace(e, alice, { name: seedWorkspaceName(alice) });
    const result = await ensureFirstRunSeed(e, alice);
    expect(result).toEqual({
      workspaceId: ws.workspaceId,
      createdWorkspace: false,
      createdAgents: STARTERS,
    });
  });

  it("leaves accounts that already have their own or invited workspaces untouched", async () => {
    const e = env();
    const product = await createTeamWorkspace(e, alice, { name: "Product" });
    expect(await ensureFirstRunSeed(e, alice)).toEqual({
      workspaceId: null,
      createdWorkspace: false,
      createdAgents: [],
    });
    expect(await listCustomAgents(e, `team:${product.workspaceId}`)).toEqual([]);
    const invite = await createTeamWorkspaceInvitation(e, product.workspaceId, alice, {
      email: bob,
      role: "member",
    });
    await acceptTeamWorkspaceInvitation(e, bob, invite.token);
    expect(await ensureFirstRunSeed(e, bob)).toMatchObject({
      workspaceId: null,
      createdWorkspace: false,
    });
    expect(await listTeamWorkspaces(e, bob)).toHaveLength(1);
  });

  it("rejects non-email identities", async () => {
    await expect(ensureFirstRunSeed(env(), "service-bot")).rejects.toThrow(
      "A valid email is required.",
    );
  });
});

describe("handleFirstRunSeed", () => {
  it("ignores other paths and only accepts POST", async () => {
    const e = env();
    expect(
      await handleFirstRunSeed(new Request("https://worker.test/api/workspaces"), e),
    ).toBeNull();
    expect(
      (await handleFirstRunSeed(new Request("https://worker.test/api/first-run-seed"), e))?.status,
    ).toBe(405);
  });

  it("seeds for a signed-in human and is idempotent over HTTP", async () => {
    const e = env();
    const first = await handleFirstRunSeed(post(), e);
    expect(first?.status).toBe(200);
    expect(await first?.json()).toMatchObject({ createdWorkspace: true, createdAgents: STARTERS });
    expect(await (await handleFirstRunSeed(post(), e))?.json()).toMatchObject({
      createdWorkspace: false,
      createdAgents: [],
    });
  });

  it("denies unauthenticated, bearer, cross-origin, non-email, and invited callers without writing", async () => {
    const e = { ...env(), BETTER_AUTH_SECRET: "secret" } as Env;
    auth.authorized = false;
    expect((await handleFirstRunSeed(post(), e))?.status).toBe(401);
    auth.authorized = true;
    expect((await handleFirstRunSeed(post({ authorization: "Bearer x" }), e))?.status).toBe(401);
    expect((await handleFirstRunSeed(post({ origin: "https://evil.test" }), e))?.status).toBe(403);
    auth.userId = "not-an-email";
    expect((await handleFirstRunSeed(post(), e))?.status).toBe(403);
    auth.userId = alice;
    auth.restricted = true;
    expect((await handleFirstRunSeed(post(), e))?.status).toBe(403);
    expect(await listTeamWorkspaces(e, alice)).toEqual([]);
  });
});

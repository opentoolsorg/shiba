import { AGENT_TEMPLATES, type CustomAgentConfig } from "@shiba/shared";
import { createCustomAgent } from "./custom-agents-store.js";
import { recordEmployeeBundleProfileOwner } from "./employee-bundles-store.js";
import type { Env } from "./env.js";
import {
  isAuthorizedRequest,
  requireSameOriginBrowserMutation,
  resolveUserId,
} from "./request-auth.js";
import { isRestrictedTeamMember } from "./team-member-auth.js";
import {
  createTeamWorkspace,
  listTeamWorkspaces,
  normalizeTeamWorkspaceEmail,
  TeamWorkspaceError,
} from "./team-workspaces-store.js";

export const FIRST_RUN_SEED_PATH = "/api/first-run-seed";
export const STARTER_TEMPLATE_IDS = [
  "coding-coworker",
  "pr-reviewer",
  "standup-summarizer",
] as const;

export interface FirstRunSeedResult {
  workspaceId: string | null;
  createdWorkspace: boolean;
  createdAgents: string[];
}

function templateById(id: string) {
  const found = AGENT_TEMPLATES.find((template) => template.id === id);
  if (!found) throw new Error(`Starter template ${id} is missing.`);
  return found;
}
const roster = templateById("roster-manager");
const CHIEF_OF_STAFF: { slug: string; config: CustomAgentConfig } = {
  slug: "chief-of-staff",
  config: {
    name: "Shiba",
    emoji: "🐕",
    roleTemplateId: "operations",
    harness: "opencode",
    instructions: `You are this workspace's chief of staff. Route incoming requests to the right teammate, keep the work board current, and summarize progress and blockers.\n\n${roster.instructions}`,
  },
};

function starterRoster(): { slug: string; config: CustomAgentConfig }[] {
  return [
    CHIEF_OF_STAFF,
    ...STARTER_TEMPLATE_IDS.map((id) => {
      const template = templateById(id);
      return {
        slug: template.id,
        config: {
          name: template.name,
          instructions: template.instructions,
          harness: template.harness ?? "opencode",
          ...(template.appearance ? { emoji: template.appearance } : {}),
          ...(template.roleTemplateId ? { roleTemplateId: template.roleTemplateId } : {}),
        },
      };
    }),
  ];
}

export function seedWorkspaceName(user: string): string {
  return `${user.split("@")[0]}'s workspace`;
}

/**
 * Creates "<user>'s workspace" and a starter roster only for an account with no workspaces.
 * Re-runs fill missing starters in that seed workspace only; existing, archived, or deleted slugs are never recreated.
 */
export async function ensureFirstRunSeed(
  env: Pick<Env, "AGENT_AUDIT">,
  actorId: string,
): Promise<FirstRunSeedResult> {
  const user = normalizeTeamWorkspaceEmail(actorId);
  const name = seedWorkspaceName(user);
  const existing = await listTeamWorkspaces(env, user);
  let workspaceId: string;
  let createdWorkspace = false;
  if (existing.length === 0) {
    workspaceId = (await createTeamWorkspace(env, user, { name })).workspaceId;
    createdWorkspace = true;
  } else {
    const seeded = existing.find((item) => item.name === name && item.membership.role === "owner");
    if (!seeded) return { workspaceId: null, createdWorkspace: false, createdAgents: [] };
    workspaceId = seeded.workspaceId;
  }
  const orgId = `team:${workspaceId}`;
  const createdAgents: string[] = [];
  for (const { slug, config } of starterRoster()) {
    try {
      const agent = await createCustomAgent(env, orgId, slug, config);
      await recordEmployeeBundleProfileOwner(env, orgId, agent.id, user);
      createdAgents.push(slug);
    } catch (error) {
      // Slug unique index also covers archived/deleted rows, so a removed starter stays removed.
      if (
        !/already exists|UNIQUE constraint/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
    }
  }
  return { workspaceId, createdWorkspace, createdAgents };
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** POST only, human dashboard session only; invited (restricted) members are never seeded. */
export async function handleFirstRunSeed(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== FIRST_RUN_SEED_PATH) return null;
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (request.headers.has("authorization") || !(await isAuthorizedRequest(request, env)))
    return json({ error: "Authenticated human session required." }, 401);
  const originError = requireSameOriginBrowserMutation(request);
  if (originError) return originError;
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authenticated human session required." }, 401);
  let user: string;
  try {
    user = normalizeTeamWorkspaceEmail(identity);
  } catch {
    return json({ error: "Authenticated email identity required." }, 403);
  }
  if (env.BETTER_AUTH_SECRET && (await isRestrictedTeamMember(request, env)))
    return json({ error: "First-run setup is not available for invited members." }, 403);
  try {
    return json(await ensureFirstRunSeed(env, user));
  } catch (error) {
    if (error instanceof TeamWorkspaceError) return json({ error: error.message }, error.status);
    return json({ error: "First-run setup failed." }, 500);
  }
}

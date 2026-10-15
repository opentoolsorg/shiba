import {
  laneForRun,
  normalizeSwarmWebhook,
  parseSwarmIntake,
  redactShareView,
  signShareToken,
  verifyShareToken,
} from "@shiba/shared";
import type { SwarmRunInput } from "@shiba/shared";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";

export interface SwarmRouteDeps {
  isAuthorized?: (request: Request, env: Env) => Promise<boolean>;
  loadRun?: (
    env: Env,
    scope: { userId: string; sessionId?: string; runId: string },
  ) => Promise<Record<string, unknown> | null>;
  nowSeconds?: () => number;
}

async function noRun(): Promise<Record<string, unknown> | null> {
  return null;
}

export async function handleSwarm(request: Request, env: Env, deps: SwarmRouteDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const isShareMint = url.pathname === "/api/swarm/share";
  const isIntake = url.pathname === "/api/swarm/intake";
  const shareMatch = url.pathname.match(/^\/api\/swarm\/share\/([^/]+)$/);
  if (!isShareMint && !isIntake && !shareMatch) {
    return null;
  }

  if (shareMatch && request.method === "GET") {
    const secret = (env as { SWARM_SHARE_SECRET?: string }).SWARM_SHARE_SECRET;
    const claims = secret ? await verifyShareToken(secret, shareMatch[1] ?? "", (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()) : null;
    if (!claims) {
      return Response.json({ error: "Share link is not valid." }, { status: 404 });
    }
    const run = await (deps.loadRun ?? noRun)(env, {
      userId: claims.userId,
      ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
      runId: claims.runId,
    });
    if (!run) {
      return Response.json({ error: "Share link is not valid." }, { status: 404 });
    }
    return Response.json(redactShareView(run, laneForRun(run as Pick<SwarmRunInput, "status" | "pullUrl">)));
  }

  if (shareMatch) {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if (!(await (deps.isAuthorized ?? isAuthorizedRequest)(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (isShareMint) {
    const input = body as { runId?: unknown; sessionId?: unknown };
    const secret = (env as { SWARM_SHARE_SECRET?: string }).SWARM_SHARE_SECRET;
    if (typeof secret !== "string" || !secret.trim()) {
      return Response.json({ error: "Set SWARM_SHARE_SECRET to mint share links." }, { status: 503 });
    }
    if (typeof input.runId !== "string" || (input.sessionId !== undefined && typeof input.sessionId !== "string")) {
      return Response.json({ error: "Invalid run id." }, { status: 400 });
    }
    try {
      const userId = (await resolveUserId(request, env)) ?? "default";
      const nowSeconds = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
      const token = await signShareToken(secret, {
        runId: input.runId,
        userId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      }, 604800, nowSeconds);
      return Response.json({ url: `${url.origin}/api/swarm/share/${token}`, exp: nowSeconds + 604800 });
    } catch {
      return Response.json({ error: "Invalid run id." }, { status: 400 });
    }
  }

  const input = body as { text?: unknown; webhook?: unknown };
  if (typeof input.text !== "string" || typeof input.webhook !== "boolean") {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!input.webhook) {
    return Response.json(parseSwarmIntake(input.text));
  }
  try {
    const intake = normalizeSwarmWebhook(JSON.parse(input.text) as unknown);
    return intake ? Response.json(intake) : Response.json({ error: "Invalid webhook payload." }, { status: 400 });
  } catch {
    return Response.json({ error: "Invalid webhook payload." }, { status: 400 });
  }
}

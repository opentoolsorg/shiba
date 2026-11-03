/**
 * Safe per-user web-session listing, creation, inspection, and resume API
 * (T30/T32). Strictly Access-authenticated; server-mints all session IDs.
 * Extracted from index.ts.
 */
import { getAgentByName } from "agents/routing";
import { getCustomAgentById } from "./custom-agents-store.js";
import type { Env } from "./env.js";
import { resolveHarness } from "./harness/index.js";
import { DASHBOARD_ORG_ID } from "./org-request-auth.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { redactSecrets } from "./security.js";
import {
  buildSessionAgentName,
  createWebSession,
  DEFAULT_SESSION_ID,
  formatSessionList,
  getBaseSessionRecord,
  isValidSessionId,
  sanitizeSessionMetadata,
  type WebSessionRecord,
} from "./web-sessions.js";

/** Bot associations are references, not arbitrary user-supplied session labels. */
async function validateThreadAgent(
  metadata: Record<string, unknown> | undefined,
  env: Env,
): Promise<Response | null> {
  if (!metadata || !Object.hasOwn(metadata, "customAgentId")) return null;
  const id = metadata.customAgentId;
  if (typeof id !== "string" || !id || id !== id.trim()) {
    return Response.json({ error: "Invalid bot id." }, { status: 400 });
  }
  if (!env.AGENT_AUDIT) {
    return Response.json({ error: "Bot registry is not configured." }, { status: 503 });
  }
  try {
    // Web sessions are dashboard-owned. Resolve in the same dashboard org as
    // CustomAgentsView rather than accepting an org from metadata or headers.
    const agent = await getCustomAgentById(env, DASHBOARD_ORG_ID, id);
    if (!agent) {
      return Response.json({ error: "Bot not found." }, { status: 404 });
    }
    try {
      if (typeof agent.config.harness !== "string" || !agent.config.harness.trim()) throw new Error();
      resolveHarness(agent.config.harness, env);
    } catch {
      return Response.json({ error: "Bot harness is unavailable." }, { status: 409 });
    }
    return null;
  } catch (error) {
    console.error("Failed to validate thread agent:", redactSecrets(String(error)));
    return Response.json({ error: "Bot registry is unavailable." }, { status: 503 });
  }
}

/**
 * Safe per-user web-session listing, creation, inspection, and resume API (T30/T32).
 * Strictly Access-authenticated; server-mints all session IDs.
 */
export async function handleWebSessions(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/api\/sessions(?:\/[^/]+(?:\/resume|\/realtime)?)?$/.test(url.pathname)) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const userId = (await resolveUserId(request, env)) ?? "default";
  const stub = await getAgentByName(env.CodingOrchestrator, userId);

  const realtimeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/realtime$/);
  if (realtimeMatch) {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    if (request.headers.get("Origin") !== url.origin) {
      return Response.json({ error: "Cross-origin room connections are not allowed." }, { status: 403 });
    }

    let sessionId: string;
    try {
      sessionId = decodeURIComponent(realtimeMatch[1]!);
    } catch {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }
    if (!isValidSessionId(sessionId)) {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }
    if (sessionId !== DEFAULT_SESSION_ID) {
      try {
        const check = await stub.fetch(
          `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}`,
        );
        if (check.status === 404) return Response.json({ error: "Session not found." }, { status: 404 });
        if (!check.ok) return Response.json({ error: "Failed to verify session." }, { status: check.status });
      } catch (error) {
        console.error("Failed to verify realtime session:", redactSecrets(String(error)));
        return Response.json({ error: "Failed to verify session." }, { status: 503 });
      }
    }

    const viewerId = url.searchParams.get("viewer") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(viewerId)) {
      return Response.json({ error: "Invalid viewer identity." }, { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.set("x-shiba-room-owner", userId.trim().toLowerCase());
    headers.set("x-shiba-room-session", sessionId);
    headers.set("x-shiba-room-viewer", viewerId);
    const roomName = JSON.stringify([userId.trim().toLowerCase(), sessionId]);
    return env.ConversationRoom.getByName(roomName).fetch(new Request(request, { headers }));
  }

  // GET /api/sessions — list user's sessions (always includes base session)
  // POST /api/sessions — create new named session (server-mints session ID)
  if (url.pathname === "/api/sessions") {
    if (request.method === "GET") {
      try {
        const response = await stub.fetch("https://internal/internal/web-sessions");
        if (!response.ok) {
          return Response.json({ error: "Failed to list sessions." }, { status: response.status });
        }
        const body = (await response.json()) as { sessions?: WebSessionRecord[] };
        const sessions = formatSessionList(userId, body.sessions ?? []);
        return Response.json(
          { sessions, defaultSessionId: DEFAULT_SESSION_ID },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        console.error("Failed to list web sessions:", redactSecrets(String(error)));
        return Response.json({ error: "Internal error." }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      let body: unknown = {};
      const rawBody = await request.text().catch(() => "");
      if (rawBody.trim().length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "Invalid JSON body." }, { status: 400 });
        }
      }
      const opts = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as {
        name?: string;
        metadata?: unknown;
      };
      if (opts.metadata !== undefined) {
        try {
          opts.metadata = sanitizeSessionMetadata(opts.metadata);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Invalid metadata." },
            { status: 400 },
          );
        }
      }
      const invalidAgent = await validateThreadAgent(opts.metadata as Record<string, unknown> | undefined, env);
      if (invalidAgent) return invalidAgent;
      let session: WebSessionRecord;
      try {
        session = createWebSession(userId, opts as { name?: string; metadata?: Record<string, unknown> });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Failed to create session." },
          { status: 400 },
        );
      }
      try {
        const response = await stub.fetch("https://internal/internal/web-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session }),
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          return Response.json(
            { error: err.error || "Failed to create session." },
            { status: response.status },
          );
        }
        return Response.json(
          { session },
          { status: 201, headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        console.error("Failed to persist web session:", redactSecrets(String(error)));
        return Response.json({ error: "Internal error." }, { status: 500 });
      }
    }

    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  // POST /api/sessions/:id/resume — touch/resume existing session
  const resumeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
  if (resumeMatch) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(resumeMatch[1]!);
    } catch {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }
    if (!isValidSessionId(sessionId)) {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }
    if (sessionId === DEFAULT_SESSION_ID) {
      return Response.json(
        { session: getBaseSessionRecord(userId), resumed: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      const response = await stub.fetch(
        `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}/resume`,
        { method: "POST" },
      );
      if (!response.ok) {
        if (response.status === 404) {
          return Response.json({ error: "Session not found." }, { status: 404 });
        }
        return Response.json({ error: "Failed to resume session." }, { status: response.status });
      }
      const body = await response.json();
      return Response.json(body, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("Failed to resume web session:", redactSecrets(String(error)));
      return Response.json({ error: "Internal error." }, { status: 500 });
    }
  }

  // GET /api/sessions/:id — inspect session
  // PATCH /api/sessions/:id — rename or update session metadata
  // DELETE /api/sessions/:id — delete session
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionMatch[1]!);
    } catch {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }
    if (!isValidSessionId(sessionId)) {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }

    if (sessionId === DEFAULT_SESSION_ID) {
      if (request.method === "GET") {
        return Response.json(
          { session: getBaseSessionRecord(userId) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (request.method === "DELETE") {
        return Response.json({ error: "Cannot delete the default base session." }, { status: 400 });
      }
      if (request.method === "PATCH") {
        return Response.json({ error: "Cannot modify the default base session." }, { status: 400 });
      }
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }

    if (request.method === "GET") {
      try {
        const response = await stub.fetch(
          `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) {
          if (response.status === 404) {
            return Response.json({ error: "Session not found." }, { status: 404 });
          }
          return Response.json({ error: "Failed to fetch session." }, { status: response.status });
        }
        const body = await response.json();
        return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error("Failed to fetch web session:", redactSecrets(String(error)));
        return Response.json({ error: "Internal error." }, { status: 500 });
      }
    }

    if (request.method === "PATCH") {
      let patchBody: unknown;
      try {
        patchBody = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON." }, { status: 400 });
      }
      const patch = (typeof patchBody === "object" && patchBody !== null ? patchBody : {}) as {
        name?: string;
        metadata?: unknown;
      };
      if (patch.metadata !== undefined) {
        try {
          patch.metadata = sanitizeSessionMetadata(patch.metadata);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Invalid metadata." },
            { status: 400 },
          );
        }
      }
      const invalidAgent = await validateThreadAgent(patch.metadata as Record<string, unknown> | undefined, env);
      if (invalidAgent) return invalidAgent;
      try {
        const response = await stub.fetch(
          `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        if (!response.ok) {
          if (response.status === 404) {
            return Response.json({ error: "Session not found." }, { status: 404 });
          }
          return Response.json({ error: "Failed to update session." }, { status: response.status });
        }
        const body = await response.json();
        return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error("Failed to update web session:", redactSecrets(String(error)));
        return Response.json({ error: "Internal error." }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      const force = url.searchParams.get("force") === "true";
      // 1. Verify the session exists in the base registry
      //    (includeDeleting so a retried delete after a failed registry write
      //    can still find the tombstoned record).
      const getRes = await stub.fetch(
        `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}?includeDeleting=true`,
      );
      if (!getRes.ok) {
        if (getRes.status === 404) {
          return Response.json({ error: "Session not found." }, { status: 404 });
        }
        return Response.json({ error: "Failed to fetch session." }, { status: getRes.status });
      }
      // The stored record's agentName is never trusted: serialized DO
      // state could hold a forged record pointing teardown at another
      // user's DO or the default instance. Recompute the target from the
      // authenticated owner + the already-validated session UUID.
      const sessionAgentName = buildSessionAgentName(userId, sessionId);

      // 2. Tombstone the session BEFORE teardown so new runs/WS connects and
      //    listings stop resolving it while teardown is in flight.
      const markRes = await stub.fetch(
        `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}/deleting`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deleting: true }),
        },
      );
      if (!markRes.ok) {
        if (markRes.status === 404) {
          return Response.json({ error: "Session not found." }, { status: 404 });
        }
        return Response.json({ error: "Failed to mark session for deletion." }, { status: markRes.status });
      }

      // 3. Perform teardown on target session DO. Without `force`, any active
      //    runs/pending approvals abort the delete (409) and the tombstone is
      //    rolled back. With `force`, teardown failures are tolerated but the
      //    response reports them via `teardownFailed` so callers know resource
      //    cleanup may be incomplete.
      let teardownFailed = false;
      try {
        const sessionStub = await getAgentByName(env.CodingOrchestrator, sessionAgentName);
        const teardownRes = await sessionStub.fetch(
          `https://internal/internal/session-teardown${force ? "?force=true" : ""}`,
          { method: "POST" },
        );
        if (!teardownRes.ok) {
          const errBody = await teardownRes.json().catch(() => ({}));
          if (!force) {
            await stub.fetch(
              `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}/deleting`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deleting: false }),
              },
            ).catch(() => undefined);
            return Response.json(errBody, { status: teardownRes.status });
          }
          teardownFailed = true;
        }
      } catch (error) {
        console.error("Session teardown failed:", redactSecrets(String(error)));
        if (!force) {
          await stub.fetch(
            `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}/deleting`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deleting: false }),
            },
          ).catch(() => undefined);
          return Response.json({ error: "Failed to teardown session resources." }, { status: 500 });
        }
        teardownFailed = true;
      }

      // 4. Remove from registry
      try {
        const response = await stub.fetch(
          `https://internal/internal/web-sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          if (response.status === 404) {
            return Response.json({ error: "Session not found." }, { status: 404 });
          }
          return Response.json({ error: "Failed to delete session." }, { status: response.status });
        }
        return Response.json({
          ok: true,
          deleted: sessionId,
          force,
          teardownFailed: teardownFailed || undefined,
        });
      } catch (error) {
        console.error("Failed to delete web session:", redactSecrets(String(error)));
        return Response.json({ error: "Internal error." }, { status: 500 });
      }
    }

    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  return Response.json({ error: "Not found." }, { status: 404 });
}

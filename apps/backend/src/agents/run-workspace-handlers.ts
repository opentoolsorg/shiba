/**
 * Task workspace API — desktop stream minting, files, logs, and control mode.
 * Routed under `/api/runs/<id>/workspace/*` on the orchestrator DO.
 */
import type { DelegatedRun, RunSignal } from "@shiba/shared";
import type { Env } from "../env.js";
import {
  DESKTOP_STREAM_TTL_MS,
  mintDesktopStreamToken,
  type DesktopStreamPurpose,
} from "../sandbox/desktop-tokens.js";
import {
  exposeDesktopPort,
  isSandboxDesktopEnabled,
  randomVncPassword,
  startDesktopStack,
  unexposeDesktopPort,
} from "../sandbox/desktop.js";
import { redactSecrets } from "../security.js";

export interface DesktopSessionRecord {
  httpOrigin: string;
  wsUrl: string;
  vncPassword: string;
  expiresAt: number;
}

export interface RunWorkspaceHost {
  readonly env: Env;
  getRun(runId: string): DelegatedRun | null;
  replaceRun(runId: string, run: DelegatedRun): void;
  getDesktopSession(runId: string): DesktopSessionRecord | undefined;
  setDesktopSession(runId: string, session: DesktopSessionRecord | undefined): void;
}

function runWorkdir(run: DelegatedRun): string {
  return `/workspace/${run.sandboxId}`;
}

function assertRunAccess(run: DelegatedRun, agentPrincipal: string | null): Response | null {
  if (agentPrincipal !== null && run.queuedBy !== agentPrincipal) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  return null;
}

async function ensureDesktopSession(host: RunWorkspaceHost, run: DelegatedRun): Promise<DesktopSessionRecord> {
  const existing = host.getDesktopSession(run.runId);
  if (existing && existing.expiresAt > Date.now()) {
    return existing;
  }
  if (!isSandboxDesktopEnabled(host.env)) {
    throw new Error("Sandbox desktop is disabled on this deployment.");
  }
  if (run.runtime === "local") {
    throw new Error("Local runs do not expose a sandbox desktop.");
  }
  const vncPassword = randomVncPassword();
  await startDesktopStack(host.env, run.sandboxId, vncPassword);
  const exposed = await exposeDesktopPort(host.env, run.sandboxId);
  const session: DesktopSessionRecord = {
    httpOrigin: exposed.httpOrigin,
    wsUrl: exposed.wsUrl,
    vncPassword,
    expiresAt: Date.now() + DESKTOP_STREAM_TTL_MS,
  };
  host.setDesktopSession(run.runId, session);
  if (!run.desktopEnabled) {
    host.replaceRun(run.runId, {
      ...run,
      desktopEnabled: true,
      desktopInputMode: run.desktopInputMode ?? "agent",
    });
  }
  return session;
}

export async function handleRunWorkspaceRequest(
  host: RunWorkspaceHost,
  request: Request,
  runId: string,
  tail: string,
  userId: string,
  agentPrincipal: string | null,
): Promise<Response> {
  const run = host.getRun(runId);
  if (run === null) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  const denied = assertRunAccess(run, agentPrincipal);
  if (denied) return denied;

  const segments = tail.split("/").filter(Boolean);
  const head = segments[0] ?? "";

  if (head === "desktop" && request.method === "GET" && segments.length === 1) {
    if (!isSandboxDesktopEnabled(host.env)) {
      return Response.json({ desktop: { status: "disabled" } });
    }
    try {
      const session = await ensureDesktopSession(host, run);
      const viewToken = await mintDesktopStreamToken(host.env, {
        runId,
        userId,
        purpose: "view",
        exp: session.expiresAt,
      });
      if (!viewToken) {
        return Response.json({ error: "Desktop stream signing is not configured." }, { status: 503 });
      }
      const inputMode = run.desktopInputMode ?? "agent";
      return Response.json({
        desktop: {
          status: "ready",
          inputMode,
          expiresAt: session.expiresAt,
          embedPath: `/api/runs/${encodeURIComponent(runId)}/workspace/desktop/embed?token=${encodeURIComponent(viewToken)}`,
          wsPath: `/api/runs/${encodeURIComponent(runId)}/workspace/desktop/ws?token=${encodeURIComponent(viewToken)}`,
        },
      });
    } catch (error) {
      return Response.json(
        { desktop: { status: "error", detail: redactSecrets(error instanceof Error ? error.message : String(error)) } },
        { status: 502 },
      );
    }
  }

  if (head === "desktop" && segments[1] === "control" && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const mode = (body as { mode?: unknown }).mode;
    if (mode !== "agent" && mode !== "human") {
      return Response.json({ error: "mode must be agent or human." }, { status: 400 });
    }
    host.replaceRun(run.runId, { ...run, desktopInputMode: mode });
    return Response.json({ ok: true, inputMode: mode });
  }

  if (head === "desktop" && segments[1] === "embed" && request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const { verifyDesktopStreamToken } = await import("../sandbox/desktop-tokens.js");
    const claims = await verifyDesktopStreamToken(host.env, token);
    if (!claims || claims.runId !== runId || claims.purpose !== "view") {
      return Response.json({ error: "Invalid or expired token." }, { status: 401 });
    }
    const session = host.getDesktopSession(runId);
    if (!session) {
      return Response.json({ error: "Desktop session not active." }, { status: 404 });
    }
    const wsPath = `/api/runs/${encodeURIComponent(runId)}/workspace/desktop/ws?token=${encodeURIComponent(token)}`;
    const viewOnly = (run.desktopInputMode ?? "agent") !== "human";
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Shiba desktop</title>
<style>html,body{margin:0;height:100%;background:#0b0d10}#screen{width:100%;height:100%}</style>
<script type="module">
import RFB from "https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/core/rfb.js";
const wsUrl = ${JSON.stringify(`${new URL(request.url).origin}${wsPath}`)};
const rfb = new RFB(document.getElementById("screen"), wsUrl, { credentials: { password: ${JSON.stringify(session.vncPassword)} } });
rfb.viewOnly = ${viewOnly ? "true" : "false"};
rfb.scaleViewport = true;
</script></head>
<body><div id="screen"></div></body></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (head === "files" && request.method === "GET" && segments.length === 1) {
    const path = new URL(request.url).searchParams.get("path") ?? runWorkdir(run);
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(host.env.Sandbox, run.sandboxId);
    try {
      const result = await sandbox.listFiles(path);
      const files = (result as { files?: unknown }).files ?? result;
      return Response.json({ path, files });
    } catch (error) {
      return Response.json(
        { path, files: [], error: redactSecrets(error instanceof Error ? error.message : String(error)) },
        { status: 404 },
      );
    }
  }

  if (head === "file" && request.method === "GET" && segments.length === 1) {
    const targetPath = new URL(request.url).searchParams.get("path");
    if (!targetPath) {
      return Response.json({ error: "path is required." }, { status: 400 });
    }
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(host.env.Sandbox, run.sandboxId);
    try {
      const result = await sandbox.readFile(targetPath, { encoding: "utf-8" });
      const content = (result as { content?: unknown }).content ?? result;
      return Response.json({ path: targetPath, content: typeof content === "string" ? content : String(content) });
    } catch (error) {
      return Response.json(
        { path: targetPath, error: redactSecrets(error instanceof Error ? error.message : String(error)) },
        { status: 404 },
      );
    }
  }

  if (head === "logs" && request.method === "GET" && segments.length === 1) {
    const lines = formatExecLogLines(run.signals ?? []);
    return Response.json({ lines });
  }

  return Response.json({ error: "Not found." }, { status: 404 });
}

export function formatExecLogLines(signals: RunSignal[]): string[] {
  const lines: string[] = [];
  for (const signal of signals) {
    if (signal.kind === "exec.invoked" || signal.kind === "exec.settled") {
      lines.push(`[${new Date(signal.at).toISOString()}] ${signal.kind}${signal.detail ? ` ${signal.detail}` : ""}`);
    }
  }
  return lines.slice(-500);
}

export async function teardownDesktopSession(host: RunWorkspaceHost, runId: string, sandboxId: string): Promise<void> {
  host.setDesktopSession(runId, undefined);
  if (isSandboxDesktopEnabled(host.env)) {
    await unexposeDesktopPort(host.env, sandboxId);
  }
}

export async function mintDesktopControlToken(
  env: Env,
  runId: string,
  userId: string,
  purpose: DesktopStreamPurpose,
  exp: number,
): Promise<string | null> {
  return mintDesktopStreamToken(env, { runId, userId, purpose, exp });
}

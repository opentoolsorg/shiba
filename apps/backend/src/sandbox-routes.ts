import { sandboxFeatureMatrix } from "@shiba/shared";
import type { SandboxInstance } from "@shiba/sandbox";
import { getSandbox } from "./sandbox/client.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { requireApplicationJson, requireSameOriginBrowserMutation } from "./request-auth.js";
import { jsonObjectBody } from "./route-utils.js";
import { redactSecrets } from "./security.js";
import { assertAuthorizedSandboxDebug } from "./sandbox/debug-access.js";
import { getSandboxInstance, resolveSandboxProviderForSelection } from "./sandbox/provider.js";
import { resolveSandboxSelection, type SandboxSelectionContext } from "./sandbox/selection.js";

const SAFE_SANDBOX_ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

export function isValidSandboxId(id: string): boolean {
  return SAFE_SANDBOX_ID_RE.test(id);
}

function selectionForOrg(orgId: string, url: URL): SandboxSelectionContext {
  const taskProviderId = url.searchParams.get("provider")?.trim() || undefined;
  const customAgentProviderId = url.searchParams.get("customAgentProvider")?.trim() || undefined;
  return {
    orgId,
    ...(taskProviderId ? { taskProviderId } : {}),
    ...(customAgentProviderId ? { customAgentProviderId } : {}),
  };
}

async function resolveDebugSandbox(
  env: Env,
  sandboxId: string,
  ctx: SandboxSelectionContext,
): Promise<{ instance: SandboxInstance; providerId: string; selectionSource: string }> {
  const selection = await resolveSandboxSelection(env, ctx);
  const provider = await resolveSandboxProviderForSelection(env, ctx);
  const instance = await getSandboxInstance(env, sandboxId, ctx);
  return { instance, providerId: provider.id, selectionSource: selection.source };
}

async function listFilesViaProvider(
  env: Env,
  sandboxId: string,
  targetPath: string,
  ctx: SandboxSelectionContext,
): Promise<unknown[]> {
  const { instance, providerId } = await resolveDebugSandbox(env, sandboxId, ctx);
  if (providerId === "cloudflare" && env.Sandbox) {
    try {
      const result = await getSandbox(env.Sandbox, sandboxId).listFiles(targetPath);
      const files = (result as { files?: unknown }).files ?? result;
      return Array.isArray(files) ? files : [];
    } catch {
      // Fall through to exec-based listing.
    }
  }
  const quoted = targetPath.replace(/'/g, `'\\''`);
  const result = await instance.exec(`ls -la '${quoted}'`, {
    cwd: "/",
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `ls failed (${result.exitCode})`);
  }
  const lines = result.stdout.split("\n").filter((line) => line.trim() && !line.startsWith("total "));
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    const name = parts.slice(8).join(" ") || line;
    const isDirectory = line.startsWith("d");
    return { name, path: `${targetPath.replace(/\/$/, "")}/${name}`, isDirectory, raw: line };
  });
}

export async function handleSandboxRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/sandboxes\/([^/]+)\/(info|files|file|exec|diff|processes)$/);
  if (!match) {
    return null;
  }

  const rawSandboxId = match[1];
  const action = match[2];
  if (rawSandboxId === undefined || action === undefined) {
    return null;
  }

  let sandboxId: string;
  try {
    sandboxId = decodeURIComponent(rawSandboxId);
  } catch {
    return Response.json({ error: "Invalid sandbox ID encoding." }, { status: 400 });
  }

  if (!isValidSandboxId(sandboxId)) {
    return Response.json({ error: "Invalid sandbox ID format." }, { status: 400 });
  }

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const selectionCtx = selectionForOrg(auth.orgId, url);

  const denied = await assertAuthorizedSandboxDebug(env, request, sandboxId);
  if (denied) return denied;

  try {
    if (action === "info" && request.method === "GET") {
      let placementId: string | null | undefined = null;
      let processes: unknown[] = [];
      let reachable = false;
      let providerId = "cloudflare";
      let selectionSource = "deployment";
      let capabilities = sandboxFeatureMatrix({
        edgeEgressEnforcement: false,
        previewUrls: false,
        snapshots: false,
        backgroundProcesses: false,
      });
      try {
        const resolved = await resolveDebugSandbox(env, sandboxId, selectionCtx);
        providerId = resolved.providerId;
        selectionSource = resolved.selectionSource;
        capabilities = sandboxFeatureMatrix(resolved.instance.capabilities);
        await resolved.instance.exec("true", { timeoutMs: 5_000 });
        reachable = true;
        if (providerId === "cloudflare" && env.Sandbox) {
          try {
            const rpc = getSandbox(env.Sandbox, sandboxId);
            placementId = await rpc.getContainerPlacementId();
            try {
              processes = await rpc.listProcesses();
            } catch {
              processes = [];
            }
          } catch {
            // Optional debug fields only.
          }
        }
      } catch {
        reachable = false;
        try {
          const selection = await resolveSandboxSelection(env, selectionCtx);
          const provider = await resolveSandboxProviderForSelection(env, selectionCtx);
          providerId = provider.id;
          selectionSource = selection.source;
          capabilities = sandboxFeatureMatrix(provider.capabilities);
        } catch {
          // Keep defaults.
        }
      }
      return Response.json({
        sandboxId,
        available: reachable,
        providerId,
        selectionSource,
        capabilities,
        placementId: placementId ?? null,
        processes: processes ?? [],
        defaultPort: 3000,
        allowedHosts: [
          "generativelanguage.googleapis.com",
          "api.anthropic.com",
          "api.openai.com",
          "api.x.ai",
          "github.com",
          "codeload.github.com",
        ],
      });
    }

    if (action === "files" && request.method === "GET") {
      const targetPath = url.searchParams.get("path") || "/workspace";
      try {
        const files = await listFilesViaProvider(env, sandboxId, targetPath, selectionCtx);
        return Response.json({
          sandboxId,
          path: targetPath,
          files,
        });
      } catch (error) {
        return Response.json(
          {
            sandboxId,
            path: targetPath,
            error: redactSecrets(error instanceof Error ? error.message : String(error)),
            files: [],
          },
          { status: 404 },
        );
      }
    }

    const { instance } = await resolveDebugSandbox(env, sandboxId, selectionCtx);

    if (action === "file" && request.method === "GET") {
      const targetPath = url.searchParams.get("path");
      if (!targetPath) {
        return Response.json({ error: "Path parameter is required." }, { status: 400 });
      }
      try {
        const result = await instance.readFile(targetPath);
        const content = result.kind === "utf8" ? result.content : result.content;
        return Response.json({
          sandboxId,
          path: targetPath,
          content: typeof content === "string" ? content : String(content),
        });
      } catch (error) {
        return Response.json(
          {
            sandboxId,
            path: targetPath,
            error: redactSecrets(error instanceof Error ? error.message : String(error)),
          },
          { status: 404 },
        );
      }
    }

    if (action === "exec" && request.method === "POST") {
      const csrf = requireSameOriginBrowserMutation(request);
      if (csrf) return csrf;
      const jsonType = requireApplicationJson(request);
      if (jsonType) return jsonType;
      let body: Record<string, unknown>;
      try {
        body = await jsonObjectBody(request);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Invalid JSON body." },
          { status: 400 },
        );
      }
      const { command, cwd } = body as { command?: unknown; cwd?: unknown };
      if (typeof command !== "string" || !command.trim()) {
        return Response.json({ error: "Command string is required." }, { status: 400 });
      }
      const safeCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "/workspace";
      try {
        const result = await instance.exec(command, {
          cwd: safeCwd,
          timeoutMs: 30_000,
        });
        return Response.json({
          sandboxId,
          command,
          cwd: safeCwd,
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          success: result.exitCode === 0,
        });
      } catch (error) {
        return Response.json(
          {
            sandboxId,
            command,
            cwd: safeCwd,
            error: redactSecrets(error instanceof Error ? error.message : String(error)),
            exitCode: -1,
            stdout: "",
            stderr: String(error),
            success: false,
          },
          { status: 500 },
        );
      }
    }

    if (action === "diff" && request.method === "GET") {
      try {
        const result = await instance.exec("git diff HEAD", {
          cwd: "/workspace",
          timeoutMs: 15_000,
        });
        return Response.json({
          sandboxId,
          diff: result.stdout ?? "",
        });
      } catch (error) {
        return Response.json(
          {
            sandboxId,
            error: redactSecrets(error instanceof Error ? error.message : String(error)),
            diff: "",
          },
          { status: 500 },
        );
      }
    }

    if (action === "processes" && request.method === "GET") {
      try {
        if (env.Sandbox) {
          const processes = await getSandbox(env.Sandbox, sandboxId).listProcesses();
          return Response.json({
            sandboxId,
            processes: processes ?? [],
          });
        }
        return Response.json({ sandboxId, processes: [] });
      } catch (error) {
        return Response.json(
          {
            sandboxId,
            error: redactSecrets(error instanceof Error ? error.message : String(error)),
            processes: [],
          },
          { status: 500 },
        );
      }
    }

    return Response.json({ error: "Method not allowed." }, { status: 405 });
  } catch (error) {
    return Response.json(
      {
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      },
      { status: 500 },
    );
  }
}

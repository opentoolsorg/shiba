import { SandboxError } from "../errors.js";
import type {
  ComputesdkClient,
  ComputesdkCommandResult,
  ComputesdkInstance,
  ComputesdkRunCommandOptions,
} from "./computesdk-types.js";
import { createComputesdkSandboxProvider } from "./computesdk.js";
import { capabilitiesForComputesdkBackend } from "./computesdk-capabilities.js";
import type { SandboxProvider } from "../types.js";

export interface ComputesdkRemoteRunnerOptions {
  baseUrl: string;
  token: string;
  backendProvider: string;
  fetchImpl?: typeof fetch;
}

async function runnerFetch(
  options: ComputesdkRemoteRunnerOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${options.baseUrl.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${options.token}`);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await (options.fetchImpl ?? fetch)(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SandboxError(
      "provider_misconfigured",
      `ComputeSDK runner ${path} failed (${response.status}): ${text.slice(0, 200)}`,
      { provider: "computesdk" },
    );
  }
  return response;
}

export function createComputesdkRemoteClient(options: ComputesdkRemoteRunnerOptions): ComputesdkClient {
  const instances = {
    async create() {
      const response = await runnerFetch(options, "/v1/instances", { method: "POST", body: "{}" });
      const body = (await response.json()) as { instanceId: string; provider: string };
      return makeRemoteInstance(options, body.instanceId, body.provider);
    },
    async getById(instanceId: string) {
      const response = await runnerFetch(options, `/v1/instances/${encodeURIComponent(instanceId)}`);
      const body = (await response.json()) as { instanceId: string; provider: string };
      return makeRemoteInstance(options, body.instanceId, body.provider);
    },
    async destroy(instanceId: string) {
      await runnerFetch(options, `/v1/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" });
    },
  };

  return {
    backendProvider: options.backendProvider,
    instances,
  };
}

function makeRemoteInstance(
  options: ComputesdkRemoteRunnerOptions,
  instanceId: string,
  provider: string,
): ComputesdkInstance {
  const postJson = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await runnerFetch(options, path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  };

  return {
    instanceId,
    provider,
    runCommand: async (command, opts) =>
      postJson<ComputesdkCommandResult>(`/v1/instances/${encodeURIComponent(instanceId)}/exec`, {
        command,
        cwd: opts?.cwd,
        env: opts?.env,
        timeout: opts?.timeout,
      }),
    startProcess: async (command, procOpts) => {
      const started = await postJson<{ processId: string }>(
        `/v1/instances/${encodeURIComponent(instanceId)}/process`,
        { command, cwd: procOpts?.cwd, env: procOpts?.env },
      );
      return {
        kill: async () => {
          await runnerFetch(
            options,
            `/v1/instances/${encodeURIComponent(instanceId)}/process/${started.processId}`,
            { method: "DELETE" },
          );
        },
        wait: async (waitOpts) =>
          postJson(`/v1/instances/${encodeURIComponent(instanceId)}/process/${started.processId}/wait`, {
            timeout: waitOpts?.timeout,
          }),
      };
    },
    getUrl: async (urlOpts) => {
      const body = await postJson<{ url: string }>(
        `/v1/instances/${encodeURIComponent(instanceId)}/url`,
        urlOpts,
      );
      return body.url;
    },
    destroy: async () => {
      await runnerFetch(options, `/v1/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" });
    },
    filesystem: {
      readFile: async (path) => {
        const body = await postJson<{ content: string }>(
          `/v1/instances/${encodeURIComponent(instanceId)}/fs/read`,
          { path },
        );
        return body.content;
      },
      writeFile: async (path, content) => {
        await postJson(`/v1/instances/${encodeURIComponent(instanceId)}/fs/write`, { path, content });
      },
      mkdir: async (path) => {
        await postJson(`/v1/instances/${encodeURIComponent(instanceId)}/fs/mkdir`, { path });
      },
    },
  };
}

/** Worker-safe provider: talks to a Node/Bun ComputeSDK runner over HTTP. */
export function createComputesdkRemoteSandboxProvider(
  options: ComputesdkRemoteRunnerOptions & { defaultTimeoutMs?: number },
): SandboxProvider {
  const client = createComputesdkRemoteClient(options);
  const capabilities = capabilitiesForComputesdkBackend(options.backendProvider);
  return createComputesdkSandboxProvider({
    client,
    capabilities,
    defaultTimeoutMs: options.defaultTimeoutMs,
  });
}

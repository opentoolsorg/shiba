import { resolveSandboxDurableObjectId } from "@shiba/shared";
import type { Env } from "../env.js";
import { parsePreviewHostname } from "./preview-proxy.js";
import type { Sandbox } from "./durable-object.js";

/** Routes tokenized preview hostnames to the sandbox container port (0.12 parity). */
export async function proxyToSandbox(request: Request, env: Pick<Env, "Sandbox">): Promise<Response | null> {
  const hostname = new URL(request.url).hostname;
  const route = parsePreviewHostname(hostname);
  if (!route) return null;
  const id = resolveSandboxDurableObjectId(env.Sandbox, route.sandboxId);
  const stub = env.Sandbox.get(id) as DurableObjectStub<Sandbox>;
  return stub.proxyPreviewRequest(request, route);
}

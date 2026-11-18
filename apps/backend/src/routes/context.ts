import type { Env } from "../env.js";
import { resolveUserId } from "../request-auth.js";

/** Identity is lazy so callbacks and static requests never acquire a session dependency. */
export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  execution?: ExecutionContext;
  identity: () => Promise<string | null>;
}

export function createRequestContext(
  request: Request,
  env: Env,
  execution?: ExecutionContext,
): RequestContext {
  let identity: Promise<string | null> | undefined;
  return {
    request,
    env,
    url: new URL(request.url),
    execution,
    identity: () => (identity ??= resolveUserId(request, env)),
  };
}

import type { Env } from "../env.js";

// Shared by every v1 group handler; the dispatcher in v1-routes.ts builds it once per request.
export interface V1Context {
  request: Request;
  env: Env;
  url: URL;
  // Signed internal call into the CodingOrchestrator DO; path is an /api/runs* path.
  forward(method: string, path: string, input?: Record<string, unknown>): Promise<Response>;
}

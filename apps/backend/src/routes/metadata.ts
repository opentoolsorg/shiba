import { handleMeta } from "../meta-routes.js";
import type { RequestContext } from "./context.js";

export async function metaResponse({ request, env }: RequestContext): Promise<Response | null> {
  return handleMeta(request, env);
}

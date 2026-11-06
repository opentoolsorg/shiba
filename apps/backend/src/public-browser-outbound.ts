import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";
import { PublicBrowserOutboundGate } from "./public-browser.js";

export interface PublicBrowserOutboundProps { sessionId: string; generation: number }

/** Public-browser-only interceptor. It shares no SandboxOutbound grant, provider forwarder or credential. */
export function publicBrowserOutbound(env: Env, props: PublicBrowserOutboundProps, request: Request, upstream: (request: Request) => Promise<Response> = (r) => fetch(r)) {
  const namespace = env.PublicBrowserSession;
  return new PublicBrowserOutboundGate(async (claim) => {
    if (!namespace) return { ok: false, code: "public_browser_runtime_unavailable" };
    return namespace.get(namespace.idFromName(props.sessionId)).authorizeOutbound(props.sessionId, props.generation, claim);
  }, upstream).handle(request);
}
export class PublicBrowserOutbound extends WorkerEntrypoint<Env, PublicBrowserOutboundProps> {
  override async fetch(request: Request): Promise<Response> { return publicBrowserOutbound(this.env, this.ctx.props, request); }
}

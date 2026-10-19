import { resolveSandboxDurableObjectId } from "@shiba/shared";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env.js";
import { dispatchOutboundRequest } from "./outbound-dispatch.js";
import type { Sandbox } from "./durable-object.js";

export interface SandboxOutboundProps {
  sandboxId: string;
}

/**
 * Per-sandbox outbound interceptor (Sandbox SDK 1.0). Registered on the
 * container after start(); credentials stay in the Worker via egress.ts.
 */
export class SandboxOutbound extends WorkerEntrypoint<Env, SandboxOutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const id = resolveSandboxDurableObjectId(this.env.Sandbox, this.ctx.props.sandboxId);
    const stub = this.env.Sandbox.get(id) as DurableObjectStub<Sandbox>;
    const config = await stub.getOutboundConfig();
    return dispatchOutboundRequest(request, this.env, config);
  }
}

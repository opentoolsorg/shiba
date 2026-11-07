#!/usr/bin/env node
import { planReadGateway } from "./openconnector-read-gateway.mjs";
import { revision } from "./openconnector.mjs";

/** Generates an explicitly reviewed alternative entry. No upstream tracked source edits or deployment. */
export function coordinatedGatewayEntry(runtimeImport) {
  if (typeof runtimeImport !== "string" || !runtimeImport.startsWith(".") || !runtimeImport.endsWith("/src/operator-runtime.ts")) throw new Error("Expected an explicit local runtime package import");
  return `// Shiba-owned local plan. Original pinned upstream entry remains unchanged.
import { DurableObject } from "cloudflare:workers";
import upstream from "./cloudflare.ts";
import type { CloudflareEnv } from "./cloudflare/cloudflare-env.ts";
import { CoordinatedOwner, OperatorInvocationStore } from ${JSON.stringify(runtimeImport)};

type Env = CloudflareEnv & { SHIBA_OPERATOR_EPOCH: string; SHIBA_CONNECTOR_OWNER: DurableObjectNamespace<ShibaOpenConnectorOwner> };
const ownerName = "shiba-openconnector-owner-v1"; // Never include an epoch/version in this name.
function reserved(request: Request) {
  const path = new URL(request.url).pathname;
  let decoded = path; try { decoded = decodeURIComponent(path); } catch { return true; }
  return decoded.startsWith("/v1/shiba/operator-gate");
}
const unavailable = () => Response.json({ error: "operator_activation_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
export class ShibaOpenConnectorOwner extends DurableObject<Env> {
  private readonly owner = new CoordinatedOwner();
  private readonly nativeEnv: CloudflareEnv;
  private readonly invocations: OperatorInvocationStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.invocations = new OperatorInvocationStore(ctx.storage);
    this.invocations.recover();
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(env.SHIBA_OPERATOR_EPOCH)) throw new Error("operator_epoch_required");
    this.invocations.initializeEpoch(env.SHIBA_OPERATOR_EPOCH);
    this.nativeEnv = { ...env, DB: this.owner.database(env.DB) };
  }
  fetch(request: Request) {
    if (reserved(request)) return unavailable();
    return this.owner.nativeFetch(async (ctx) => {
      this.invocations.assertEpoch(this.env.SHIBA_OPERATOR_EPOCH);
      return upstream.fetch(request, this.nativeEnv, ctx);
    });
  }
  runScheduled(event: unknown) {
    return this.owner.run(async (ctx) => {
      this.invocations.assertEpoch(this.env.SHIBA_OPERATOR_EPOCH);
      await upstream.scheduled(event, this.nativeEnv, ctx);
    });
  }
}
export default {
  fetch(request: Request, env: Env) {
    if (reserved(request)) return unavailable();
    return env.SHIBA_CONNECTOR_OWNER.getByName(ownerName).fetch(request);
  },
  async scheduled(event: { cron: string; scheduledTime: number }, env: Env) {
    await env.SHIBA_CONNECTOR_OWNER.getByName(ownerName).runScheduled({ cron: event.cron, scheduledTime: event.scheduledTime });
  },
};
`;
}

/** Pure plan. Deliberately no enable switch, API-key HTTP executor, credential, resource creation or deployment. */
export function planCoordinatedGateway(manual, { parentWorker, runtimeImport, deploymentEpoch }) {
  // Reuse existing careful config/secret checks, but not its uncoordinated generated entry.
  planReadGateway(manual, { parentWorker, adapterImport: runtimeImport?.replace(/\/operator-runtime\.ts$/, "/upstream-adapter.ts") });
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(deploymentEpoch ?? "")) throw new Error("Select the explicit reviewed deployment epoch");
  if (manual.durable_objects?.bindings?.length || manual.migrations?.length) throw new Error("Existing Durable Object migrations require a separately reviewed append-only plan");
  if (manual.kv_namespaces?.some(binding => binding.binding === "OAUTH_KV")) throw new Error("MCP OAuth KV writers require separate coordinated ownership verification");
  const configuration = structuredClone(manual);
  configuration.main = "src/server/shiba-coordinated-entry.ts";
  configuration.compatibility_flags = [...new Set([...(configuration.compatibility_flags ?? []), "nodejs_compat"])];
  configuration.vars = { ...configuration.vars, SHIBA_OPERATOR_EPOCH: deploymentEpoch };
  configuration.durable_objects = { bindings: [{ name: "SHIBA_CONNECTOR_OWNER", class_name: "ShibaOpenConnectorOwner" }] };
  configuration.migrations = [{ tag: "shiba-connector-owner-v1", new_sqlite_classes: ["ShibaOpenConnectorOwner"] }];
  return {
    upstreamRevision: revision, deploys: false, provisions: false, operatorExecutionEnabled: false,
    entryPath: "src/server/shiba-coordinated-entry.ts", configPath: "wrangler.shiba-coordinated.jsonc",
    entry: coordinatedGatewayEntry(runtimeImport), configuration,
    blockers: ["Parent authority invalidation paths are not all integrated.", "Old deployments and alternate database writers must be drained and removed before activation.", "Epoch handover requires reviewed operator migration; it cannot automatically reacquire a retired epoch.", "Native SSE, WebSockets and MCP OAuth KV are unsupported in this conservative owner.", "Only an offline fixed Figma metadata executor is reviewed; no provider account acceptance has been performed."],
  };
}

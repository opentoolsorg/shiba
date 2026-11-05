import { callbackAttempts, type AuthorityBinding } from "./callback.js";
import { googleAdsSourceFingerprint, handleReadGateway } from "./gateway.js";
import { readGatewayManifest } from "./manifest.js";
import { boundedBody, digest, hash } from "./json.js";
import { ReadGateError, type OAuthReadCredential, type ReadOperationId, type ReadRequest } from "./types.js";

/** Structural subsets of the unmodified d89dc9 upstream exports. The generated entry supplies their real implementations. */
export interface UpstreamSecretCodec {
  readonly encrypted: boolean;
  encode(value: string): Promise<string>;
  decode(value: string): Promise<string>;
}
export interface UpstreamPolicyRules {
  allowedActions: string[]; blockedActions: string[]; allowedProxies: string[]; blockedProxies: string[];
  allowedTriggers?: string[]; blockedTriggers?: string[];
}
export interface UpstreamRuntimeGrant {
  tokenId: string; allowedActions: string[]; blockedActions: string[]; allowedProxies: string[];
  allowedConnections?: string[]; allowedTriggers?: string[];
}
export interface UpstreamStoredConnection {
  id: string; revision: string; service: string; connectionName: string; source?: "local" | "saas";
  credential?: unknown;
}
export interface UpstreamReadContext {
  getConnection(service: string, alias: string): Promise<UpstreamStoredConnection | undefined>;
  resolveRuntimeToken(token: string): Promise<UpstreamRuntimeGrant | undefined>;
  getRuntimePolicy(): Promise<{ rules: UpstreamPolicyRules; updatedAt: string } | undefined>;
}
export interface PinnedUpstreamModules<Database> {
  createWorkerSecretCodec(key: string | undefined): Promise<UpstreamSecretCodec>;
  createReadContext(database: Database, secretCodec: UpstreamSecretCodec): UpstreamReadContext;
  emptyPolicyRules(): UpstreamPolicyRules;
  parseActionPolicyList(value: string | undefined): string[];
  createPolicy(deployment: UpstreamPolicyRules, runtime: UpstreamPolicyRules, token: UpstreamRuntimeGrant, updatedAt?: string): {
    evaluate(action: { id: string }): { allowed: boolean };
    evaluateConnection(rawConnectionId?: string): { allowed: boolean };
  };
}
export interface PinnedReadGatewayEnv<Database> {
  DB: Database;
  OOMOL_CONNECT_ENCRYPTION_KEY?: string;
  OOMOL_CONNECT_ALLOWED_ACTIONS?: string; OOMOL_CONNECT_BLOCKED_ACTIONS?: string;
  OOMOL_CONNECT_ALLOWED_PROXIES?: string; OOMOL_CONNECT_BLOCKED_PROXIES?: string;
  OOMOL_CONNECT_ALLOWED_TRIGGERS?: string; OOMOL_CONNECT_BLOCKED_TRIGGERS?: string;
  SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED?: string;
  SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY?: string;
  SHIBA_AUTOMATIC_AUTHORITY?: AuthorityBinding;
  CF_VERSION_METADATA?: { id: string; tag: string };
}
const AUDITED: readonly string[] = ["figma.get_file_metadata", "figma.list_comments", "linear.list_issues_by_team_id", "github.list_pull_requests", "googleads.campaign_daily_metrics"];
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const fail = (code = "read_gate_oauth_unavailable") => new ReadGateError(code, 403);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}
/** The upstream AES codec permits legacy plaintext. This lane deliberately does not. */
function strictEncryptedCodec(codec: UpstreamSecretCodec): UpstreamSecretCodec {
  if (codec.encrypted !== true) throw fail("read_gate_encrypted_storage_required");
  return { encrypted: true, encode: (value) => codec.encode(value), decode: (value) => {
    if (!value.startsWith("enc:worker:v1:")) throw fail("read_gate_encrypted_storage_required");
    return codec.decode(value);
  } };
}
function scopedGrant(value: UpstreamRuntimeGrant | undefined): UpstreamRuntimeGrant {
  if (!value || !value.tokenId || !Array.isArray(value.allowedActions) || value.allowedActions.length === 0 ||
    value.allowedActions.some((action) => !AUDITED.includes(action)) || !Array.isArray(value.allowedConnections) || value.allowedConnections.length === 0 ||
    value.allowedConnections.some((connection) => typeof connection !== "string" || !connection || connection === "*")) throw fail("read_gate_scoped_runtime_required");
  return value;
}
function oauth(stored: UpstreamStoredConnection | undefined, input: ReadRequest): OAuthReadCredential {
  const service = input.operationId.split(".")[0];
  if (!/^w_[a-f0-9]{32}$/.test(input.alias) || !stored || stored.source === "saas" || stored.service !== service || stored.connectionName !== input.alias ||
    typeof stored.id !== "string" || !stored.id || typeof stored.revision !== "string" || !stored.revision) throw fail();
  const credential = object(stored.credential), metadata = object(credential.metadata);
  if (credential.authType !== "oauth2" || typeof credential.accessToken !== "string" ||
    (credential.tokenType !== undefined && (typeof credential.tokenType !== "string" || credential.tokenType.toLowerCase() !== "bearer")) || metadata.oauthReauthRequired === true ||
    typeof metadata.oauthAuthorizationId !== "string" || !metadata.oauthAuthorizationId || metadata.oauthAuthorizationId.length > 200) throw fail();
  let expiresAt: number | null = null;
  if (credential.expiresAt !== undefined) {
    if (typeof credential.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(credential.expiresAt)) throw fail();
    expiresAt = Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) throw fail();
  }
  const refresh = credential.refreshToken;
  if (refresh !== undefined && (typeof refresh !== "string" || refresh.length < 16 || refresh.length > 8192)) throw fail();
  let developerToken: string | undefined;
  if (service === "googleads") {
    const profile=object(credential.profile);
    if(!Array.isArray(profile.grantedScopes)||!profile.grantedScopes.includes("https://www.googleapis.com/auth/adwords"))throw fail("read_gate_googleads_configuration_unavailable");
    const extra = object(metadata.oauthClientSecretExtra);
    if (typeof extra.developerToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(extra.developerToken)) throw fail("read_gate_googleads_configuration_unavailable");
    developerToken = extra.developerToken;
  }
  return { ...(developerToken ? {developerToken} : {}), accessToken: credential.accessToken, rawConnectionId: stored.id, revision: stored.revision, consentId: metadata.oauthAuthorizationId, expiresAt,
    ...(typeof refresh === "string" ? { privateRedactions: [refresh] } : {}) };
}

/** Per-request private context only. The original manual entry and its auth behavior remain unchanged. */
export async function handlePinnedUpstreamReadGateway<Database>(request: Request, env: PinnedReadGatewayEnv<Database>, modules: PinnedUpstreamModules<Database>, manualFetch: (request: Request) => Promise<Response>): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/v1/shiba/read-gate")) {
    let decoded = pathname; try { decoded = decodeURIComponent(pathname); } catch { /* Invalid escapes never become a reserved read route. */ }
    if (decoded.startsWith("/v1/shiba/read-gate")) return Response.json({ error: "read_gate_not_found" }, { status: 404, headers: HEADERS });
    return manualFetch(request);
  }
  const enabled = env.SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED === "true" && Boolean(env.SHIBA_AUTOMATIC_AUTHORITY);
  let context: Promise<UpstreamReadContext> | undefined;
  const getContext = () => context ??= (async () => {
    if (!env.OOMOL_CONNECT_ENCRYPTION_KEY?.trim()) throw fail("read_gate_encrypted_storage_required");
    const codec = strictEncryptedCodec(await modules.createWorkerSecretCodec(env.OOMOL_CONNECT_ENCRYPTION_KEY));
    return modules.createReadContext(env.DB, codec);
  })();
  const verifyRuntime = async (incoming: Request, operationId?: ReadOperationId, rawConnectionId?: string) => {
    const match = /^Bearer (oct_[A-Za-z0-9_-]{43})$/.exec(incoming.headers.get("authorization") ?? "");
    if (!match) throw fail("read_gate_scoped_runtime_required");
    const database = await getContext(), grant = scopedGrant(await database.resolveRuntimeToken(match[1]!));
    if(operationId==="googleads.campaign_daily_metrics" && (grant.allowedActions.length!==1 || grant.allowedActions[0]!==operationId || grant.allowedConnections!.length!==1)) throw fail("read_gate_scoped_runtime_required");
    const runtime = await database.getRuntimePolicy();
    const deployment = { allowedActions: modules.parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_ACTIONS), blockedActions: modules.parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_ACTIONS),
      allowedProxies: modules.parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_PROXIES), blockedProxies: modules.parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_PROXIES),
      allowedTriggers: modules.parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_TRIGGERS), blockedTriggers: modules.parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_TRIGGERS) };
    const policy = modules.createPolicy(deployment, runtime?.rules ?? modules.emptyPolicyRules(), grant, runtime?.updatedAt);
    if (operationId && (!grant.allowedActions.includes(operationId) || !policy.evaluate({ id: operationId }).allowed) ||
      rawConnectionId && (!grant.allowedConnections!.includes(rawConnectionId) || !policy.evaluateConnection(rawConnectionId).allowed)) throw fail("read_gate_runtime_policy_denied");
  };
  if (pathname === "/v1/shiba/read-gate/attest-googleads") {
    try {
      if (!enabled || !env.CF_VERSION_METADATA || !/^[a-f0-9-]{36}$/.test(env.CF_VERSION_METADATA.id) || !/^[a-f0-9]{40}$/.test(env.CF_VERSION_METADATA.tag) || request.method !== "POST" || new URL(request.url).search || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw fail();
      const body = object(JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(await boundedBody(request.body, 8192))));
      if (Object.keys(body).sort().join(",") !== "alias,authorizationFingerprint,capabilities,manifestDigest,providerConnectionId,versionId" || typeof body.alias !== "string" || !/^w_[a-f0-9]{32}$/.test(body.alias) || typeof body.providerConnectionId !== "string" || !/^ocg_[a-f0-9]{64}$/.test(body.providerConnectionId) || typeof body.authorizationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.authorizationFingerprint) || body.versionId !== env.CF_VERSION_METADATA.id || body.manifestDigest !== await hash(await readGatewayManifest())) throw fail();
      const caps=object(body.capabilities);if(Object.keys(caps).sort().join(",")!=="claim,complete" || typeof caps.claim!=="string" || typeof caps.complete!=="string")throw fail();
      const bound={alias:body.alias,providerConnectionId:body.providerConnectionId,authorizationFingerprint:body.authorizationFingerprint,versionId:body.versionId as string,manifestDigest:body.manifestDigest as string};
      const requestDigest=await hash(bound);
      await verifyRuntime(request,"googleads.campaign_daily_metrics");
      const callback=async(stage:"attest_claim"|"attest_complete",capability:string)=>{
        const result=await env.SHIBA_AUTOMATIC_AUTHORITY!.fetch("https://shiba-authority.internal/internal/founder-automatic-read/permit",{method:"POST",headers:{"content-type":"application/json"},redirect:"manual",body:JSON.stringify({stage,capability,requestDigest}),signal:AbortSignal.timeout(5000)});
        if(!result.ok)throw fail();
        const response=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(result.body,1024))));if(response.ok!==true)throw fail();
      };
      await callback("attest_claim",caps.claim);
      const input={...bound,operationId:"googleads.campaign_daily_metrics"} as ReadRequest;
      const credential=oauth(await (await getContext()).getConnection("googleads",bound.alias),input);
      if (`ocg_${await digest(JSON.stringify([bound.alias,"googleads",credential.rawConnectionId,credential.consentId]))}`!==bound.providerConnectionId || await digest(JSON.stringify([bound.alias,"googleads",credential.consentId]))!==bound.authorizationFingerprint)throw fail();
      await verifyRuntime(request,"googleads.campaign_daily_metrics",credential.rawConnectionId);
      const fingerprint=await googleAdsSourceFingerprint(input,credential,env.SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY);
      await callback("attest_complete",caps.complete);
      return Response.json({ok:true,sourceFingerprint:fingerprint},{headers:HEADERS});
    } catch { return Response.json({error:"read_gate_googleads_attestation_unavailable"},{status:403,headers:HEADERS}); }
  }
  const unavailable = { async claim(): Promise<"claimed"> { throw fail("read_gate_authority_unavailable"); }, async commit() { throw fail("read_gate_authority_unavailable"); }, async settle() { throw fail("read_gate_authority_unavailable"); } };
  try {
    return await handleReadGateway(request, { enabled, version: env.CF_VERSION_METADATA, manifest: await readGatewayManifest(), verifyRuntime,
      resolveOAuth: async (input) => {
        const credential=oauth(await (await getContext()).getConnection(input.operationId.split(".")[0]!, input.alias), input);
        if(input.operationId==="googleads.campaign_daily_metrics")credential.sourceFingerprint=await googleAdsSourceFingerprint(input,credential,env.SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY);
        return credential;
      },
      attempts: env.SHIBA_AUTOMATIC_AUTHORITY ? callbackAttempts(env.SHIBA_AUTOMATIC_AUTHORITY) : unavailable, manualFetch });
  } catch { return Response.json({ error: "read_gate_adapter_unavailable" }, { status: 503, headers: HEADERS }); }
}

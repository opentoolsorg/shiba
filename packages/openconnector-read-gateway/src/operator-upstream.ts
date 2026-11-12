import { OPERATOR_ACTION, OperatorGateError, type OperatorExecutionEnvelope } from "./operator-envelope.js";
import { prepareOperatorFigmaRequest, type OperatorLocalRow } from "./operator-provider.js";
import type { CoordinatedD1 } from "./coordinated-owner.js";
import type { OperatorGatewayDependencies } from "./operator-gateway.js";
import type { PinnedReadGatewayEnv, PinnedUpstreamModules } from "./upstream-adapter.js";

/** Pinned actual storage/codec/policy APIs; the caller supplies ONLY the permanent coordinated DB facade. */
export function operatorUpstreamCapture(database: CoordinatedD1, env: PinnedReadGatewayEnv<CoordinatedD1>, modules: PinnedUpstreamModules<CoordinatedD1>, transport: typeof fetch = fetch): OperatorGatewayDependencies["capture"] {
  return async (input: OperatorExecutionEnvelope, token: string) => {
    if (!env.OOMOL_CONNECT_ENCRYPTION_KEY?.trim()) throw new OperatorGateError("operator_encrypted_storage_required");
    const codec = await modules.createWorkerSecretCodec(env.OOMOL_CONNECT_ENCRYPTION_KEY);
    if (!codec.encrypted) throw new OperatorGateError("operator_encrypted_storage_required");
    const context = modules.createReadContext(database, { encrypted: true, encode: value => codec.encode(value), decode: value => {
      if (!value.startsWith("enc:worker:v1:")) throw new OperatorGateError("operator_encrypted_storage_required"); return codec.decode(value);
    } });
    const grant = await context.resolveRuntimeToken(token);
    if (!grant?.tokenId || grant.allowedActions.length !== 1 || grant.allowedActions[0] !== OPERATOR_ACTION || grant.allowedConnections?.length !== 1 || grant.allowedConnections[0] !== input.rawConnectionId ||
      grant.allowedProxies.length || grant.allowedTriggers?.length) throw new OperatorGateError("operator_scoped_runtime_required");
    const runtime = await context.getRuntimePolicy();
    const deployment = {
      allowedActions: modules.parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_ACTIONS), blockedActions: modules.parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_ACTIONS),
      allowedProxies: modules.parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_PROXIES), blockedProxies: modules.parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_PROXIES),
      allowedTriggers: modules.parseActionPolicyList(env.OOMOL_CONNECT_ALLOWED_TRIGGERS), blockedTriggers: modules.parseActionPolicyList(env.OOMOL_CONNECT_BLOCKED_TRIGGERS),
    };
    const policy = modules.createPolicy(deployment, runtime?.rules ?? modules.emptyPolicyRules(), grant, runtime?.updatedAt);
    if (!policy.evaluate({ id: OPERATOR_ACTION }).allowed || !policy.evaluateConnection(input.rawConnectionId).allowed) throw new OperatorGateError("operator_runtime_policy_denied");
    // Explicit source proof is required: native get() intentionally omits source='local'.
    const row = await database.prepare("SELECT id,revision,service,connection_name,source,value FROM connections WHERE service=? AND connection_name=?").bind(input.provider, input.personalAlias).first<OperatorLocalRow>();
    const stored = await context.getConnection(input.provider, input.personalAlias);
    return { request: prepareOperatorFigmaRequest(input, row, stored, transport), tokenExpiresAt: Number.MAX_SAFE_INTEGER };
  };
}

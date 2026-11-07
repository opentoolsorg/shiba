import { abortable, boundedBody } from "./json.js";
import { OperatorGateError, operatorRecord, parseOperatorJson, type OperatorExecutionEnvelope } from "./operator-envelope.js";
import type { OperatorReceipt } from "./operator-store.js";
import type { UpstreamStoredConnection } from "./upstream-adapter.js";

/** Must come from an exact SELECT of the encrypted row, not caller metadata or omitted source defaults. */
export interface OperatorLocalRow { id: string; revision: string; service: string; connection_name: string; source: string; value: string }
export interface PreparedOperatorRequest {
  send(signal: AbortSignal): Promise<Response>;
  project(response: Response, signal: AbortSignal): Promise<NonNullable<OperatorReceipt["result"]>>;
}
/** Only one non-mutating, fixed-host operation is reviewed. This is never the native generic action runner. */
export function prepareOperatorFigmaRequest(input: OperatorExecutionEnvelope, row: OperatorLocalRow | null, stored: UpstreamStoredConnection | undefined, transport: typeof fetch = fetch): PreparedOperatorRequest {
  if (row?.source !== "local" || !row.value.startsWith("enc:worker:v1:") || row.id !== input.rawConnectionId || row.revision !== input.upstreamRevision ||
    row.service !== "figma" || row.connection_name !== input.personalAlias || !stored || stored.source === "saas" || stored.id !== row.id || stored.revision !== row.revision || stored.service !== row.service || stored.connectionName !== row.connection_name) throw new OperatorGateError("operator_account_unavailable");
  const credential = operatorRecord(stored.credential), values = operatorRecord(credential.values);
  if (credential.authType !== "api_key" || typeof credential.apiKey !== "string" || !/^[A-Za-z0-9_.-]{16,1024}$/.test(credential.apiKey) || values.apiKey !== credential.apiKey || Object.keys(values).some(key => key !== "apiKey")) throw new OperatorGateError("operator_account_unavailable");
  const apiKey = credential.apiKey;
  const request = new Request(`https://api.figma.com/v1/files/${input.arguments.fileKey}/meta`, {
    method: "GET", redirect: "manual", headers: { "X-Figma-Token": apiKey, accept: "application/json" },
  });
  let used = false;
  return {
    send(signal) {
      if (used) throw new OperatorGateError("operator_dispatch_already_started", 409);
      used = true;
      // No await, credential lookup or provider retry between owner's last fence and fetch invocation.
      return transport(request, { signal });
    },
    async project(response, signal) {
      // HTTP errors, redirects and parse/limit failures all remain uncertain, never re-dispatched.
      if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new OperatorGateError("operator_provider_response_invalid", 502);
      const bytes = await abortable(boundedBody(response.body, input.maxBytes, signal), signal);
      const value = operatorRecord(parseOperatorJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), metadata = operatorRecord(value.file ?? value.metadata);
      // Figma /meta uses file.name and file.last_touched_at. Never return arbitrary upstream fields.
      if (typeof metadata.name !== "string" || metadata.name.length > 500 || typeof metadata.last_touched_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(metadata.last_touched_at) || !Number.isFinite(Date.parse(metadata.last_touched_at))) throw new OperatorGateError("operator_provider_response_invalid", 502);
      return { name: metadata.name.split(apiKey).join("[REDACTED]"), lastTouchedAt: new Date(metadata.last_touched_at).toISOString() };
    },
  };
}

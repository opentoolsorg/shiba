import { digest, hash } from "./json.js";

export class OperatorGateError extends Error {
  constructor(readonly code: string, readonly status = 403) { super(code); }
}
export const OPERATOR_ACTION = "figma.get_file_metadata" as const;
export const OPERATOR_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["fileKey"],
  properties: { fileKey: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" } },
} as const;
export interface OperatorExecutionEnvelope {
  format: "shiba.operator-execute.v1";
  invocationId: string; approvalId: string; requestDigest: string;
  enrollmentId: string; enrollmentGeneration: number; connectionId: string;
  ownerId: string; personalAlias: string; provider: "figma"; rawConnectionId: string; upstreamRevision: string;
  deploymentEpoch: string; versionId: string; manifestDigest: string;
  principalId: string; employeeId: string; employeeVersion: number; executionContextId: string;
  grantVersions: Array<{ kind: "actor_grant" | "resource_grant" | "role_grant"; id: string; version: number }>;
  actionId: typeof OPERATOR_ACTION; inputSchemaHash: string;
  arguments: { fileKey: string }; argumentDigest: string;
  expiresAt: number; maxDurationMs: number; maxBytes: number;
}
const invalid = () => new OperatorGateError("operator_request_invalid", 400);
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@/-]{1,200}$/;
export function operatorRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function operatorExact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function text(value: unknown, pattern = ID): string { if (typeof value !== "string" || !pattern.test(value)) throw invalid(); return value; }
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw invalid(); return Number(value);
}

/** A bounded JSON grammar, rather than JSON.parse's last-key-wins authority interpretation. */
export function parseOperatorJson(source: string): unknown {
  if (new TextEncoder().encode(source).length > 65536) throw invalid();
  let at = 0, nodes = 0;
  const whitespace = () => { while (/^[\t\n\r ]$/.test(source[at] ?? "")) at++; };
  const string = (): string => {
    const start = at++; let escaped = false;
    while (at < source.length) {
      const char = source[at++];
      if (!escaped && char === '"') {
        const result = JSON.parse(source.slice(start, at)) as string;
        for (let i = 0; i < result.length; i++) {
          const point = result.charCodeAt(i);
          if (point >= 0xd800 && point <= 0xdbff) { const next = result.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid(); }
          else if (point >= 0xdc00 && point <= 0xdfff) throw invalid();
        }
        return result;
      }
      if (!escaped && char === "\\") escaped = true; else escaped = false;
    }
    throw invalid();
  };
  const value = (depth: number): unknown => {
    whitespace(); if (depth > 16 || ++nodes > 2048) throw invalid();
    const char = source[at];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      at++; whitespace(); const object = char === "{";
      const result: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      if (source[at] === (object ? "}" : "]")) { at++; return result; }
      for (;;) {
        whitespace();
        if (object) {
          if (source[at] !== '"') throw invalid(); const key = string();
          if (Object.hasOwn(result, key) || ["__proto__", "prototype", "constructor"].includes(key)) throw invalid();
          whitespace(); if (source[at++] !== ":") throw invalid();
          (result as Record<string, unknown>)[key] = value(depth + 1);
        } else (result as unknown[]).push(value(depth + 1));
        whitespace(); const separator = source[at++];
        if (separator === (object ? "}" : "]")) return result;
        if (separator !== ",") throw invalid();
      }
    }
    const match = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    if (!match) throw invalid(); at += match[0].length;
    const result: unknown = JSON.parse(match[0]); if (typeof result === "number" && !Number.isFinite(result)) throw invalid(); return result;
  };
  try { const result = value(0); whitespace(); if (at !== source.length) throw invalid(); return result; }
  catch { throw invalid(); }
}

/** No capabilities, signatures or credential-derived material enter the digest or stored envelope. */
export async function operatorRequestDigest(input: OperatorExecutionEnvelope): Promise<string> {
  const { requestDigest: _, ...bound } = input;
  return hash(["shiba.operator-execute.digest.v1", bound]);
}
export async function parseOperatorEnvelope(value: unknown): Promise<OperatorExecutionEnvelope> {
  const r = operatorRecord(value);
  operatorExact(r, ["format", "invocationId", "approvalId", "requestDigest", "enrollmentId", "enrollmentGeneration", "connectionId", "ownerId", "personalAlias", "provider", "rawConnectionId", "upstreamRevision", "deploymentEpoch", "versionId", "manifestDigest", "principalId", "employeeId", "employeeVersion", "executionContextId", "grantVersions", "actionId", "inputSchemaHash", "arguments", "argumentDigest", "expiresAt", "maxDurationMs", "maxBytes"]);
  if (r.format !== "shiba.operator-execute.v1" || r.provider !== "figma" || r.actionId !== OPERATOR_ACTION) throw invalid();
  const args = operatorRecord(r.arguments); operatorExact(args, ["fileKey"]);
  if (!Array.isArray(r.grantVersions) || !r.grantVersions.length || r.grantVersions.length > 20) throw invalid();
  const grants = r.grantVersions.map(item => { const grant = operatorRecord(item); operatorExact(grant, ["kind", "id", "version"]); if (!["actor_grant", "resource_grant", "role_grant"].includes(String(grant.kind))) throw invalid(); return { kind: grant.kind as OperatorExecutionEnvelope["grantVersions"][number]["kind"], id: text(grant.id), version: integer(grant.version, 1, Number.MAX_SAFE_INTEGER) }; });
  if (grants.some((grant, i) => { const prior = grants[i - 1]; return prior !== undefined && `${prior.kind}:${prior.id}` >= `${grant.kind}:${grant.id}`; })) throw invalid();
  const result: OperatorExecutionEnvelope = {
    format: "shiba.operator-execute.v1", invocationId: text(r.invocationId), approvalId: text(r.approvalId), requestDigest: text(r.requestDigest, HEX),
    enrollmentId: text(r.enrollmentId), enrollmentGeneration: integer(r.enrollmentGeneration, 1, Number.MAX_SAFE_INTEGER), connectionId: text(r.connectionId, /^oco_[a-f0-9]{64}$/),
    ownerId: text(r.ownerId), personalAlias: text(r.personalAlias, /^u_[a-f0-9]{16}$/), provider: "figma", rawConnectionId: text(r.rawConnectionId), upstreamRevision: text(r.upstreamRevision),
    deploymentEpoch: text(r.deploymentEpoch), versionId: text(r.versionId, /^[a-f0-9-]{36}$/), manifestDigest: text(r.manifestDigest, HEX),
    principalId: text(r.principalId), employeeId: text(r.employeeId), employeeVersion: integer(r.employeeVersion, 1, Number.MAX_SAFE_INTEGER), executionContextId: text(r.executionContextId),
    grantVersions: grants, actionId: OPERATOR_ACTION, inputSchemaHash: text(r.inputSchemaHash, HEX), arguments: { fileKey: text(args.fileKey, /^[A-Za-z0-9_-]{1,200}$/) }, argumentDigest: text(r.argumentDigest, HEX),
    expiresAt: integer(r.expiresAt, 1, Number.MAX_SAFE_INTEGER), maxDurationMs: integer(r.maxDurationMs, 100, 10000), maxBytes: integer(r.maxBytes, 1024, 32768),
  };
  if (result.personalAlias !== `u_${(await digest(result.ownerId)).slice(0, 16)}` || result.argumentDigest !== await hash(result.arguments) ||
    result.inputSchemaHash !== await hash(OPERATOR_INPUT_SCHEMA) || result.requestDigest !== await operatorRequestDigest(result)) throw invalid();
  return result;
}

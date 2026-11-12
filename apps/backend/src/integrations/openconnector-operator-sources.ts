/**
 * Private, synchronous source registry for the parent authority's own SQLite
 * transaction. IDs denote non-secret instances, never labels, token hashes,
 * credentials or review-only enrollment records. No legacy backfill.
 */
import { operatorExact, operatorRecord } from "@shiba/openconnector-read-gateway";
import type { OperatorAuthorityRecord, OperatorAuthorityReference, OperatorAuthoritySql } from "./openconnector-operator-authority.js";

export type OperatorLegacySource = (
  | { kind: "connector_account"; storeId: string; personalAlias: string; provider: string }
  | { kind: "principal_token"; namespaceId: string; tokenInstanceId: string }
  | { kind: "employee_definition" | "employee_grants"; workspaceId: string; employeeId: string }
  | { kind: "session"; ownerId: string; sessionId: string }
  | { kind: "run"; ownerId: string; runId: string }
);
export interface OperatorSourceReference { source: OperatorLegacySource; generation: number }
export interface OperatorSourceRegistration extends OperatorSourceReference { revision: string; rawConnectionId?: string }
export interface OperatorSourceSnapshot extends OperatorSourceRegistration {
  state: "active" | "changing"; revocationId: string | null;
}
type SourceRow = Record<string, unknown> & { generation: number; revision: string; raw_connection_id: string | null; state: "active" | "changing"; revocation_id: string | null };
type LinkRow = Record<string, unknown> & { source_key: string; generation: number };
const FORMAT = "shiba.operator-source-registry.v1";
const invalid = () => new Error("operator_source_registry_invalid");
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(v);
const generation = (v: number) => Number.isSafeInteger(v) && v > 0;

function source(value: OperatorLegacySource): OperatorLegacySource {
  const input = structuredClone(value), row = operatorRecord(input);
  const fields = ["kind"];
  switch (input.kind) {
    case "connector_account": fields.push("storeId", "personalAlias", "provider"); break;
    case "principal_token": fields.push("namespaceId", "tokenInstanceId"); break;
    case "employee_definition": case "employee_grants": fields.push("workspaceId", "employeeId"); break;
    case "session": fields.push("ownerId", "sessionId"); break;
    case "run": fields.push("ownerId", "runId"); break;
    default: throw invalid();
  }
  operatorExact(row, fields);
  if (!Object.values(row).every(id)) throw invalid();
  if (input.kind === "connector_account" && !/^u_[a-f0-9]{16}$/.test(input.personalAlias)) throw invalid();
  return Object.fromEntries(fields.map(field => [field, row[field]])) as OperatorLegacySource;
}
export function operatorSourceReferences(input: OperatorSourceReference[]): OperatorSourceReference[] {
  if (!Array.isArray(input) || !input.length || input.length > 32) throw invalid();
  const refs = input.map(value => {
    operatorExact(operatorRecord(value), ["source", "generation"]);
    if (!generation(value.generation)) throw invalid();
    return { source: source(value.source), generation: value.generation };
  }).sort((a, b) => key(a.source).localeCompare(key(b.source)));
  if (new Set(refs.map(ref => key(ref.source))).size !== refs.length) throw invalid();
  return refs;
}
const key = (value: OperatorLegacySource) => JSON.stringify(value);

/** Only the parent calls these methods, inside its synchronous transaction. */
export class OperatorAuthoritySourceRegistry {
  constructor(private readonly sql: OperatorAuthoritySql) {
    sql.exec("CREATE TABLE IF NOT EXISTS operator_source_registry_meta (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_legacy_sources (
      source_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision TEXT NOT NULL, raw_connection_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('active','changing')), revocation_id TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_authority_sources (
      kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
      source_key TEXT NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY(kind,id,version,source_key))`);
    sql.exec("CREATE INDEX IF NOT EXISTS operator_authority_sources_lookup ON operator_authority_sources(source_key,generation)");
    // An old populated prototype is NOT a trusted registry snapshot. A new
    // drained epoch must build authority afresh; never infer its old links.
    const empty = ["operator_parent_authority", "operator_parent_approvals", "operator_parent_admissions",
      "operator_parent_revocations", "operator_parent_source_mutations", "operator_legacy_sources", "operator_authority_sources"]
      .every(table => !sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length);
    if (!this.initialized() && empty && !sql.exec("SELECT 1 FROM operator_source_registry_meta LIMIT 1").toArray().length) {
      sql.exec("INSERT INTO operator_source_registry_meta(id,format) VALUES(1,?)", FORMAT);
    }
  }
  initialized(): boolean {
    return this.sql.exec("SELECT format FROM operator_source_registry_meta WHERE id=1").toArray()[0]?.format === FORMAT;
  }
  lookup(input: OperatorLegacySource): OperatorSourceSnapshot | null {
    if (!this.initialized()) throw invalid();
    const identity = source(input), row = this.row(key(identity));
    return row ? { source: identity, generation: row.generation, revision: row.revision,
      state: row.state, revocationId: row.revocation_id,
      ...(row.raw_connection_id !== null ? { rawConnectionId: row.raw_connection_id } : {}) } : null;
  }
  register(input: OperatorSourceRegistration): void {
    operatorExact(operatorRecord(input), ["source", "generation", "revision", ...(input.source?.kind === "connector_account" ? ["rawConnectionId"] : [])]);
    const ref = operatorSourceReferences([{ source: input.source, generation: input.generation }])[0];
    if (!ref || !this.initialized() || ref.generation !== 1 || !id(input.revision)
      || (input.source.kind === "connector_account" && !id(input.rawConnectionId))) throw invalid();
    this.sql.exec("INSERT INTO operator_legacy_sources(source_key,generation,revision,raw_connection_id,state) VALUES(?,?,?,?,'active')", key(ref.source), 1, input.revision, input.rawConnectionId ?? null);
  }
  advance(input: OperatorSourceRegistration, previousGeneration: number): void {
    operatorExact(operatorRecord(input), ["source", "generation", "revision", ...(input.source?.kind === "connector_account" ? ["rawConnectionId"] : [])]);
    const ref = operatorSourceReferences([{ source: input.source, generation: input.generation }])[0];
    if (!ref || !this.initialized() || !generation(previousGeneration) || ref.generation !== previousGeneration + 1 || !id(input.revision)
      || (input.source.kind === "connector_account" && !id(input.rawConnectionId))) throw invalid();
    const row = this.row(key(ref.source));
    if (row?.generation !== previousGeneration || row.state !== "changing" || !row.revocation_id
      || this.sql.exec("SELECT status FROM operator_parent_revocations WHERE revocation_id=?", row.revocation_id).toArray()[0]?.status !== "complete") throw invalid();
    this.sql.exec("UPDATE operator_legacy_sources SET generation=?,revision=?,raw_connection_id=?,state='active',revocation_id=NULL WHERE source_key=?",
      ref.generation, input.revision, input.rawConnectionId ?? null, key(ref.source));
  }
  bind(record: OperatorAuthorityRecord, refs: OperatorSourceReference[]): void {
    if (!this.initialized()) throw invalid();
    const expected = record.kind === "enrollment" ? ["connector_account"]
      : record.kind === "employee" ? ["employee_definition"] : record.kind === "principal" ? ["principal_token"]
        : record.kind === "execution_context" ? ["run", "session"] : ["employee_grants"];
    if (refs.length !== expected.length || !expected.every(kind => refs.some(ref => ref.source.kind === kind))) throw invalid();
    for (const ref of refs) {
      const s = ref.source, row = this.row(key(s));
      if (!row || row.generation !== ref.generation || row.state !== "active"
        || ((s.kind === "session" || s.kind === "run") && s.ownerId !== record.ownerId)) throw invalid();
      if (s.kind === "connector_account" && (record.kind !== "enrollment" || row.revision !== record.upstreamRevision
        || s.personalAlias !== record.personalAlias
        || s.provider !== record.provider || row.raw_connection_id !== record.rawConnectionId)) throw invalid();
      if (s.kind === "principal_token" && (record.kind !== "principal" || s.tokenInstanceId !== record.id)) throw invalid();
      if (s.kind === "employee_definition" && (record.kind !== "employee" || s.employeeId !== record.id)) throw invalid();
      if (s.kind === "employee_grants" && (!("employeeId" in record) || s.employeeId !== record.employeeId)) throw invalid();
      this.sql.exec("INSERT INTO operator_authority_sources(kind,id,version,source_key,generation) VALUES(?,?,?,?,?)",
        record.kind, record.id, record.version, key(s), ref.generation);
    }
  }
  current(ref: OperatorAuthorityReference): boolean {
    if (!this.initialized()) return false;
    const links = this.sql.exec<LinkRow>("SELECT source_key,generation FROM operator_authority_sources WHERE kind=? AND id=? AND version=?", ref.kind, ref.id, ref.version).toArray();
    if (links.length !== (ref.kind === "execution_context" ? 2 : 1)) return false;
    return links.every(link => {
      const row = this.row(link.source_key);
      return row?.state === "active" && row.generation === link.generation;
    });
  }
  /** Resolve ALL current dependencies, then block even a previously unused source. */
  claim(refs: OperatorSourceReference[], revocationId: string): OperatorAuthorityReference[] {
    if (!this.initialized()) throw invalid();
    const found = new Map<string, OperatorAuthorityReference>();
    for (const ref of refs) {
      const sourceKey = key(ref.source), row = this.row(sourceKey);
      if (!row || row.generation !== ref.generation || row.state !== "active") throw invalid();
      const links = this.sql.exec<Record<string, unknown> & OperatorAuthorityReference>(`SELECT a.kind,a.id,a.version FROM operator_authority_sources l
        JOIN operator_parent_authority a ON a.kind=l.kind AND a.id=l.id AND a.version=l.version
        WHERE l.source_key=? AND l.generation=?`, sourceKey, ref.generation).toArray();
      for (const link of links) found.set(JSON.stringify([link.kind, link.id]), { kind: link.kind, id: link.id, version: link.version });
      this.sql.exec("UPDATE operator_legacy_sources SET state='changing',revocation_id=? WHERE source_key=?", revocationId, sourceKey);
    }
    return [...found.values()].sort((a, b) => JSON.stringify([a.kind, a.id]).localeCompare(JSON.stringify([b.kind, b.id])));
  }
  private row(sourceKey: string): SourceRow | undefined {
    return this.sql.exec<SourceRow>("SELECT generation,revision,raw_connection_id,state,revocation_id FROM operator_legacy_sources WHERE source_key=?", sourceKey).toArray()[0];
  }
}

/** Constant SQL for hash-bound founder occurrence scopes. No provider calls or HTTP-supplied SQL. */
import { getFounderSkillLibraryEntry } from "@shiba/shared";
import { hashToolArgs } from "./mcp-gateway.js";

export interface FounderConnectorActionContext {
  kind: "founder-connector-occurrence.v1";
  libraryId: string;
  planId: string;
  planVersion: number;
  planDigest: string;
  occurrenceId: string;
  occurrenceDigest: string;
  requestId: string;
  expiresAt: number;
}
export const FOUNDER_SQL_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export async function founderConnectorRecipeHash(libraryId: string): Promise<string | null> {
  const entry = getFounderSkillLibraryEntry(libraryId);
  return entry ? hashToolArgs(entry) : null;
}

/** Expressions are fixed call-site SQL, never wire data. Values live in the JSON bindings. */
export function founderConnectorContextPredicate(expressions: {
  context: string; binding: string; approvalId: string; recipeHash: string;
}): string {
  const c = (path: string) => `json_extract(fc.context,'$.${path}')`;
  const b = (path: string) => `json_extract(fc.binding,'$.${path}')`;
  return `EXISTS (SELECT 1 FROM (SELECT ${expressions.context} AS context,${expressions.binding} AS binding,${expressions.approvalId} AS approval_id,${expressions.recipeHash} AS recipe_hash) fc
    JOIN founder_connector_jobs j ON j.id=${c("planId")} AND j.version=${c("planVersion")} AND j.digest=${c("planDigest")}
      AND j.state='enabled' AND j.library_id=${c("libraryId")} AND j.recipe_sha256=fc.recipe_hash AND j.expires_at>${FOUNDER_SQL_NOW}
      AND j.workspace_id=${b("workspaceId")} AND j.owner_id=${b("actorId")} AND j.owner_account_id=${b("actorAccountId")}
      AND j.member_version=${b("actorVersion")} AND j.member_role=${b("actorRole")}
      AND j.binding_json=json_remove(fc.binding,'$.founderContext')
    JOIN founder_connector_occurrences o ON o.id=${c("occurrenceId")} AND o.plan_id=j.id AND o.plan_version=j.version
      AND o.digest=${c("occurrenceDigest")} AND o.request_id=${c("requestId")} AND o.expires_at=${c("expiresAt")}
      AND o.expires_at>${FOUNDER_SQL_NOW} AND o.scheduled_at<=${FOUNDER_SQL_NOW} AND o.state='open' AND (o.approval_id IS NULL OR o.approval_id=fc.approval_id)
    JOIN skills s ON s.id=json_extract(j.contract_json,'$.skillId') AND s.org_id='team:'||j.workspace_id AND s.owner_id=j.owner_id
      AND s.version=json_extract(j.contract_json,'$.skillVersion') AND s.status='active' AND s.active_version=s.version AND s.reviewed_version=s.version
    JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.version AND v.org_id=s.org_id AND v.owner_id=s.owner_id
      AND v.instructions=json_extract(j.source_json,'$.skillInstructions') AND s.reviewed_instructions=v.instructions
      AND v.source_url IS json_extract(j.source_json,'$.skillSource')
    JOIN skill_installs i ON i.org_id=s.org_id AND i.installed_by=j.owner_id AND i.library_slug=j.library_id AND i.skill_id=s.id
    JOIN org_custom_agents e ON e.id=json_extract(j.contract_json,'$.employeeId') AND e.org_id=s.org_id
      AND e.version=json_extract(j.contract_json,'$.employeeVersion') AND e.config_json=json_extract(j.source_json,'$.employeeConfig')
      AND e.deleted_at IS NULL AND e.archived_at IS NULL
    WHERE ${c("kind")}='founder-connector-occurrence.v1')`;
}

export async function founderConnectorActionGuard(binding: { founderContext?: FounderConnectorActionContext }, approvalId: string): Promise<{ sql: string; values: unknown[] }> {
  if (!binding.founderContext) return { sql: "1=1", values: [] };
  const recipe = await founderConnectorRecipeHash(binding.founderContext.libraryId);
  return { sql: founderConnectorContextPredicate({ context: "?", binding: "?", approvalId: "?", recipeHash: "?" }),
    values: [JSON.stringify(binding.founderContext), JSON.stringify(binding), approvalId, recipe] };
}

import { z } from "zod";
import { founderSkillIdSchema } from "./founder-skill-library.js";
import { workspaceIntegrationConnectionSchema } from "./workspace-integrations.js";
import { stableHash } from "./approvals.js";
const id=z.string().min(1).max(200),version=z.number().int().positive(),digest=z.string().regex(/^[a-f0-9]{64}$/),workspace=z.string().regex(/^ws_[a-f0-9]{24}$/);
/** New explicit contracts only; existing absolute expiries are never extended. */
export const FOUNDER_AUTOMATIC_READ_MAX_LIFETIME_MS=28*86400000;
export const founderAutomaticOperationIdSchema=z.enum(["figma.get_file_metadata","figma.list_comments","linear.list_issues_by_team_id","github.list_pull_requests","googleads.campaign_daily_metrics"]);
const timezone=z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat("en-US",{timeZone:v});return v.trim()===v;}catch{return false;}});
const variables=z.union([
  z.strictObject({customerId:z.string().regex(/^\d{10}$/),loginCustomerId:z.string().regex(/^\d{10}$/),startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}),
  z.strictObject({fileKey:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}),
  z.strictObject({team_id:id,first:z.number().int().min(1).max(25),include_archived:z.boolean()}),
  z.strictObject({owner:z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,200}$/),repo:z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,200}$/),perPage:z.number().int().min(1).max(25),state:z.enum(["open","closed","all"])}),
]);
const cadence={cadence:z.enum(["daily","weekly"]),localTime:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5][05]$/),weekday:z.number().int().min(0).max(6).optional(),timezone,expiresAt:z.number().int().positive()};
const budgets={maxOccurrences:z.number().int().min(1).max(7),maxCalls:z.number().int().min(1).max(56),maxCapturedBytes:z.number().int().min(1024).max(458752),maxBytesPerOccurrence:z.number().int().min(8192).max(65536)};
export const founderAutomaticReadInputSchema=z.strictObject({employeeId:id,employeeVersion:version,skillId:id,skillVersion:version,
  operations:z.array(z.strictObject({connectionId:id,connectionVersion:version,operationId:founderAutomaticOperationIdSchema,arguments:variables})).min(1).max(8),
  ...cadence,...budgets,expectedVersion:z.number().int().nonnegative(),
}).refine(v=>v.cadence==="weekly"?v.weekday!==undefined:v.weekday===undefined);
export type FounderAutomaticReadInput=z.infer<typeof founderAutomaticReadInputSchema>;
const runtime=z.object({versionId:z.string().regex(/^[a-f0-9-]{36}$/),versionTag:z.string().regex(/^[a-f0-9]{40}$/),manifestDigest:digest,buildDigest:digest,upstreamRevision:z.string().regex(/^[a-f0-9]{40}$/)});
export const founderAutomaticReadContractSchema=z.object({format:z.literal("shiba.automatic-read.v1"),workspaceId:workspace,ownerId:z.string().min(1).max(320),ownerAccountId:id,
  employeeId:id,employeeVersion:version,employeeName:z.string().max(200),skillId:id,skillVersion:version,skillName:z.string().max(200),recipeSha256:digest,runtime,
  operations:z.array(z.object({connectionId:id,connectionVersion:version,providerKey:z.enum(["figma","linear","github","googleads"]),identityLabel:z.string().nullable(),operationId:founderAutomaticOperationIdSchema,arguments:variables,sourceFingerprint:digest.optional(),runtimeKeyFingerprint:digest.optional(),
    inputSchemaHash:digest,executorHash:digest,queryHash:digest.nullable(),maxBytes:z.number().int().min(1024).max(32768),maxPages:z.literal(1)})).min(1).max(8),
  ...cadence,...budgets,cron:z.string().max(100),maxStepMs:z.literal(5000),maxOccurrenceMs:z.literal(60000),principal:z.object({kind:z.literal("schedule"),id}),model:z.null(),destination:z.literal("private-dashboard"),
});
export type FounderAutomaticReadContract=z.infer<typeof founderAutomaticReadContractSchema>;
export const founderAutomaticReadDecisionSchema=z.strictObject({expectedVersion:version,digest,reviewed:z.literal(true),
  readConsent:z.literal("allow-exact-scheduled-read-operations-and-bounded-provider-calls").optional(),quotaConsent:z.literal("provider-requests-may-use-account-quota-or-incur-charges").optional()});
export const founderAutomaticReadGrantSchema=z.object({id,version,digest,state:z.enum(["draft","enabled","paused","revoked","blocked","exhausted"]),contract:founderAutomaticReadContractSchema,
  reviewExpiresAt:z.number(),nextDueAt:z.number(),usedOccurrences:z.number().int().nonnegative(),reservedCalls:z.number().int().nonnegative(),reservedBytes:z.number().int().nonnegative(),blockedReason:z.string().nullable(),
  canEnable:z.boolean(),canPause:z.boolean(),canResume:z.boolean(),canRevoke:z.boolean()});
export type FounderAutomaticReadGrant=z.infer<typeof founderAutomaticReadGrantSchema>;
export const founderAutomaticReadOccurrenceSchema=z.object({id,grantId:id,grantVersion:version,principal:z.object({kind:z.literal("schedule"),id}),scheduledAt:z.number(),expiresAt:z.number(),
  state:z.enum(["pending","claimed","running","completed","partial","failed","unknown","cancelled","blocked"]),stepCount:z.number().int().min(1).max(8),completedSteps:z.number().int().min(0).max(8),canReadReport:z.boolean(),error:z.string().nullable()});
export type FounderAutomaticReadOccurrence=z.infer<typeof founderAutomaticReadOccurrenceSchema>;
const scope={ok:z.literal(true),workspaceId:workspace,libraryId:founderSkillIdSchema,actorId:z.string().min(1).max(320)};
export const founderAutomaticReadStateSchema=z.object({...scope,available:z.boolean(),unavailableReason:z.string().nullable(),canConfigure:z.boolean(),grant:founderAutomaticReadGrantSchema.nullable(),occurrences:z.array(founderAutomaticReadOccurrenceSchema).max(50),
  staleGrant:z.object({id,version,digest,state:founderAutomaticReadGrantSchema.shape.state,canRevoke:z.boolean()}).optional()});
export type FounderAutomaticReadState=z.infer<typeof founderAutomaticReadStateSchema>;
export const founderAutomaticReadOptionsSchema=z.object({...scope,available:z.boolean(),unavailableReason:z.string().nullable(),runtime:runtime.nullable(),employees:z.array(z.object({id,version,name:z.string().max(200)})).max(100),skill:z.object({id,version,name:z.string().max(200)}).nullable(),
  connections:z.array(workspaceIntegrationConnectionSchema).max(50),operations:z.array(z.object({id:founderAutomaticOperationIdSchema,service:z.enum(["figma","linear","github","googleads"]),inputSchema:z.record(z.string(),z.unknown()),inputSchemaHash:digest,executorHash:digest,queryHash:digest.nullable(),maxPages:z.literal(1),maxBytes:z.literal(32768)})).max(5)});
export type FounderAutomaticReadOptions=z.infer<typeof founderAutomaticReadOptionsSchema>;
export const founderAutomaticReadReportSchema=z.object({...scope,id,grantId:id,grantVersion:version,principal:z.object({kind:z.literal("schedule"),id}),reportHash:digest,expiresAt:z.number(),markdown:z.string().max(262144),json:z.string().max(262144),
  sourceKind:z.literal("standing-scheduled-read"),captureCompleteness:z.literal("bounded-response"),datasetCompleteness:z.literal("unknown"),businessSuccess:z.literal("unverified"),canExport:z.literal(false)});
export type FounderAutomaticReadReport=z.infer<typeof founderAutomaticReadReportSchema>;
export function founderAutomaticReadReportHash(value:Pick<FounderAutomaticReadReport,"id"|"grantId"|"grantVersion"|"expiresAt"|"markdown"|"json">){
  return stableHash(["shiba.automatic-read.report.v1",value.id,value.grantId,value.grantVersion,value.expiresAt,value.markdown,value.json]);
}

import { OPERATION_SCHEMAS, LINEAR_TEAM_QUERY, GOOGLE_ADS_QUERY } from "./operations.js";
import { hash, digest } from "./json.js";
import { UPSTREAM_REVISION, type GatewayManifest, type ReadOperationId } from "./types.js";
import { BUILD_DIGEST, EXECUTOR_DIGEST } from "./generated.js";

export async function readGatewayManifest(): Promise<GatewayManifest> {
  const ids=Object.keys(OPERATION_SCHEMAS).sort() as ReadOperationId[];
  return {format:"shiba.read-gate.v1",upstreamRevision:UPSTREAM_REVISION,buildDigest:BUILD_DIGEST,operations:await Promise.all(ids.map(async id=>({
    id,service:id.split(".")[0] as "figma"|"linear"|"github"|"googleads",inputSchema:OPERATION_SCHEMAS[id],inputSchemaHash:await hash(OPERATION_SCHEMAS[id]),executorHash:EXECUTOR_DIGEST,
    method:(id.startsWith("linear.")||id.startsWith("googleads."))?"POST" as const:"GET" as const,origin:id.startsWith("googleads.")?"https://googleads.googleapis.com":id.startsWith("linear.")?"https://api.linear.app":id.startsWith("figma.")?"https://api.figma.com":"https://api.github.com",
    queryHash:id.startsWith("googleads.")?await digest(GOOGLE_ADS_QUERY):id.startsWith("linear.")?await digest(LINEAR_TEAM_QUERY):null,maxPages:1 as const,maxBytes:32768 as const,
  })))};
}

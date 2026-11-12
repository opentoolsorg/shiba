import { hash } from "./json.js";
import { OPERATOR_ACTION, OPERATOR_INPUT_SCHEMA } from "./operator-envelope.js";
import { OPERATOR_SOURCE_HASHES } from "./operator-manifest.generated.js";

/** Honest inventory: reviewed fixture runtime, not a deployed/activated capability attestation. */
export async function operatorGatewayManifest() {
  return {
    format: "shiba.operator-manifest.v1",
    upstreamRevision: "d89dc9f24f5a057bb500272d7dbf333837c77c68",
    provenance: "operator_api_key", activation: "unavailable",
    sourceHashes: OPERATOR_SOURCE_HASHES,
    actions: [{ id: OPERATOR_ACTION, inputSchemaHash: await hash(OPERATOR_INPUT_SCHEMA), executorHash: OPERATOR_SOURCE_HASHES["operator-provider.ts"],
      method: "GET", host: "api.figma.com", pathTemplate: "/v1/files/{fileKey}/meta", responseFields: ["name", "lastTouchedAt"], automaticRetry: false }],
  } as const;
}

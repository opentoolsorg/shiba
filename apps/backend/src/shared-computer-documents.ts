import { sharedComputerInputSchema, sharedComputerVersionSchema } from "@shiba/shared";
import { z } from "zod";
import { hashToolArgs } from "./mcp-gateway.js";
import { computerInputArgv } from "./shared-computer-runtime.js";
import { type ComputerRow, SharedComputerError } from "./shared-computer-store.js";

// Bundled factual summary, not a fetch target or a verbatim RFC reproduction.
const snapshot = Object.freeze({
  documentId: "rfc2606-example-domains-v1",
  sourceUrl: "https://www.rfc-editor.org/rfc/rfc2606.txt",
  title: "Reserved example domains",
  format: "inert-text-snapshot" as const,
  text: "RFC 2606, section 3 (summary)\nThe second-level domain names example.com, example.net and example.org are reserved for use in examples.\nThis bundled summary is not a live page. No source was contacted.",
});
const documentId = z.literal(snapshot.documentId);
export const computerDocumentPreviewSchema = sharedComputerVersionSchema
  .extend({ documentId })
  .strict();
export const computerDocumentImportSchema = sharedComputerInputSchema
  .omit({ action: true })
  .extend({
    documentId,
    documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
  })
  .strict();

export async function computerDocumentPreview(row: ComputerRow) {
  computerInputArgv({ type: "type", text: snapshot.text });
  const documentDigest = await hashToolArgs({
    workspaceId: row.workspace_id,
    sessionId: row.id,
    sessionDigest: row.digest,
    expectedVersion: row.version,
    snapshot,
  });
  return {
    ...snapshot,
    documentDigest,
    expectedVersion: row.version,
    sessionDigest: row.digest,
    notice:
      "Review this exact text before importing. It will be typed at the current desktop focus under your human control lease. No browsing, navigation or agent access is granted.",
  };
}
export async function computerDocumentAction(
  row: ComputerRow,
  input: z.infer<typeof computerDocumentImportSchema>,
) {
  const preview = await computerDocumentPreview(row);
  if (input.documentId !== preview.documentId || input.documentDigest !== preview.documentDigest)
    throw new SharedComputerError("shared_computer_document_changed", 403);
  return { type: "type" as const, text: preview.text };
}

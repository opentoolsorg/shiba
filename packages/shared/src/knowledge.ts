/**
 * Knowledge file and ingestion wire contracts.
 */
import { z } from "zod";

export const knowledgeScopeSchema = z.enum(["personal", "workspace"]);
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;

export const knowledgeSourceKindSchema = z.enum(["file", "note"]);
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>;

export const ingestionStateSchema = z.enum(["pending", "processing", "done", "failed"]);
export type IngestionState = z.infer<typeof ingestionStateSchema>;

export const knowledgeFileSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  scope: knowledgeScopeSchema,
  folderId: z.string().nullable(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  projectId: z.string().nullable(),
  version: z.number().int().positive(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  archivedAt: z.number().int().nullable().optional(),
  ingestion: z.object({
    state: ingestionStateSchema,
    error: z.string().nullable().optional(),
  }),
});
export type KnowledgeFile = z.infer<typeof knowledgeFileSchema>;

/** Queue payload bound as `INGEST_QUEUE`. */
export const ingestQueueMessageSchema = z.object({
  jobId: z.string(),
  sourceKind: knowledgeSourceKindSchema,
  sourceId: z.string(),
  workspaceId: z.string(),
  scope: knowledgeScopeSchema,
  sha256: z.string(),
  version: z.number().int().positive(),
  r2Key: z.string(),
  mime: z.string(),
});
export type IngestQueueMessage = z.infer<typeof ingestQueueMessageSchema>;

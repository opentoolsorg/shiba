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

export const knowledgeNoteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  scope: knowledgeScopeSchema,
  title: z.string(),
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
export type KnowledgeNote = z.infer<typeof knowledgeNoteSchema>;

export const knowledgeSearchHitSchema = z.object({
  chunkId: z.string(),
  sourceKind: knowledgeSourceKindSchema,
  sourceId: z.string(),
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  score: z.number(),
  rank: z.number().int().positive(),
});
export type KnowledgeSearchHit = z.infer<typeof knowledgeSearchHitSchema>;

export const knowledgeSearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(knowledgeSearchHitSchema),
});
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;

/** Tool args the agent catalog registers via `registerKnowledgeSearchTool`. */
export const knowledgeSearchToolArgsSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
});
export type KnowledgeSearchToolArgs = z.infer<typeof knowledgeSearchToolArgsSchema>;

export const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge_search" as const;
export const knowledgeProjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  createdAt: z.number().int(),
});
export type KnowledgeProject = z.infer<typeof knowledgeProjectSchema>;

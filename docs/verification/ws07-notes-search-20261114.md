# WS07 notes and knowledge search (2026-11-14)

Stack order:
1. Files, R2 storage, and the ingestion queue
2. Notes and knowledge search (this change)
3. Projects and the outputs gallery

## Commands

```bash
pnpm -C apps/backend exec tsc -b
pnpm -C apps/backend exec vitest run test/notes-versioning.test.ts test/knowledge-search-rrf.test.ts
```

## Notes

- Notes autosave with `expectedVersion` and enqueue the same ingestion path as files.
- `GET /api/knowledge/search` fuses vector and FTS ranks.
- `registerKnowledgeSearchTool` publishes `knowledge_search` for the agent catalog.

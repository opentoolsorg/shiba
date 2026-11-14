# WS07 projects and outputs (2026-11-14)

Stack order:
1. Files, R2 storage, and the ingestion queue
2. Notes and knowledge search
3. Projects and the outputs gallery (this change)

## Commands

```bash
pnpm -C apps/backend exec tsc -b
```

## Notes

- `knowledge_projects` is appended to migration `0051`. Apply `0051` from this branch so the projects table is included.
- Outputs lists run archive reservations and image files, with download links.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  archiveFile, createFolder, insertFileRecord, listFiles, updateFileDetails,
} from "../src/files/files-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function fixture() {
  const { database, sqlite } = customAgentD1({ bare: true });
  for (const migration of ["0050_files_notes.sql", "0051_knowledge_indexes.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  return { env: { AGENT_AUDIT: database } as unknown as Env, sqlite };
}

async function file(env: Env) {
  return insertFileRecord(env, {
    workspaceId: "ws", scope: "personal", name: "brief.md", mime: "text/markdown",
    size: 12, r2Key: "brief", sha256: "a".repeat(64), createdBy: "alice@example.test",
  });
}

describe("file mutations", () => {
  it("renames, moves, and archives files within their owning scope", async () => {
    const { env, sqlite } = fixture();
    try {
      const folder = await createFolder(env, {
        workspaceId: "ws", scope: "personal", name: "Docs", createdBy: "alice@example.test",
      });
      const record = await file(env);
      const moved = await updateFileDetails(env, record.id, { name: "renamed.md", folderId: folder.id });
      expect(moved).toMatchObject({ name: "renamed.md", folderId: folder.id });
      const rooted = await updateFileDetails(env, record.id, { folderId: null });
      expect(rooted.folderId).toBeNull();
      const archived = await archiveFile(env, record.id);
      expect(archived.archivedAt).toEqual(expect.any(Number));
      expect(await listFiles(env, "ws", "personal", "alice@example.test")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects folders outside the file scope", async () => {
    const { env, sqlite } = fixture();
    try {
      const folder = await createFolder(env, {
        workspaceId: "ws", scope: "workspace", name: "Shared", createdBy: "alice@example.test",
      });
      const record = await file(env);
      await expect(updateFileDetails(env, record.id, { folderId: folder.id })).rejects.toThrow("Folder not found.");
    } finally {
      sqlite.close();
    }
  });
});

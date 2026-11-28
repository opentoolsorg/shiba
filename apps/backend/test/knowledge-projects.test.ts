import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { getFile, insertFileRecord } from "../src/files/files-store.js";
import { canAccessKnowledgeResource } from "../src/knowledge/knowledge-access.js";
import {
  assignProjectResource,
  createProject,
  deleteProject,
  listProjectResources,
  listProjects,
  ProjectStoreError,
  renameProject,
} from "../src/knowledge/knowledge-projects.js";
import { createNote, getNote } from "../src/notes/notes-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function fixture() {
  const { database, sqlite } = customAgentD1({ bare: true });
  for (const migration of ["0050_files_notes.sql", "0051_knowledge_indexes.sql", "0077_knowledge_project_owners.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const objects = new Map<string, Uint8Array>();
  return {
    env: {
      AGENT_AUDIT: database,
      FILES: {
        put: async (key: string, bytes: Uint8Array) => {
          objects.set(key, bytes);
          return {};
        },
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
        },
      },
    } as unknown as Env,
    database,
    sqlite,
  };
}

describe("knowledge projects", () => {
  it("groups files and notes without owning their lifecycle", async () => {
    const { env, database, sqlite } = fixture();
    try {
      const project = await createProject(env, "ws", "Launch plan");
      const file = await insertFileRecord(env, {
        workspaceId: "ws",
        scope: "personal",
        name: "brief.md",
        mime: "text/markdown",
        size: 12,
        r2Key: "brief",
        sha256: "a".repeat(64),
        createdBy: "alice@example.test",
      });
      const note = await createNote(env, {
        workspaceId: "ws",
        scope: "personal",
        title: "Brief notes",
        markdown: "# brief",
        createdBy: "alice@example.test",
      });
      await assignProjectResource(env, {
        workspaceId: "ws",
        resourceKind: "file",
        resourceId: file.id,
        projectId: project.id,
      });
      await assignProjectResource(env, {
        workspaceId: "ws",
        resourceKind: "note",
        resourceId: note.id,
        projectId: project.id,
      });
      expect((await listProjects(env, "ws", "alice@example.test"))[0]).toMatchObject({
        fileCount: 1,
        noteCount: 1,
      });
      const detail = await listProjectResources(env, "ws", "alice@example.test", project.id);
      expect(detail.files.map((item) => item.id)).toEqual([file.id]);
      expect(detail.notes.map((item) => item.id)).toEqual([note.id]);
      expect((await renameProject(env, "ws", project.id, "Launch")).name).toBe("Launch");
      expect(await deleteProject(env, "ws", project.id)).toBe(true);
      expect((await getFile(env, file.id))?.projectId).toBeNull();
      expect((await getNote(env, note.id))?.projectId).toBeNull();
      expect(
        await database
          .prepare(`SELECT COUNT(*) AS count FROM knowledge_projects`)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("rejects cross-workspace assignment", async () => {
    const { env, sqlite } = fixture();
    try {
      const project = await createProject(env, "ws-a", "Private");
      const note = await createNote(env, {
        workspaceId: "ws-b",
        scope: "personal",
        title: "Other",
        markdown: "other",
        createdBy: "alice@example.test",
      });
      await expect(
        assignProjectResource(env, {
          workspaceId: "ws-b",
          resourceKind: "note",
          resourceId: note.id,
          projectId: project.id,
        }),
      ).rejects.toBeInstanceOf(ProjectStoreError);
    } finally {
      sqlite.close();
    }
  });

  it("keeps older project members visible beyond the unfiltered knowledge page size", async () => {
    const { env, sqlite } = fixture();
    try {
      const project = await createProject(env, "ws", "Archive");
      const member = await insertFileRecord(env, {
        workspaceId: "ws",
        scope: "personal",
        name: "member.md",
        mime: "text/markdown",
        size: 4,
        r2Key: "member",
        sha256: "a".repeat(64),
        createdBy: "alice@example.test",
        projectId: project.id,
      });
      await env.AGENT_AUDIT.prepare(`UPDATE files SET updated_at=1 WHERE id=?`)
        .bind(member.id)
        .run();
      for (let index = 0; index < 210; index += 1) {
        await insertFileRecord(env, {
          workspaceId: "ws",
          scope: "personal",
          name: `newer-${index}.md`,
          mime: "text/markdown",
          size: 4,
          r2Key: `newer-${index}`,
          sha256: `${index}`.padStart(64, "0"),
          createdBy: "alice@example.test",
        });
      }
      const detail = await listProjectResources(env, "ws", "alice@example.test", project.id);
      expect(detail.files.map((file) => file.id)).toEqual([member.id]);
      expect((await listProjects(env, "ws", "alice@example.test"))[0]).toMatchObject({
        fileCount: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it("treats workspace scope as shared in the self-hosted workspace", async () => {
    const { env, sqlite } = fixture();
    try {
      await expect(
        canAccessKnowledgeResource(env, "alice@example.test", {
          workspaceId: "self-hosted",
          scope: "workspace",
          createdBy: "bob@example.test",
          resourceId: "file_1",
          resourceKind: "file",
        }),
      ).resolves.toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

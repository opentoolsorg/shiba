import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { avatarFileUsable } from "../src/custom-agents-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const WORKSPACE = `ws_${"a".repeat(24)}`;
const OTHER = `ws_${"b".repeat(24)}`;

function env() {
  const { database } = customAgentD1();
  return { AGENT_AUDIT: database } as unknown as Env;
}

async function addFile(bindings: Env, id: string, workspaceId: string, mime: string) {
  await bindings.AGENT_AUDIT.prepare(
    `INSERT INTO files (id, workspace_id, scope, name, mime, size, r2_key, sha256, created_by, version, created_at, updated_at, ingestion_state)
     VALUES (?, ?, 'workspace', ?, ?, 1024, ?, ?, 'owner@example.test', 1, ?, ?, 'done')`,
  ).bind(id, workspaceId, `${id}.png`, mime, `files/${id}`, "0".repeat(64), Date.now(), Date.now()).run();
}

describe("avatar upload references", () => {
  it("accepts a raster image stored in the caller's workspace", async () => {
    const bindings = env();
    await addFile(bindings, "file_mine0001", WORKSPACE, "image/png");
    expect(await avatarFileUsable(bindings, "file_mine0001", WORKSPACE)).toBe(true);
    expect(await avatarFileUsable(bindings, "file_mine0001", OTHER)).toBe(false);
  });

  it("refuses another workspace's file even when the id exists", async () => {
    const bindings = env();
    await addFile(bindings, "file_theirs001", OTHER, "image/webp");
    expect(await avatarFileUsable(bindings, "file_theirs001", WORKSPACE)).toBe(false);
    expect(await avatarFileUsable(bindings, "file_theirs001", OTHER)).toBe(true);
  });

  it("refuses a missing file, a caller with no workspace and a non-image", async () => {
    const bindings = env();
    await addFile(bindings, "file_svg00001", WORKSPACE, "image/svg+xml");
    await addFile(bindings, "file_pdf00001", WORKSPACE, "application/pdf");
    expect(await avatarFileUsable(bindings, "file_missing01", WORKSPACE)).toBe(false);
    expect(await avatarFileUsable(bindings, "file_svg00001", undefined)).toBe(false);
    expect(await avatarFileUsable(bindings, "file_svg00001", WORKSPACE)).toBe(false);
    expect(await avatarFileUsable(bindings, "file_pdf00001", WORKSPACE)).toBe(false);
  });
});

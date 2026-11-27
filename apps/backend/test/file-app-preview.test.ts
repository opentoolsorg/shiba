import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { insertFileRecord } from "../src/files/files-store.js";
import worker from "../src/index.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { TEST_ACCESS_AUD, verifiedAccessHeaders } from "./fixtures/access-identity.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn() }));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

const OWNER = "owner@example.test";
const OTHER = "other@example.test";
const BASE = "https://app-preview.example.test";
const MAX_BYTES = 64 * 1024;
const snapshot = {
  specVersion: 1,
  title: "Mock sales pipeline",
  description: "Synthetic data for a read-only preview.",
  columns: ["Company", "Value", "Won", "Notes"],
  rows: [
    ["Mock Acme", 1200, false, null],
    ["Mock Northwind", 2400, true, "Renewal"],
  ],
};
const encode = (value: string) => new TextEncoder().encode(value);
const snapshotBytes = encode(JSON.stringify(snapshot));
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  const objects = new Map<string, { bytes: Uint8Array; size: number }>();
  const canceled = vi.fn();
  const duringRead = vi.fn<() => void>();
  const get = vi.fn(async (key: string) => {
    const object = objects.get(key);
    if (!object) return null;
    let offset = 0;
    return {
      size: object.size,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= object.bytes.length) {
            controller.close();
            return;
          }
          if (offset === 0) duringRead();
          controller.enqueue(object.bytes.subarray(offset, offset + 4096));
          offset += 4096;
        },
        cancel: canceled,
      }),
    };
  });
  function unexpected(): never {
    throw new Error("Preview touched a write or execution binding");
  }
  const bound = (env: Partial<Env>) => env as Env;
  const seedEnv = bound({ AGENT_AUDIT: database });
  const workspace = await createTeamWorkspace(seedEnv, OWNER, { name: "Mock sales" }, 1);
  const otherWorkspace = await createTeamWorkspace(seedEnv, OWNER, { name: "Mock support" }, 1);
  const prepare = database.prepare.bind(database);
  const readOnlyDb = new Proxy(database, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => (/^SELECT\b/i.test(sql.trim()) ? prepare(sql) : unexpected());
      if (prop === "exec" || prop === "batch") return unexpected;
      return Reflect.get(target, prop);
    },
  });
  const env = bound({
    ACCESS_AUD: TEST_ACCESS_AUD,
    AGENT_AUDIT: readOnlyDb,
    FILES: {
      get,
      put: unexpected,
      delete: unexpected,
      createMultipartUpload: unexpected,
    } as unknown as R2Bucket,
    INSTANCE_TYPE: "invalid-preview-fixture-instance",
  });
  for (const key of ["AI", "Sandbox", "CodingOrchestrator", "AGENT_TOKENS", "ATTACHMENTS"]) {
    Object.defineProperty(env, key, { get: unexpected });
  }
  const ownerHeaders = await verifiedAccessHeaders(OWNER);
  const otherHeaders = await verifiedAccessHeaders(OTHER);
  const fetch = vi.spyOn(globalThis, "fetch");
  let nextKey = 0;

  async function seed(
    options: {
      bytes?: Uint8Array;
      storedBytes?: Uint8Array;
      size?: number;
      objectSize?: number;
      workspaceId?: string;
      scope?: "personal" | "workspace";
      mime?: string;
      key?: string;
      archived?: boolean;
    } = {},
  ) {
    const {
      bytes = snapshotBytes,
      storedBytes = bytes,
      size = bytes.length,
      objectSize = storedBytes.length,
      workspaceId = workspace.workspaceId,
      scope = "personal",
      mime = "application/json",
      key = `files/${workspaceId}/${scope}/upload_fixture/${++nextKey}.json`,
      archived,
    } = options;
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    const file = await insertFileRecord(seedEnv, {
      workspaceId,
      scope,
      createdBy: OWNER,
      name: "mock-pipeline.json",
      mime,
      size,
      r2Key: key,
      sha256: Buffer.from(digest).toString("hex"),
      ingestionState: "done",
    });
    objects.set(key, { bytes: storedBytes, size: objectSize });
    if (archived) sqlite.prepare("UPDATE files SET archived_at=1 WHERE id=?").run(file.id);
    return { id: file.id, key };
  }
  function request(
    id: string,
    headers: Record<string, string> = ownerHeaders,
    method = "GET",
    base = BASE,
  ) {
    return worker.fetch(
      new Request(`${base}/api/files/${id}/app-preview`, { method, headers }),
      env,
    );
  }
  const inWorkspace = { ...ownerHeaders, "X-Shiba-Workspace": workspace.workspaceId };
  return {
    seed,
    request,
    inWorkspace,
    ownerHeaders,
    otherHeaders,
    workspace,
    otherWorkspace,
    env,
    get,
    fetch,
    objects,
    canceled,
    duringRead,
    sqlite,
  };
}

describe("private file app preview", () => {
  it("returns only bounded table data to the signed owner without binding a model, sandbox or writer", async () => {
    const f = await fixture();
    const { id, key } = await f.seed();
    const response = await f.request(id, f.inWorkspace);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preview: snapshot });
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    });
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(key);
    for (const [request] of f.fetch.mock.calls)
      expect(String(request)).toContain("/cdn-cgi/access/certs");
  });

  it("denies anonymous, spoofed email, non-Access, and explicit bearer requests before R2", async () => {
    const f = await fixture();
    const { id } = await f.seed();
    expect((await f.request(id, {})).status).toBe(401);
    expect((await f.request(id, { "CF-Access-Authenticated-User-Email": OWNER })).status).toBe(401);
    expect(
      (await f.request(id, { ...f.inWorkspace, Authorization: "Bearer synthetic" })).status,
    ).toBe(401);
    expect(
      (await f.request(id, { ...f.inWorkspace, Origin: "https://other.example.test" })).status,
    ).toBe(403);
    expect((await f.request(id, { ...f.inWorkspace, "Sec-Fetch-Site": "cross-site" })).status).toBe(
      403,
    );
    f.env.ACCESS_AUD = undefined;
    expect((await f.request(id, f.ownerHeaders, "GET", "http://localhost")).status).toBe(401);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["file was archived", "membership was removed"])(
    "conceals the preview if %s during the read",
    async (change) => {
      const f = await fixture();
      const { id } = await f.seed();
      f.duringRead.mockImplementationOnce(() => {
        if (change === "file was archived") {
          f.sqlite.prepare("UPDATE files SET archived_at=1 WHERE id=?").run(id);
        } else {
          f.sqlite
            .prepare(
              "UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?",
            )
            .run(f.workspace.workspaceId, OWNER);
        }
      });
      expect((await f.request(id, f.inWorkspace)).status).toBe(404);
      expect(f.get).toHaveBeenCalledTimes(1);
    },
  );

  it("conceals unknown, same-workspace non-owner, wrong workspace and revoked membership", async () => {
    const f = await fixture();
    f.sqlite
      .prepare(`INSERT INTO team_workspace_memberships
      (tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES ('self-hosted',?,?,'admin','active',1,1)`)
      .run(f.workspace.workspaceId, OTHER);
    const { id } = await f.seed();
    const unknown = await f.request("file_000000000000000000000000", f.inWorkspace);
    expect(unknown.status).toBe(404);
    const hidden = await unknown.json();
    for (const headers of [
      { ...f.otherHeaders, "X-Shiba-Workspace": f.workspace.workspaceId },
      { ...f.ownerHeaders, "X-Shiba-Workspace": f.otherWorkspace.workspaceId },
      f.ownerHeaders,
    ]) {
      const response = await f.request(id, headers);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(hidden);
    }
    f.sqlite
      .prepare(
        "UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?",
      )
      .run(f.workspace.workspaceId, OWNER);
    expect((await f.request(id, f.inWorkspace)).status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("allows only GET of an active personal JSON file in the selected workspace", async () => {
    const f = await fixture();
    const { id } = await f.seed();
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await f.request(id, f.inWorkspace, method);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    for (const options of [
      { scope: "workspace" as const },
      { mime: "text/html", key: `generated-documents/${f.workspace.workspaceId}/mock.html` },
      { mime: "text/markdown" },
      { archived: true },
      { key: `files/${f.otherWorkspace.workspaceId}/personal/alien.json` },
    ]) {
      const source = await f.seed(options);
      expect((await f.request(source.id, f.inWorkspace)).status).toBe(404);
    }
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each([
    ["incomplete JSON", encode("{")],
    ["invalid UTF-8", new Uint8Array([0xff])],
    ["unknown version", encode(JSON.stringify({ ...snapshot, specVersion: 2 }))],
    ["extra executable field", encode(JSON.stringify({ ...snapshot, script: "doSomething()" }))],
    [
      "markup masquerading as a row",
      encode(JSON.stringify({ ...snapshot, rows: [["<script>", 1, true, null]] })),
    ],
    [
      "non-scalar cell",
      encode(JSON.stringify({ ...snapshot, rows: [["Mock", 1, true, { nested: true }]] })),
    ],
    ["wrong row width", encode(JSON.stringify({ ...snapshot, rows: [["Mock"]] }))],
    [
      "too many rows",
      encode(JSON.stringify({ ...snapshot, rows: Array(21).fill(snapshot.rows[0]) })),
    ],
  ])("rejects %s without echoing it", async (_label, bytes) => {
    const f = await fixture();
    const { id } = await f.seed({ bytes });
    const response = await f.request(id, f.inWorkspace);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Invalid app preview." });
  });

  it("fails closed on missing, changed, or oversized bytes at every read boundary", async () => {
    const f = await fixture();
    const missing = await f.seed();
    f.objects.delete(missing.key);
    expect((await f.request(missing.id, f.inWorkspace)).status).toBe(404);
    const changed = await f.seed({
      storedBytes: encode(JSON.stringify({ ...snapshot, title: "Mock fraud pipeline" })),
    });
    expect((await f.request(changed.id, f.inWorkspace)).status).toBe(422);
    const atLimit = encode(JSON.stringify(snapshot).padEnd(MAX_BYTES));
    const large = new Uint8Array(MAX_BYTES + 1);
    const metadata = await f.seed({ bytes: large });
    const object = await f.seed({ storedBytes: large });
    const stream = await f.seed({
      bytes: atLimit,
      storedBytes: new Uint8Array(MAX_BYTES + 8192),
      objectSize: MAX_BYTES,
    });
    const exact = await f.seed({ bytes: atLimit });
    f.get.mockClear();
    expect((await f.request(metadata.id, f.inWorkspace)).status).toBe(413);
    expect(f.get).not.toHaveBeenCalled();
    expect((await f.request(object.id, f.inWorkspace)).status).toBe(413);
    expect((await f.request(stream.id, f.inWorkspace)).status).toBe(413);
    expect(f.canceled).toHaveBeenCalledTimes(2);
    expect((await f.request(exact.id, f.inWorkspace)).status).toBe(200);
  });
});

export type SpaceItemKind = "skill" | "repo" | "automation" | "run";

export interface SpaceItem {
  kind: SpaceItemKind;
  ref: string;
  addedAt: number;
}

export interface SpaceSnapshot {
  id: string;
  orgId: string;
  name: string;
  template: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  items: SpaceItem[];
}

/** One hosted Space — metadata + pinned items (scaffold). */
export class Spaces {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS space (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        template TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS space_members (
        principal TEXT PRIMARY KEY,
        role TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS space_items (
        kind TEXT NOT NULL CHECK (kind IN ('skill','repo','automation','run')),
        ref TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (kind, ref)
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/internal/init" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const id = typeof record.id === "string" ? record.id : "";
      const orgId = typeof record.orgId === "string" ? record.orgId : "";
      const name = typeof record.name === "string" ? record.name.trim().slice(0, 120) : "Untitled space";
      const template = typeof record.template === "string" ? record.template : "blank";
      const createdBy = typeof record.createdBy === "string" ? record.createdBy : "unknown";
      const now = Date.now();
      if (!id || !orgId) return Response.json({ error: "invalid_space" }, { status: 400 });
      const sql = this.ctx.storage.sql;
      sql.exec(
        `INSERT INTO space (id, org_id, name, template, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, orgId, name || "Untitled space", template, createdBy, now, now,
      );
      sql.exec("INSERT INTO space_members (principal, role) VALUES (?, ?)", createdBy, "owner");
      return Response.json({ ok: true, space: await this.snapshot() });
    }

    if (path === "/internal/snapshot" && request.method === "GET") {
      const space = await this.snapshot();
      return space
        ? Response.json({ ok: true, space })
        : Response.json({ error: "not_initialized" }, { status: 404 });
    }

    if (path === "/internal/items" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : null;
      const ref = typeof body === "object" && body !== null && "ref" in body && typeof body.ref === "string" ? body.ref : "";
      if (kind !== "skill" && kind !== "repo" && kind !== "automation" && kind !== "run") {
        return Response.json({ error: "invalid_item" }, { status: 400 });
      }
      if (!ref || ref.length > 256) return Response.json({ error: "invalid_item" }, { status: 400 });
      const addedAt = Date.now();
      this.ctx.storage.sql.exec(
        "INSERT INTO space_items (kind, ref, added_at) VALUES (?, ?, ?) ON CONFLICT(kind, ref) DO UPDATE SET added_at = excluded.added_at",
        kind, ref, addedAt,
      );
      this.ctx.storage.sql.exec("UPDATE space SET updated_at = ? WHERE id IS NOT NULL", addedAt);
      return Response.json({ ok: true, item: { kind, ref, addedAt } });
    }

    if (path === "/internal/items" && request.method === "DELETE") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : null;
      const ref = typeof body === "object" && body !== null && "ref" in body && typeof body.ref === "string" ? body.ref : "";
      if (kind !== "skill" && kind !== "repo" && kind !== "automation" && kind !== "run") {
        return Response.json({ error: "invalid_item" }, { status: 400 });
      }
      this.ctx.storage.sql.exec("DELETE FROM space_items WHERE kind = ? AND ref = ?", kind, ref);
      return Response.json({ ok: true });
    }

    if (path === "/internal/patch" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const name = typeof body === "object" && body !== null && "name" in body && typeof body.name === "string"
        ? body.name.trim().slice(0, 120)
        : "";
      if (!name) return Response.json({ error: "invalid_name" }, { status: 400 });
      const updatedAt = Date.now();
      this.ctx.storage.sql.exec("UPDATE space SET name = ?, updated_at = ? WHERE id IS NOT NULL", name, updatedAt);
      return Response.json({ ok: true, space: await this.snapshot() });
    }

    return new Response(null, { status: 404 });
  }

  private async snapshot(): Promise<SpaceSnapshot | null> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ id: string; org_id: string; name: string; template: string; created_by: string; created_at: number; updated_at: number }>(
      "SELECT id, org_id, name, template, created_by, created_at, updated_at FROM space LIMIT 1",
    ).toArray()[0];
    if (!row) return null;
    const items = sql.exec<{ kind: SpaceItemKind; ref: string; added_at: number }>(
      "SELECT kind, ref, added_at FROM space_items ORDER BY added_at ASC",
    ).toArray().map((item) => ({ kind: item.kind, ref: item.ref, addedAt: item.added_at }));
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      template: row.template,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items,
    };
  }
}

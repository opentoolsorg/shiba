import { describe, expect, it } from "vitest";
import { Spaces } from "../src/spaces-do.js";

describe("Spaces durable object", () => {
  it("persists snapshot data across instance re-fetch", async () => {
    const rows: {
      space: Record<string, unknown> | null;
      items: Array<{ kind: string; ref: string; added_at: number }>;
    } = { space: null, items: [] };
    const sql = {
      exec: (statement: string, ...args: unknown[]) => {
        if (/INSERT INTO space\b/i.test(statement)) {
          rows.space = {
            id: args[0],
            org_id: args[1],
            name: args[2],
            template: args[3],
            created_by: args[4],
            created_at: args[5],
            updated_at: args[6],
          };
        }
        if (/INSERT INTO space_items\b/i.test(statement)) {
          rows.items.push({ kind: String(args[0]), ref: String(args[1]), added_at: Number(args[2]) });
        }
        return {
          toArray: () => {
            if (/FROM space LIMIT/i.test(statement)) return rows.space ? [rows.space] : [];
            if (/FROM space_items/i.test(statement)) return rows.items;
            return [];
          },
        };
      },
    };
    const state = { storage: { sql } };
    const first = new Spaces(state as unknown as DurableObjectState);
    const second = new Spaces(state as unknown as DurableObjectState);

    const init = await first.fetch(new Request("https://do/internal/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "space-aaaaaaaaaaaaaaaaaaaaaaaa",
        orgId: "org-a",
        name: "Review desk",
        template: "code-review",
        createdBy: "owner",
      }),
    }));
    expect(init.status).toBe(200);

    await first.fetch(new Request("https://do/internal/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "skill", ref: "skill-bbbbbbbbbbbbbbbbbbbbbbbb" }),
    }));

    const snapshot = await second.fetch(new Request("https://do/internal/snapshot", { method: "GET" }));
    expect(snapshot.status).toBe(200);
    const body = await snapshot.json() as { space: { name: string; items: unknown[] } };
    expect(body.space.name).toBe("Review desk");
    expect(body.space.items).toHaveLength(1);
  });
});

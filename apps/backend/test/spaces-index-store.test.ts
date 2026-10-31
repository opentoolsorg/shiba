import { describe, expect, it } from "vitest";
import {
  getSpaceIndex,
  insertSpaceIndex,
  touchSpaceIndexUpdatedAt,
  updateSpaceIndexName,
} from "../src/spaces-index-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("spaces index store", () => {
  it("keeps updated_at monotonic on rename and touch", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database };
    const row = {
      id: "space-aaaaaaaaaaaaaaaaaaaaaaaa",
      orgId: "org-a",
      name: "Desk",
      template: "blank",
      createdBy: "owner",
      createdAt: 1_000,
      updatedAt: 5_000,
    };
    await insertSpaceIndex(env, row);

    await updateSpaceIndexName(env, "org-a", row.id, "Renamed", 3_000);
    let current = await getSpaceIndex(env, "org-a", row.id);
    expect(current?.updatedAt).toBe(5_000);

    await updateSpaceIndexName(env, "org-a", row.id, "Renamed again", 7_000);
    current = await getSpaceIndex(env, "org-a", row.id);
    expect(current?.updatedAt).toBe(7_000);

    await touchSpaceIndexUpdatedAt(env, "org-a", row.id, 6_000);
    current = await getSpaceIndex(env, "org-a", row.id);
    expect(current?.updatedAt).toBe(7_000);

    await touchSpaceIndexUpdatedAt(env, "org-a", row.id, 9_000);
    current = await getSpaceIndex(env, "org-a", row.id);
    expect(current?.updatedAt).toBe(9_000);
  });
});

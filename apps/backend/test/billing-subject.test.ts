import { describe, expect, it } from "vitest";
import {
  billingSubjectForRun, billingSubjectForStore, personalBillingSubject, teamBillingSubject, teamWorkspaceFromOrgId,
} from "../src/billing-subject.js";

const workspaceId = "ws_0123456789abcdef01234567";

describe("billing subjects", () => {
  it("keys a person by id and a team by workspace, never by store name", () => {
    expect(personalBillingSubject("Ada@Example.test")).toMatchObject({ key: "user:ada@example.test", scope: "personal", userId: "ada@example.test", workspaceId: null });
    expect(teamBillingSubject(workspaceId)).toMatchObject({ key: "team:" + workspaceId, scope: "team", userId: null, workspaceId });
    expect(() => teamBillingSubject("default")).toThrow(/Invalid team workspace/);
  });

  it("reads only a valid team workspace out of an org id", () => {
    expect(teamWorkspaceFromOrgId("team:" + workspaceId)).toBe(workspaceId);
    expect(teamWorkspaceFromOrgId("team:default")).toBeNull();
    expect(teamWorkspaceFromOrgId("team:ws_short")).toBeNull();
    expect(teamWorkspaceFromOrgId("self-hosted")).toBeNull();
    expect(teamWorkspaceFromOrgId(undefined)).toBeNull();
  });

  it("bills a team run to its workspace and a personal run to its queueing user", () => {
    expect(billingSubjectForRun({ orgId: "team:" + workspaceId, queuedBy: "ada@example.test" }, "ada@example.test")?.key).toBe("team:" + workspaceId);
    expect(billingSubjectForRun({ orgId: "self-hosted", queuedBy: "ada@example.test" }, "someone-else")?.key).toBe("user:ada@example.test");
    // Two threads of one user share one account: the store name never decides it.
    expect(billingSubjectForStore("ada@example.test")?.key).toBe("user:ada@example.test");
    expect(billingSubjectForStore("web:ada@example.test:0b7c1f2e-3d4a-4c5b-8e9f-0a1b2c3d4e5f")?.key).toBe("user:ada@example.test");
    expect(billingSubjectForStore("slack:thread")).toBeNull();
  });
});

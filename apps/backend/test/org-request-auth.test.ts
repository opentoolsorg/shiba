import { describe, expect, it } from "vitest";
import { orgIdFromIntake } from "../src/org-request-auth.js";

describe("orgIdFromIntake", () => {
  it("defaults to self-hosted when absent", () => {
    expect(orgIdFromIntake({})).toBe("self-hosted");
  });

  it("uses trimmed orgId from intake body", () => {
    expect(orgIdFromIntake({ orgId: "  org-acme  " })).toBe("org-acme");
  });
});

import { describe, expect, it } from "vitest";
import { intakeOrgIdForOrchestrator, orgIdFromIntake, trustedIntakeOrgId } from "../src/org-request-auth.js";

describe("orgIdFromIntake", () => {
  it("defaults to self-hosted when absent", () => {
    expect(orgIdFromIntake({})).toBe("self-hosted");
  });

  it("uses trimmed orgId from intake body", () => {
    expect(orgIdFromIntake({ orgId: "  org-acme  " })).toBe("org-acme");
  });
});

describe("trustedIntakeOrgId", () => {
  it("forces dashboard orchestrators to self-hosted org scope", () => {
    expect(trustedIntakeOrgId("owner@example.com", { orgId: "forged-org" })).toBe("self-hosted");
    expect(
      trustedIntakeOrgId("web:owner@example.com:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", { orgId: "forged-org" }),
    ).toBe("self-hosted");
  });

  it("keeps intake org on non-dashboard orchestrators", () => {
    expect(trustedIntakeOrgId("telegram:42", { orgId: "org-acme" })).toBe("org-acme");
  });
});

 describe("intakeOrgIdForOrchestrator", () => {
  it.each(["owner@example.com", "web:owner@example.com:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])("uses the dashboard resource org for %s", (name) => {
    expect(intakeOrgIdForOrchestrator(name, { orgId: "forged-org" })).toBe("self-hosted");
  });
  it.each(["telegram:42", "discord:99", "slack:T:C:123"])("keeps the intake org for %s", (name) => {
    expect(intakeOrgIdForOrchestrator(name, { orgId: "org-acme" })).toBe("org-acme");
  });
});

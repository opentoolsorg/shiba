import { describe, expect, it } from "vitest";
import { DASHBOARD_CSP_REPORT_ONLY, dashboardCspReportOnly } from "../src/csp.js";

const ORIGIN = "https://app.tryshiba.dev";

const decide = (overrides: Partial<Parameters<typeof dashboardCspReportOnly>[0]> = {}) =>
  dashboardCspReportOnly({
    url: `${ORIGIN}/app/`,
    resourceType: "mainFrame",
    headers: {},
    configuredOrigin: ORIGIN,
    ...overrides,
  });

describe("dashboard csp", () => {
  it("adds a report-only policy to the dashboard document", () => {
    expect(decide()).toBe(DASHBOARD_CSP_REPORT_ONLY);
    expect(DASHBOARD_CSP_REPORT_ONLY).toContain("object-src 'none'");
    expect(DASHBOARD_CSP_REPORT_ONLY).toContain("frame-ancestors 'none'");
  });

  it("stays out of the way when the Worker already sent a policy", () => {
    expect(decide({ headers: { "Content-Security-Policy": ["default-src 'self'"] } })).toBeNull();
    expect(decide({ headers: { "content-security-policy-report-only": ["default-src 'self'"] } })).toBeNull();
  });

  it("only touches main-frame documents on the configured origin", () => {
    expect(decide({ resourceType: "script" })).toBeNull();
    expect(decide({ resourceType: "subFrame" })).toBeNull();
    expect(decide({ url: "https://evil.example/app/" })).toBeNull();
    expect(decide({ configuredOrigin: "" })).toBeNull();
    expect(decide({ url: "not a url" })).toBeNull();
  });
});

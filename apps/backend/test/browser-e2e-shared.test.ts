import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_E2E_PLAN, parseBrowserE2ePlan } from "@shiba/shared";

describe("parseBrowserE2ePlan", () => {
  it("accepts a minimal valid plan", () => {
    const { plan, rejected } = parseBrowserE2ePlan({
      title: "demo",
      steps: [{ kind: "goto", path: "/" }, { kind: "screenshot", name: "home" }],
    });
    expect(rejected).toBe(0);
    expect(plan?.steps).toHaveLength(2);
  });

  it("drops invalid steps and never throws", () => {
    const { plan, rejected } = parseBrowserE2ePlan({
      steps: [{ kind: "goto", path: "/" }, { kind: "nope" }, { kind: "click" }],
    });
    expect(plan?.steps).toEqual([{ kind: "goto", path: "/" }]);
    expect(rejected).toBe(2);
  });

  it("ships a default smoke plan", () => {
    expect(DEFAULT_BROWSER_E2E_PLAN.steps.length).toBeGreaterThan(0);
  });
});

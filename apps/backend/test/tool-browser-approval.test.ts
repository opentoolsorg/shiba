import { describe, expect, it } from "vitest";
import { selectorRequiresSubmitApproval } from "../src/tools/browser-url.js";
import { browserClick } from "../src/tools/browser.js";

describe("browser tool approval", () => {
  it("flags submit and password selectors for approval", () => {
    expect(selectorRequiresSubmitApproval('button[type="submit"]')).toBe(true);
    expect(selectorRequiresSubmitApproval("#email")).toBe(false);
    expect(selectorRequiresSubmitApproval("#password", "secret")).toBe(true);
  });

  it("rejects submit clicks without approved=true", async () => {
    await expect(browserClick("run-1", 'input[type="submit"]', { approved: false })).rejects.toThrow(/approval|browser_open/);
  });
});
import { describe, expect, it } from "vitest";
import { decidePrWake, pullNumberFromCheckPayload } from "../src/review/wake.js";

describe("decidePrWake", () => {
  it("maps synchronize to incremental re-review", () => {
    const decision = decidePrWake("pull_request", {
      event: "pull_request",
      action: "synchronize",
      repo: "acme/widgets",
      pullNumber: 3,
    });
    expect(decision.kind).toBe("synchronize_re_review");
    expect(decision.reusePublishApproval).toBe(true);
  });

  it("maps check_run completed to ci wake", () => {
    expect(
      decidePrWake("check_run", { event: "check_run", action: "completed" }).kind,
    ).toBe("ci_completed");
  });

  it("ignores unrelated events", () => {
    expect(decidePrWake("push", { event: "push" }).kind).toBe("none");
  });
});

describe("pullNumberFromCheckPayload", () => {
  it("reads the first linked pull request", () => {
    const n = pullNumberFromCheckPayload({
      check_run: { pull_requests: [{ number: 9 }] },
    });
    expect(n).toBe(9);
  });
});

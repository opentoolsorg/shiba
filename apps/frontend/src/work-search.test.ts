import { describe, expect, it } from "vitest";
import { parseWorkSearch, updateWorkSearch } from "./work-search";

describe("Work URL state", () => {
  it("validates deep-linked layouts, selection kinds and inspector tabs", () => {
    expect(
      parseWorkSearch(new URLSearchParams("view=timeline&task=run%3Aone&taskKind=run&tab=diff")),
    ).toEqual({
      view: "timeline",
      task: "run:one",
      taskKind: "run",
      tab: "diff",
    });
    expect(
      parseWorkSearch(new URLSearchParams("view=bogus&task=&taskKind=other&tab=commands")),
    ).toEqual({
      view: "list",
      task: null,
      taskKind: undefined,
      tab: "steps",
    });
  });

  it("preserves workspace, legacy and OAuth parameters, including repeated values", () => {
    const search = new URLSearchParams(
      "workspace=w&code=return-code&state=opaque&tab=output&view=board&task=old&taskKind=run&filter=a&filter=b",
    );
    const next = updateWorkSearch(search, {
      view: "timeline",
      task: "session/two",
      taskKind: "session",
      tab: "steps",
    });
    expect(next.get("workspace")).toBe("w");
    expect(next.get("code")).toBe("return-code");
    expect(next.get("state")).toBe("opaque");
    expect(next.getAll("filter")).toEqual(["a", "b"]);
    expect(parseWorkSearch(next)).toEqual({
      view: "timeline",
      task: "session/two",
      taskKind: "session",
      tab: "steps",
    });
    expect(search.get("task")).toBe("old");
    const closed = updateWorkSearch(next, { view: "timeline", task: null, tab: "steps" });
    expect(closed.has("task")).toBe(false);
    expect(closed.has("taskKind")).toBe(false);
    expect(closed.has("tab")).toBe(false);
    expect(closed.get("view")).toBe("timeline");
    expect(closed.get("state")).toBe("opaque");
  });

  it("opens approval links on review by default and preserves an explicit steps tab", () => {
    const search = new URLSearchParams("task=gate-one&taskKind=approval");
    expect(parseWorkSearch(search).tab).toBe("approval");
    const next = updateWorkSearch(search, {
      view: "board",
      task: "gate-one",
      taskKind: "approval",
      tab: "steps",
    });
    expect(next.get("tab")).toBe("steps");
    expect(parseWorkSearch(next).tab).toBe("steps");
  });

  it("retains legacy view and tab aliases that are not Work-owned layout or inspector values", () => {
    const next = updateWorkSearch(new URLSearchParams("tab=work&view=work&state=oauth"), {
      view: "list",
      task: null,
      tab: "steps",
    });
    expect(next.toString()).toBe("tab=work&view=work&state=oauth");
  });
});

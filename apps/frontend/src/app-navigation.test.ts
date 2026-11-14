import { describe, expect, it } from "vitest";
import {
  APP_AREAS,
  APP_NAV_ITEMS,
  areaForView,
  pathForView,
  readNavigationView,
} from "./app-navigation";

describe("deployed navigation contracts", () => {
  it("assigns every current destination to exactly one of five areas", () => {
    expect(APP_AREAS.map((area) => area.label)).toEqual([
      "Work",
      "Chat",
      "Team",
      "Knowledge",
      "Settings",
    ]);
    const destinations = APP_AREAS.flatMap((area) => area.views);
    expect(destinations).toHaveLength(APP_NAV_ITEMS.length);
    expect(new Set(destinations).size).toBe(APP_NAV_ITEMS.length);
    expect(new Set(destinations)).toEqual(new Set(APP_NAV_ITEMS.map((item) => item.id)));
  });
  it.each(APP_NAV_ITEMS)("round trips the existing $id flat route", ({ id }) => {
    expect(pathForView(id)).toBe(`/${id}/`);
    expect(readNavigationView(pathForView(id), "")).toBe(id);
    expect(areaForView(id).views).toContain(id);
  });
  it.each(["/app", "/app/", "/"])("preserves legacy query links at %s", (path) => {
    for (const { id } of APP_NAV_ITEMS) {
      expect(readNavigationView(path, `?tab=${id}`)).toBe(id);
      expect(readNavigationView(path, `?view=${id}`)).toBe(id);
    }
  });
  it("keeps aliases, hosted space links, and path precedence", () => {
    expect(readNavigationView("/run-registry/", "")).toBe("analytics");
    expect(readNavigationView("/app/", "?view=orchestrator")).toBe("activity");
    expect(readNavigationView("/mailbox/", "")).toBe("inbox");
    expect(readNavigationView("/spaces/hosted-id/", "")).toBe("spaces");
    expect(readNavigationView("/skills/", "?tab=providers")).toBe("skills");
    expect(readNavigationView("/app/", "?tab=unknown&view=providers")).toBe("providers");
    expect(readNavigationView("/app/", "?tab=unknown")).toBeNull();
  });
  it("resolves persisted work selection without confusing layout and destination selectors", () => {
    expect(readNavigationView("/app/", "?view=board&task=task-1&tab=diff")).toBe("work");
    expect(readNavigationView("/work/", "?view=timeline")).toBe("work");
    expect(readNavigationView("/app/", "?view=organization")).toBe("work");
  });
});

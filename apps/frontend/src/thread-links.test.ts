import { describe, expect, it } from "vitest";
import { isThreadId, readThreadLink, resolveLinkedThread, withThreadLink } from "./thread-links";

const RESEARCH = "11111111-1111-4111-8111-111111111111";
const ENGINEERING = "22222222-2222-4222-8222-222222222222";

describe("thread links", () => {
  it("reads a single well-formed thread selector", () => {
    expect(readThreadLink(`?session=${RESEARCH}`)).toEqual({ threadId: RESEARCH });
    expect(readThreadLink("?room=room_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(readThreadLink("")).toBeNull();
  });

  it("refuses selectors it must not act on", () => {
    for (const search of [
      "?session=",
      "?session=not-a-thread",
      `?session=${RESEARCH}&session=${ENGINEERING}`,
      `?session=${RESEARCH}/../../etc`,
    ]) {
      expect(readThreadLink(search)).toBe("invalid");
    }
  });

  it("writes the link without disturbing other query state", () => {
    expect(withThreadLink("?prompt=hello", RESEARCH)).toBe(`prompt=hello&session=${RESEARCH}`);
    expect(withThreadLink(`?session=${RESEARCH}`, ENGINEERING)).toBe(`session=${ENGINEERING}`);
    expect(withThreadLink(`?session=${RESEARCH}&keep=1`, null)).toBe("keep=1");
  });

  it("never links the default session or an unverified id", () => {
    expect(isThreadId("default")).toBe(true);
    expect(withThreadLink("", "default")).toBe("");
    expect(withThreadLink("", "not-a-thread")).toBe("");
  });

  it("opens a linked thread only when this viewer can list it", () => {
    const available = [{ id: RESEARCH }];
    expect(resolveLinkedThread(RESEARCH, available)).toBe(RESEARCH);
    expect(resolveLinkedThread("default", available)).toBe("default");
    expect(resolveLinkedThread(ENGINEERING, available)).toBe("default");
    expect(resolveLinkedThread(ENGINEERING, [])).toBe("default");
  });
});

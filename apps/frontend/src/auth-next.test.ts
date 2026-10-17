import { describe, expect, it } from "vitest";
import { signInReturnPath } from "./auth-next";

describe("signInReturnPath", () => {
  it("returns the OAuth consent path the Worker redirected from", () => {
    const next = "/oauth/authorize?response_type=code&client_id=c1&state=s1";
    expect(signInReturnPath(`?next=${encodeURIComponent(next)}`)).toBe(next);
  });

  it.each(["", "?next=", "?next=https://evil.example/oauth/authorize", "?next=//evil.example", "?next=/api/runs", "?next=/oauth/authorizeX"])(
    "refuses %s",
    (search) => {
      expect(signInReturnPath(search)).toBeNull();
    },
  );
});

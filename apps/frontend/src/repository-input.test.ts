import { describe, expect, it } from "vitest";
import { normalizeRepositoryInput } from "./repository-input";

describe("repository input", () => {
  it.each(["opentoolsorg/shiba", "github.com/opentoolsorg/shiba", "https://github.com/opentoolsorg/shiba.git", " https://github.com/opentoolsorg/shiba/ ", "opentoolsorg/shiba.git"])("normalizes %s", (value) => {
    expect(normalizeRepositoryInput(value)).toBe("https://github.com/opentoolsorg/shiba");
  });
  it.each(["", "repo", "a/b/tree/main", "http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com@evil.com/a/b", "https://user:pass@github.com/a/b", "https://github.com/a/b?q=x", "https://github.com/a/b#x", "a/%2F", "a/..", "a/b c", "github.com.evil.com/a/b", "github.com@evil.com/a/b", "github.com/a/b/tree/main"])("rejects %s", (value) => {
    expect(normalizeRepositoryInput(value)).toBeNull();
  });
});

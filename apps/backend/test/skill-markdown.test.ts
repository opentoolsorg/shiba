import { describe, expect, it } from "vitest";
import { SkillMarkdown, SkillMarkdownError } from "@shiba/shared";

describe("SkillMarkdown", () => {
  it("imports only the name, description and instruction body", () => {
    expect(SkillMarkdown.parse(`---\nname: research\ndescription: Find reliable sources\nlicense: MIT\n---\n# Research\n\nCheck citations.`)).toEqual({
      name: "research", description: "Find reliable sources",
      instructions: "Find reliable sources\n# Research\n\nCheck citations.", ignoredKeys: ["license"],
    });
  });

  it("rejects missing names and oversized input", () => {
    expect(() => SkillMarkdown.parse("instructions only")).toThrow(SkillMarkdownError);
    expect(() => SkillMarkdown.parse(`${"x".repeat(SkillMarkdown.MAX_BYTES + 1)}`)).toThrow("skill_markdown_too_large");
  });
});

/**
 * Parses an Agent Skills style SKILL.md (YAML-ish frontmatter + Markdown body)
 * into managed-skill draft content. Only `name` and `description` are read;
 * scripts, resources and other frontmatter are never executed or stored.
 */
export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  instructions: string;
  ignoredKeys: string[];
}

export class SkillMarkdownError extends Error {
  constructor(readonly code: "skill_markdown_too_large" | "skill_markdown_name_required" | "skill_markdown_empty" | "skill_markdown_invalid_frontmatter") {
    super(code);
  }
}

export class SkillMarkdown {
  static readonly MAX_BYTES = 32 * 1024;
  static readonly MAX_NAME = 100;
  static readonly MAX_INSTRUCTIONS = 16_000;

  static parse(source: string): ParsedSkillMarkdown {
    if (new TextEncoder().encode(source).byteLength > SkillMarkdown.MAX_BYTES) throw new SkillMarkdownError("skill_markdown_too_large");
    const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const { fields, body } = SkillMarkdown.split(text);
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const name = (fields.get("name") ?? heading ?? "").trim().slice(0, SkillMarkdown.MAX_NAME);
    if (!name) throw new SkillMarkdownError("skill_markdown_name_required");
    const description = (fields.get("description") ?? "").trim();
    const instructions = [description ? `${description}\n` : "", body.trim()].join("").trim();
    if (!instructions) throw new SkillMarkdownError("skill_markdown_empty");
    if (instructions.length > SkillMarkdown.MAX_INSTRUCTIONS) throw new SkillMarkdownError("skill_markdown_too_large");
    return { name, description, instructions, ignoredKeys: [...fields.keys()].filter((key) => key !== "name" && key !== "description") };
  }

  private static split(text: string): { fields: Map<string, string>; body: string } {
    const fields = new Map<string, string>();
    if (!text.startsWith("---\n")) return { fields, body: text };
    const end = text.indexOf("\n---", 4);
    if (end < 0) throw new SkillMarkdownError("skill_markdown_invalid_frontmatter");
    const after = text.slice(end + 4);
    if (after && !after.startsWith("\n")) throw new SkillMarkdownError("skill_markdown_invalid_frontmatter");
    let current: string | null = null;
    for (const line of text.slice(4, end).split("\n")) {
      const pair = line.match(/^([A-Za-z][\w-]{0,63}):\s*(.*)$/);
      if (pair) {
        current = pair[1]!;
        const value = pair[2]!.trim();
        // Block scalars (`|`, `>`) continue on indented lines below.
        fields.set(current, /^[|>][+-]?$/.test(value) ? "" : SkillMarkdown.unquote(value));
      } else if (current && /^\s+\S/.test(line)) {
        const previous = fields.get(current) ?? "";
        fields.set(current, previous ? `${previous}\n${line.trim()}` : line.trim());
      } else if (line.trim()) {
        current = null;
      }
    }
    return { fields, body: after.replace(/^\n/, "") };
  }

  private static unquote(value: string): string {
    const quoted = value.match(/^(["'])(.*)\1$/);
    return quoted ? quoted[2]! : value;
  }
}

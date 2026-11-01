import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentTemplateSchema, listAgentTemplates, validateAgentTemplate } from "@shiba/shared";

describe("template pack registry", () => {
  it("loads and validates every authored pack folder", async () => {
    const folders = await readdir(new URL("../../../templates/", import.meta.url), { withFileTypes: true });
    const packs = folders.filter((entry) => entry.isDirectory());
    const templates = listAgentTemplates();
    const ids = templates.map((template) => template.id).sort();
    expect(packs.map(({ name }) => name).sort()).toEqual(ids);
    for (const { name } of packs) {
      const path = new URL(`../../../templates/${name}/`, import.meta.url);
      const metadata = JSON.parse(await readFile(new URL("template.json", path), "utf8")) as Record<string, unknown>;
      const instructions = await readFile(new URL("INSTRUCTIONS.md", path), "utf8");
      const registered = templates.find((template) => template.id === name);
      if (!registered) throw new Error(`Missing registry entry for ${name}.`);
      const { instructions: registeredInstructions, ...registeredMetadata } = registered;
      expect(metadata).toEqual(registeredMetadata);
      expect(instructions).toBe(`# ${registered.name}\n\n${registeredInstructions}\n`);
      expect(AgentTemplateSchema.parse({ ...metadata, instructions }).id).toBe(name);
      expect(await readFile(new URL("getting-started.md", path), "utf8")).toContain("Getting started");
      expect((metadata.chat_lanes as string[]).every((lane) => lane === "slack")).toBe(true);
    }
  });

  it("rejects malformed packs", () => {
    const template = listAgentTemplates()[0];
    if (!template) throw new Error("Expected a registered template.");
    expect(() => validateAgentTemplate({ ...template, description: "x".repeat(221) })).toThrow();
    expect(() => validateAgentTemplate({ ...template, chat_lanes: ["discord"] })).toThrow();
  });
});

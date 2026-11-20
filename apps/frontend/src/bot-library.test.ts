import { describe, expect, it } from "vitest";
import { botConfigWithEdit, botFileDownloadPath, fileExtension, previewLimitation } from "./bot-library";
import type { CustomAgentConfig } from "@shiba/shared";

const config: CustomAgentConfig = {
  name: "Research bot",
  instructions: "Write briefs.",
  harness: "opencode",
  codingModel: "openai/gpt-5",
  expectedDeliverables: ["out/report.md"],
  libraryFileIds: ["file_aaaaaaaa"],
};

describe("bot config edits", () => {
  it("keeps every field it was not asked to change", () => {
    const next = botConfigWithEdit(config, { libraryFileIds: ["file_bbbbbbbb"] });
    expect(next).toMatchObject({
      name: "Research bot",
      instructions: "Write briefs.",
      harness: "opencode",
      codingModel: "openai/gpt-5",
      expectedDeliverables: ["out/report.md"],
      libraryFileIds: ["file_bbbbbbbb"],
    });
  });

  it("removes a cleared model instead of storing an empty override", () => {
    const next = botConfigWithEdit(config, { codingModel: null });
    expect(next).not.toHaveProperty("codingModel");
    expect(next.codingModel).toBeUndefined();
  });

  it("removes the library field when the last link is removed", () => {
    expect(botConfigWithEdit(config, { libraryFileIds: [] })).not.toHaveProperty("libraryFileIds");
  });

  it("de-duplicates and trims links before saving", () => {
    expect(botConfigWithEdit(config, { libraryFileIds: [" file_aaaaaaaa ", "file_aaaaaaaa", "file_cccccccc"] }).libraryFileIds)
      .toEqual(["file_aaaaaaaa", "file_cccccccc"]);
  });

  it("saves trimmed instructions verbatim otherwise", () => {
    expect(botConfigWithEdit(config, { instructions: "Cite sources." }).instructions).toBe("Cite sources.");
  });

  it("never mutates the record it was given", () => {
    const before = JSON.stringify(config);
    botConfigWithEdit(config, { instructions: "Changed.", libraryFileIds: [] });
    expect(JSON.stringify(config)).toBe(before);
  });
});

describe("file paths and previews", () => {
  it("routes a download through the authorized file route", () => {
    expect(botFileDownloadPath("file_a")).toBe("/api/files/file_a/download");
    expect(botFileDownloadPath("a/b")).toBe("/api/files/a%2Fb/download");
  });

  it.each(["report.md", "notes.txt", "data.csv", "payload.json", "page.html", "brief.pdf", "shot.png", "clip.mp4"])(
    "previews %s with the existing viewer",
    (name) => expect(previewLimitation(name)).toBeNull(),
  );

  it("names the limitation instead of pretending to preview a binary", () => {
    expect(previewLimitation("archive.zip")).toBe("No in-panel preview for .zip files.");
    expect(previewLimitation("LICENSE")).toBe("No in-panel preview for files without an extension.");
  });

  it("trusts an image mime even without a known extension", () => {
    expect(previewLimitation("scan", "image/png")).toBeNull();
  });

  it("reads an extension case-insensitively", () => {
    expect(fileExtension("Report.MD")).toBe("md");
  });
});

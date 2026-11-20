import { describe, expect, it } from "vitest";
import { deliverableMediaType, expectedDeliverablesSchema } from "@shiba/shared";
import { deliverableResponse } from "../src/deliverable-response.js";
import { verifyExpectedDeliverables, type CapturedFile } from "../src/run-deliverables.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const daemonHelper = new URL("../../../scripts/local-deliverables.mjs", import.meta.url);
const { captureExpectedDeliverables } = await import(daemonHelper.href) as {
  captureExpectedDeliverables(root: string, paths: string[]): Promise<CapturedFile[]>;
};

const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const cases = [
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip, "attachment"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip, "attachment"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip, "attachment"],
  ["png", "image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "inline"],
  ["jpg", "image/jpeg", jpeg, "inline"],
  ["jpeg", "image/jpeg", jpeg, "inline"],
  ["webp", "image/webp", Buffer.from("RIFF\x04\x00\x00\x00WEBP"), "inline"],
  ["gif", "image/gif", Buffer.from("GIF89a"), "inline"],
  ["mp4", "video/mp4", Buffer.from("\x00\x00\x00\x10ftypisom\x00\x00\x00\x00"), "inline"],
] as const;

describe("expanded deliverable formats", () => {
  it.each(cases)("validates and serves %s with the format's MIME type and safe disposition", async (ext, mime, bytes, disposition) => {
    const path = `reports/Quarterly results.${ext.toUpperCase()}`;
    expect(expectedDeliverablesSchema.parse([path])).toEqual([path]);
    expect(deliverableMediaType(path)).toBe(mime);
    const [artifact] = await verifyExpectedDeliverables([path], [{ path, content: bytes.toString("base64"), encoding: "base64" }]);
    expect(artifact).toMatchObject({ path, mediaType: mime, encoding: "base64", bytes: bytes.length });
    const response = deliverableResponse(path, Uint8Array.from(bytes).buffer, { inline: true });
    expect(response.headers.get("content-disposition")).toBe(`${disposition}; filename="Quarterly results.${ext.toUpperCase()}"`);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(cases)("rejects a renamed text file as %s at capture time", async (ext) => {
    const path = `renamed.${ext}`;
    await expect(verifyExpectedDeliverables([path], [{ path, content: btoa("Not binary output"), encoding: "base64" }]))
      .rejects.toThrow(new RegExp(`not a valid ${ext.toUpperCase()} file`));
  });

  it("uses the same signatures when capturing local outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiba-deliverable-format-"));
    try {
      for (const [ext, , bytes] of cases) {
        const path = `complete.${ext}`;
        await writeFile(join(dir, path), bytes);
        expect(await captureExpectedDeliverables(dir, [path])).toEqual([{ path, encoding: "base64", content: bytes.toString("base64") }]);
        await writeFile(join(dir, path), "renamed text");
        await expect(captureExpectedDeliverables(dir, [path])).rejects.toThrow(/not a valid/);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

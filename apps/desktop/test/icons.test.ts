import { readFileSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Icons are generated from apps/frontend/public/brand/shiba-mark.svg; see that folder's README. */
const assets = resolve(import.meta.dirname, "../assets");

function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(resolve(assets, file)).subarray(0, 24);
  expect(header.toString("hex", 0, 8)).toBe("89504e470d0a1a0a");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Minimal reader for the non-interlaced 8-bit RGBA PNGs the icon generator emits. */
function readRgba(file: string): Array<[number, number, number, number]> {
  const bytes = readFileSync(file);
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += length + 12;
  }
  const header = chunks.find((chunk) => chunk.type === "IHDR")!.data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  expect(header[8]).toBe(8);
  expect(header[9]).toBe(6);
  expect(header[12]).toBe(0);
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[row * (stride + 1) + 1 + x]!;
      const left = x >= 4 ? out[row * stride + x - 4]! : 0;
      const up = row > 0 ? out[(row - 1) * stride + x]! : 0;
      const upLeft = row > 0 && x >= 4 ? out[(row - 1) * stride + x - 4]! : 0;
      const restored = filter === 0 ? value
        : filter === 1 ? value + left
        : filter === 2 ? value + up
        : filter === 3 ? value + ((left + up) >> 1)
        : value + paeth(left, up, upLeft);
      out[row * stride + x] = restored & 255;
    }
  }
  const pixels: Array<[number, number, number, number]> = [];
  for (let at = 0; at < out.length; at += 4) pixels.push([out[at]!, out[at + 1]!, out[at + 2]!, out[at + 3]!]);
  return pixels;
}

describe("desktop icon assets", () => {
  it("ships the app icon main.ts loads for the dock and Windows notifications", () => {
    expect(pngSize("icon.png")).toEqual({ width: 1024, height: 1024 });
  });

  it("ships a menu-bar template and a colour tray mark for every other desktop", () => {
    expect(pngSize("trayTemplate.png")).toEqual({ width: 22, height: 22 });
    expect(pngSize("trayTemplate@2x.png")).toEqual({ width: 44, height: 44 });
    expect(pngSize("tray.png")).toEqual({ width: 16, height: 16 });
    expect(pngSize("tray@2x.png")).toEqual({ width: 32, height: 32 });
  });

  it("keeps a template tray icon monochrome so macOS can tint it", () => {
    for (const file of ["trayTemplate.png", "trayTemplate@2x.png"]) {
      // A template icon is opaque black plus alpha; any other colour ignores the system tint.
      const pixels = readRgba(resolve(assets, file)).filter((pixel) => pixel[3] > 40);
      expect(pixels.length).toBeGreaterThan(20);
      expect(pixels.every(([r, g, b]) => r === 0 && g === 0 && b === 0)).toBe(true);
    }
  });

  it("ships a multi-resolution macOS bundle icon", () => {
    const icns = readFileSync(resolve(assets, "icon.icns"));
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(statSync(resolve(assets, "icon.icns")).size);
    const types: string[] = [];
    for (let at = 8; at < icns.length;) {
      types.push(icns.toString("ascii", at, at + 4));
      at += icns.readUInt32BE(at + 4);
    }
    expect(types).toEqual(["icp4", "icp5", "ic12", "ic07", "ic08", "ic09", "ic10"]);
  });

  it("points the mac bundle at the generated icon", () => {
    expect(readFileSync(resolve(import.meta.dirname, "../electron-builder.yml"), "utf8")).toContain("icon: assets/icon.icns");
  });
});

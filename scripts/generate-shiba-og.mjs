#!/usr/bin/env node
import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Distribute the selected v2 Shiba share card from the committed source asset.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const filename = 'shiba-employees-v2.png';
const sourceDirectory = resolve(root, 'apps/web/public/assets/og');
const source = resolve(sourceDirectory, filename);
const png = readFileSync(source);
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Share card must be a PNG');
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== 2400 || height !== 1260) throw new Error('Image dimensions must match MarketingPage metadata');
if (png.length > 5_000_000) throw new Error('Share card exceeds 5 MB');

// Older direct image links also receive the current artwork.
copyFileSync(source, resolve(sourceDirectory, 'shiba-og.png'));
for (const output of ['apps/web/dist', 'public', 'app-public', 'apps/frontend/dist/client']) {
  const base = resolve(root, output);
  if (!existsSync(base)) continue;
  const directory = resolve(base, 'assets/og');
  mkdirSync(directory, { recursive: true });
  for (const name of [filename, 'shiba-og.png']) copyFileSync(source, resolve(directory, name));
}
console.log(`Share card ready: ${width}×${height}, ${png.length.toLocaleString()} bytes — ${source}`);

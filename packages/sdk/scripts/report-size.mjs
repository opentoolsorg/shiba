#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
let bytes = 0;
for (const name of readdirSync(dist)) {
  const file = path.join(dist, name);
  if (statSync(file).isFile() && name.endsWith(".js")) bytes += statSync(file).size;
}
console.log(`@shiba/sdk dist JS (unminified): ${bytes} bytes`);

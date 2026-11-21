import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Pure-logic tests only; skips vite.config.ts and its TanStack Start plugin.
export default defineConfig({
  resolve: {
    alias: {
      // Same lucide -> Hugeicons shim as vite.config.ts.
      "lucide-react": resolve(rootDir, "src/icons.tsx"),
    },
  },
  test: {
    maxWorkers: 2,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["src/**/*.test.tsx", "happy-dom"]],
    setupFiles: ["./src/test-setup.ts"],
  },
});

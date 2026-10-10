import { defineConfig } from "vitest/config";

// Pure-logic tests only; skips vite.config.ts and its TanStack Start plugin.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

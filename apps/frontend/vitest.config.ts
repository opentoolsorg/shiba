import { defineConfig } from "vitest/config";

// Pure-logic tests only; skips vite.config.ts and its TanStack Start plugin.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["src/**/*.test.tsx", "happy-dom"]],
    setupFiles: ["./src/test-setup.ts"],
  },
});

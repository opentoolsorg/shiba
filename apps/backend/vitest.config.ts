import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/sandbox": join(import.meta.dirname, "src/sandbox/npm-shim.ts"),
      "@tanstack/react-router": join(import.meta.dirname, "../frontend/node_modules/@tanstack/react-router/dist/esm/index.js"),
      "@cloudflare/ai-chat/react": join(import.meta.dirname, "../frontend/node_modules/@cloudflare/ai-chat/dist/react.js"),
      "agents/react": join(import.meta.dirname, "../frontend/node_modules/agents/dist/react.js"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  plugins: [
    {
      name: "cloudflare-scheme-stub",
      // `cloudflare:*` specifiers (pulled in transitively by agents/mcp)
      // are unresolvable under Node — evaluate a benign stub instead.
      resolveId: (id: string) =>
        id.startsWith("cloudflare:")
          ? `${import.meta.dirname}/test/cloudflare-stub.ts`
          : null,
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/vitest-setup.ts"],
    environment: "node",
    server: {
      deps: {
        // agents/mcp transitively imports cloudflare:* specifiers, which
        // Node's ESM loader cannot resolve — inlining routes them through
        // Vite so the resolveId stub above applies.
        inline: ["agents", "@cloudflare/codemode", "@cloudflare/ai-chat", "ai"],
      },
    },
  },
});

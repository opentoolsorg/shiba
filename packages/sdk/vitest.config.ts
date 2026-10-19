import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "cloudflare-scheme-stub",
      resolveId: (id: string) =>
        id.startsWith("cloudflare:")
          ? `${import.meta.dirname}/../../apps/backend/test/cloudflare-stub.ts`
          : null,
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        inline: ["agents", "@cloudflare/codemode"],
      },
    },
  },
});

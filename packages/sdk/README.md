# @shiba/sdk

Tiny, fetch-based TypeScript client for the [Shiba](https://github.com/princepal9120/shiba) public API (`/api/v1`).

- **Zero runtime dependencies** — works in Node 20+, Bun, Deno, browsers, and Cloudflare Workers.
- **Types** generated from `apps/backend/src/v1/openapi.json` (run `pnpm generate:types`).
- **License:** AGPL-3.0-only (same as the Shiba monorepo).

```ts
import { Shiba } from "@shiba/sdk";

const shiba = new Shiba({
  baseUrl: "https://your-worker.example.com",
  apiKey: process.env.SHIBA_API_KEY!,
});

const { approvalId } = await shiba.threads.create({
  repoUrl: "https://github.com/acme/repo",
  task: "Fix the flaky test",
});

for await (const event of shiba.threads.stream(threadId)) {
  console.log(event.type, event.data);
}
```

See `examples/` and the [SDK guide](https://tryshiba.dev/docs/sdk/) on the docs site.

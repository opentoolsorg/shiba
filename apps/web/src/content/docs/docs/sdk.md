---
title: TypeScript SDK
description: Use @shiba/sdk to call the public /api/v1 API from Node, Bun, Deno, browsers, and Workers.
sidebar:
  order: 2
---

The [`@shiba/sdk`](https://github.com/princepal9120/shiba/tree/main/packages/sdk) package is a **zero-runtime-dependency** fetch client for Shiba's public API. Types are generated from `GET /api/v1/openapi.json` on your Worker (`apps/backend/src/v1/openapi.json` in the repo).

## Install (monorepo)

```bash
pnpm add @shiba/sdk
```

When published, the package will ship as `@shiba/sdk` under the **AGPL-3.0-only** license (same as the rest of Shiba).

## Authentication

Mint an org-scoped API key in **Settings → API keys** (`shk_…`). Pass it as a Bearer token:

```ts
import { Shiba } from "@shiba/sdk";

const shiba = new Shiba({
  baseUrl: "https://your-worker.example.com",
  apiKey: process.env.SHIBA_API_KEY!,
});
```

`baseUrl` is the Worker origin **without** `/api/v1`; the client adds that prefix.

## Threads

```ts
// Idempotent create — requestId is generated when omitted
const receipt = await shiba.threads.create({
  repoUrl: "https://github.com/acme/repo",
  task: "Fix the flaky test",
});

const threads = await shiba.threads.list();
const thread = await shiba.threads.get("run-id");

await shiba.threads.send("run-id", {
  text: "Also update the README",
  delivery: "queue", // or "interrupt"
});
```

## Event stream (SSE)

```ts
for await (const event of shiba.threads.stream(threadId)) {
  console.log(event.type, event.data);
}
```

The iterator reconnects with `Last-Event-ID` after transient disconnects. Pass `{ reconnect: false }` to stop after the first connection.

## Pull requests

Read-only helpers wrap the thread-scoped PR routes:

```ts
const status = await shiba.pullRequests.status(threadId);
const comments = await shiba.pullRequests.comments(threadId);
const review = await shiba.pullRequests.review(threadId);
```

## Errors and retries

Failed responses throw `ShibaApiError` with `status` and a **redacted** `body` (API keys and bearer tokens are stripped). Idempotent requests (`GET`, thread `create` with `requestId`, and `send` with `clientKey`) retry on `408`, `429`, and `5xx` with exponential backoff.

## Regenerating types

When `apps/backend/src/v1/openapi.json` changes:

```bash
pnpm -C packages/sdk generate:types
pnpm -C packages/sdk check:types   # CI sync check
```

## Examples

Runnable samples live under `packages/sdk/examples/` in the repository.

/**
 * Example: create a thread and print SSE events (Node 20+).
 *
 *   SHIBA_BASE_URL=https://your-worker SHIBA_API_KEY=shk_… pnpm exec tsx packages/sdk/examples/create-and-stream.ts
 */
import { Shiba } from "../src/index.js";

const baseUrl = process.env.SHIBA_BASE_URL;
const apiKey = process.env.SHIBA_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Set SHIBA_BASE_URL and SHIBA_API_KEY");
  process.exit(1);
}

const shiba = new Shiba({ baseUrl, apiKey });
const created = await shiba.threads.create({
  repoUrl: "https://github.com/acme/demo",
  task: "Say hello from the SDK example",
});
console.log("created", created);

const threadId = created.threadId ?? created.id;
if (!threadId) {
  console.log("Waiting for approval — no thread id yet.");
  process.exit(0);
}

for await (const event of shiba.threads.stream(threadId, { reconnect: true })) {
  console.log(event.type, event.data);
  if (event.type === "run.completed" || event.type === "run.failed") break;
}

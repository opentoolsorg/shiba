/** Node driver for `codex app-server` + ChatGPT plan (ACCESS_TOKEN only). */
export function codexChatGptPlanDriverPath(sandboxId: string): string {
  return `/workspace/${sandboxId}.codex-plan-driver.cjs`;
}

export const CODEX_CHATGPT_PLAN_LAUNCH_ARGS = [
  'model_provider="openai_chatgpt_plan"',
  'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  'model_providers.openai_chatgpt_plan.wire_api="responses"',
  "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
  "model_providers.openai_chatgpt_plan.supports_websockets=false",
];

export function codexChatGptPlanDriverSource(run: {
  task: string;
  model: string | null;
  threadId: string | null;
}): string {
  const cfg = JSON.stringify({ ...run, launchArgs: CODEX_CHATGPT_PLAN_LAUNCH_ARGS });
  return `"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const cfg = ${cfg};
let nextId = 1;
const pending = new Map();
function send(proc, msg) { proc.stdin.write(JSON.stringify(msg) + "\\n"); }
function rpc(proc, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send(proc, { jsonrpc: "2.0", id, method, params });
  });
}
function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "rpc error"));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "turn/delta" && msg.params?.delta) {
    process.stdout.write(JSON.stringify({ type: "text", text: String(msg.params.delta) }) + "\\n");
  }
  if (msg.method === "turn/completed" && msg.params?.status && msg.params.status !== "completed") {
    process.stdout.write(JSON.stringify({ type: "error", message: "turn not completed" }) + "\\n");
  }
}
async function main() {
  const token = process.env.ACCESS_TOKEN;
  if (!token) {
    process.stdout.write(JSON.stringify({ type: "error", message: "ACCESS_TOKEN missing" }) + "\\n");
    process.exit(1);
  }
  const args = ["app-server", "--listen", "stdio://"];
  for (const entry of cfg.launchArgs) args.push("-c", entry);
  const proc = spawn("codex", args, {
    env: { ...process.env, ACCESS_TOKEN: token, OPENAI_API_KEY: "", OPENAI_BASE_URL: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  readline.createInterface({ input: proc.stdout }).on("line", onLine);
  await rpc(proc, "initialize", { clientInfo: { name: "shiba", version: "1" } });
  send(proc, { jsonrpc: "2.0", method: "initialized", params: {} });
  let threadId = cfg.threadId;
  if (!threadId) {
    const started = await rpc(proc, "thread/start", {});
    threadId = started?.threadId || started?.thread_id;
    if (threadId) process.stdout.write(JSON.stringify({ type: "thread", threadId }) + "\\n");
  } else {
    await rpc(proc, "thread/resume", { threadId });
  }
  await rpc(proc, "turn/start", { threadId, input: cfg.task, ...(cfg.model ? { model: cfg.model } : {}) });
  proc.stdin.end();
  proc.on("close", (code) => process.exit(code ?? 0));
}
main().catch((err) => {
  process.stdout.write(JSON.stringify({ type: "error", message: String(err.message || err) }) + "\\n");
  process.exit(1);
});
`;
}

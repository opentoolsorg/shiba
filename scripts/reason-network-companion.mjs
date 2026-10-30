import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import process from "node:process";

/** Minimal JSON-RPC client for the upstream documented MCP stdio transport. */
export async function connectReasonNetworkStdio({ executablePath, timeoutMs = 120_000 }) {
  if (typeof executablePath !== "string" || !executablePath.startsWith("/")) throw new TypeError("Reason Network executable must be an absolute path.");
  const child = spawn(executablePath, ["mcp"], {
    shell: false,
    stdio: ["pipe", "pipe", "inherit"],
    env: Object.fromEntries(["HOME", "LOGNAME", "PATH", "SHELL", "USER", "REASON_NETWORK_HOME", "XDG_CONFIG_HOME"]
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]])),
  });
  await Promise.race([
    once(child, "spawn"),
    once(child, "error").then(([error]) => Promise.reject(error)),
  ]);
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const rejectPending = (error) => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`MCP ${message.error.code ?? "error"}: ${String(message.error.message ?? "request failed")}`));
    else entry.resolve(message.result);
  });
  child.once("error", (error) => { closed = true; rejectPending(error); });
  child.once("close", (code) => { closed = true; rejectPending(new Error(`Reason Network MCP process closed (${code}).`)); });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed || !child.stdin.writable) return reject(new Error("Reason Network MCP process is unavailable."));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Reason Network MCP ${method} timed out.`)); }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  try {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "shiba-local-reason-companion", version: "0.1.0" },
    });
    notify("notifications/initialized");
  } catch (error) {
    lines.close(); child.kill("SIGTERM"); throw error;
  }
  return {
    async listTools() { return await request("tools/list", {}); },
    async callTool(input) { return await request("tools/call", input); },
    async close() {
      if (!closed) {
        lines.close(); child.stdin.end();
        await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
        if (!closed) child.kill("SIGTERM");
      }
    },
  };
}

/** Protocol core is injectable so tests can run a deterministic in-process companion. */
export function createReasonNetworkCompanion({ connect, beforeSend = async () => true }) {
  return async function send(operation) {
    const client = await connect();
    try {
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "send_message")) throw new Error("Reason Network MCP server has no send_message tool.");
      if (!(await beforeSend(operation))) return { state: "cancelled" };
      const response = await client.callTool({
        name: "send_message",
        arguments: { to: operation.destination, message: operation.message, idempotency_key: operation.idempotencyKey, ...(operation.replyTo ? { reply_to: operation.replyTo } : {}) },
        _meta: { sessionId: operation.sessionId },
      });
      if (response.isError) return { state: "unknown" };
      const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const id = text.match(/\bmessage id\s+([A-Za-z0-9._:-]+)\b/i)?.[1];
      return id ? { state: "accepted", messageId: id } : { state: "unknown" };
    } finally {
      await client.close().catch(() => {});
    }
  };
}

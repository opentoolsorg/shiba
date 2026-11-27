// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmployeeRuntimeExecution, EmployeeRuntimeMessage } from "@shiba/shared";
import { BotRuntimeChat } from "./BotRuntimeChat";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const encoder = new TextEncoder();
const execution: EmployeeRuntimeExecution = {
  id: "run_1", conversationId: "thread-1", mode: "chat", status: "running", checkpoint: "inference", createdAt: 1, updatedAt: 1,
};
const assistant: EmployeeRuntimeMessage = { id: "msg_a", conversationId: "thread-1", role: "assistant", content: "Hello there", createdAt: 2 };
const user: EmployeeRuntimeMessage = { id: "msg_u", conversationId: "thread-1", role: "user", content: "hello?", createdAt: 1 };

function streamResponse(events: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function json(body: unknown): Response {
  return Response.json(body);
}

describe("BotRuntimeChat", () => {
  it("streams an answer without sandbox setup and reloads the persisted thread", async () => {
    const workspaceId = `ws_${"a".repeat(24)}`;
    let stateReads = 0;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path.includes("/runtime/state")) {
        stateReads += 1;
        return json(stateReads === 1
          ? { conversationId: "thread-1", messages: [], memories: [], executions: [] }
          : { conversationId: "thread-1", messages: [user, assistant], memories: [], executions: [{ ...execution, status: "completed" }] });
      }
      if (path.includes("/runtime/chat/stream")) {
        return streamResponse([
          { type: "execution", execution },
          { type: "delta", text: "Hello" },
          { type: "delta", text: " there" },
          { type: "done", execution: { ...execution, status: "completed" }, message: assistant, answer: assistant.content },
        ]);
      }
      throw new Error(`unexpected fetch ${path}`);
    }));
    render(<BotRuntimeChat agentId="agent-1" workspaceId={workspaceId} conversationId="thread-1" />);
    expect(await screen.findByText(/No runtime messages yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Runtime message/), { target: { value: "hello?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send runtime message" }));
    expect(await screen.findByText("Hello there")).toBeTruthy();
    await waitFor(() => expect(stateReads).toBeGreaterThan(1));
    const stream = calls.find((call) => call.path.includes("/runtime/chat/stream"));
    expect(JSON.parse(String(stream?.init?.body))).toEqual({ conversationId: "thread-1", message: "hello?", mode: "chat" });
    expect(new Headers(stream?.init?.headers).get("X-Shiba-Workspace")).toBe(workspaceId);
    expect(screen.queryByText(/sandbox setup/i)).toBeNull();
    expect(screen.getByText(/Lightweight Chat mode uses/).parentElement?.className).toContain("flex-col");
  });

  it("keeps drafts separate when the selected thread changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const conversationId = new URL(String(input), "https://x").searchParams.get("conversationId") ?? "thread-1";
      return json({ conversationId, messages: [], memories: [], executions: [] });
    }));
    const { rerender } = render(<BotRuntimeChat agentId="agent-1" conversationId="thread-1" />);
    const box = () => screen.getByLabelText(/Runtime message/) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: "first thread draft" } });
    rerender(<BotRuntimeChat agentId="agent-1" conversationId="thread-2" />);
    expect(box().value).toBe("");
    fireEvent.change(box(), { target: { value: "second thread draft" } });
    rerender(<BotRuntimeChat agentId="agent-1" conversationId="thread-1" />);
    expect(box().value).toBe("first thread draft");
    rerender(<BotRuntimeChat agentId="agent-1" conversationId="thread-2" />);
    expect(box().value).toBe("second thread draft");
  });

  it("keeps an oversized draft in the composer instead of posting it", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path.includes("/runtime/state")) return json({ conversationId: "thread-1", messages: [], memories: [], executions: [] });
      throw new Error(`unexpected fetch ${path}`);
    }));
    render(<BotRuntimeChat agentId="agent-1" conversationId="thread-1" />);
    const oversized = "x".repeat(12001);
    const box = screen.getByLabelText(/Runtime message/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: oversized } });
    fireEvent.click(screen.getByRole("button", { name: "Send runtime message" }));
    expect(await screen.findByText(/12,000 characters or fewer/)).toBeTruthy();
    expect(box.value).toBe(oversized);
    expect(calls.some((path) => path.includes("/runtime/chat/stream"))).toBe(false);
  });

  it("recovers interrupted work against the selected thread", async () => {
    let recovered = false;
    const recoverBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/runtime/state")) {
        return json({
          conversationId: "thread-1", messages: [user], memories: [],
          executions: recovered ? [] : [{ ...execution, status: "running", checkpoint: "inference", recoverable: true }],
          permissions: { canRecover: true },
        });
      }
      if (path.includes("/runtime/recover")) {
        recoverBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        recovered = true;
        return json({ interrupted: 1, recovered: 1, completed: 0, failed: 0, skipped: 0 });
      }
      throw new Error(`unexpected fetch ${path}`);
    }));
    render(<BotRuntimeChat agentId="agent-1" conversationId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Recover interrupted work" }));
    await waitFor(() => expect(recoverBodies).toEqual([{ conversationId: "thread-1" }]));
    await waitFor(() => expect(screen.queryByText("Interrupted runtime work needs recovery.")).toBeNull());
  });

  it("cancels the active streamed execution against the exact thread", async () => {
    const streamControl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    const cancelBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/runtime/state")) return json({ conversationId: "thread-1", messages: [], memories: [], executions: [] });
      if (path.includes("/runtime/chat/stream")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamControl.current = controller;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "execution", execution })}\n\n`));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (path.includes("/runtime/cancel")) {
        cancelBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ cancelled: true, execution: { ...execution, status: "cancelled" } });
      }
      throw new Error(`unexpected fetch ${path}`);
    }));
    render(<BotRuntimeChat agentId="agent-1" conversationId="thread-1" />);
    fireEvent.change(screen.getByLabelText(/Runtime message/), { target: { value: "hello?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send runtime message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop generating" }));
    await waitFor(() => expect(cancelBodies).toEqual([{ executionId: "run_1", conversationId: "thread-1" }]));
    streamControl.current?.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Employee execution was cancelled.", execution: { ...execution, status: "cancelled" } })}\n\n`));
    streamControl.current?.close();
    expect(await screen.findByText("Employee execution was cancelled.")).toBeTruthy();
  });
});

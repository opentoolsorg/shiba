// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app";
import { ONBOARDING_DISMISSED_KEY } from "./components/AgentExperience";

const mocks = vi.hoisted(() => ({
  agent: { identified: true, readyState: 1, addEventListener: vi.fn(), removeEventListener: vi.fn(), reconnect: vi.fn() },
  chat: { messages: [], status: "ready", setMessages: vi.fn(), sendMessage: vi.fn() },
  tools: { runsById: {} },
  router: { history: { replace: (path: string) => window.history.replaceState(null, "", path), push: (path: string) => window.history.pushState(null, "", path) } },
}));
vi.mock("agents/react", () => ({ useAgent: () => mocks.agent, useAgentToolEvents: () => mocks.tools }));
vi.mock("@cloudflare/ai-chat/react", () => ({ useAgentChat: () => mocks.chat }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks.router }));
vi.mock("./socket-liveness", () => ({ useSocketLiveness: vi.fn() }));
vi.mock("./components/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }) }));
vi.mock("./components/FirstRunWizard", () => ({ FirstRunWizard: () => null, ONBOARDING_STORAGE_KEY: "onboarding" }));
vi.mock("./conversation-room-realtime", () => ({
  useConversationRoomRealtime: () => ({ viewerId: "viewer", status: "offline", viewers: [], remoteStream: null, startStream: () => "stream", finishStream: vi.fn() }),
}));

const thread = { id: "11111111-1111-4111-8111-111111111111", name: "Another conversation", agentName: "another-agent", createdAt: 1, updatedAt: 1 };
beforeEach(() => {
  window.history.replaceState(null, "", "/threads/");
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
  mocks.chat.sendMessage.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
    if (path === "/api/sessions") return Response.json({ sessions: [thread], defaultSessionId: "default" });
    if (path === `/api/sessions/${thread.id}/resume`) return Response.json({ session: thread, resumed: true });
    if (path.endsWith("/chat-suggestions")) return Response.json({ suggestions: ["Discuss the agenda"] });
    return Response.json({ workspaces: [], runs: [], approvals: [], decided: [], agents: [], connections: [], computers: [], entries: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const create = () => waitFor(() => {
  const picker = screen.getByRole("combobox", { name: "Create for this message" });
  expect(picker).toHaveProperty("disabled", false);
  return picker;
});
const edit = (text: string) => fireEvent.change(screen.getByRole("textbox", { name: "Message Shiba" }), { target: { value: text } });
const send = async (text: string) => {
  edit(text);
  const count = mocks.chat.sendMessage.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(mocks.chat.sendMessage).toHaveBeenCalledTimes(count + 1));
  return mocks.chat.sendMessage.mock.lastCall?.[0];
};

it("sends exactly one Create choice, leaves it out by default, and keeps lookup choices independent", async () => {
  render(<App />);
  const picker = await create();
  const metadata = { shibaMode: "chat", shibaRoomViewerId: "viewer" };
  expect(await send("Just chatting")).toEqual({ text: "Just chatting", metadata });
  expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Create: None", "Image", "Video", "Report", "Page"]);
  const lookups = within(screen.getByRole("group", { name: "Lookups for this message" }));
  fireEvent.click(lookups.getByRole("button", { name: "Web" }));
  fireEvent.click(lookups.getByRole("button", { name: "Knowledge" }));
  const withLookups = { ...metadata, shibaChatTools: ["web_search", "knowledge_search"] };
  for (const choice of ["image", "video", "report", "page"]) {
    fireEvent.change(picker, { target: { value: choice } });
    expect(await send("Make this")).toEqual({ text: "Make this", metadata: { ...withLookups, shibaChatCreate: choice } });
    expect(picker).toHaveProperty("value", "");
  }
  expect(await send("Continue")).toEqual({ text: "Continue", metadata: withLookups });
  fireEvent.change(picker, { target: { value: "page" } });
  fireEvent.change(picker, { target: { value: "" } });
  expect(await send("Changed my mind")).toEqual({ text: "Changed my mind", metadata: withLookups });
});

it("drops the unsent grant when clearing a draft or reviewing it as Work", async () => {
  render(<App />);
  const picker = await create();
  edit("First draft");
  fireEvent.change(picker, { target: { value: "report" } });
  edit("");
  expect(picker).toHaveProperty("value", "");
  fireEvent.change(picker, { target: { value: "report" } });
  fireEvent.click(await screen.findByRole("button", { name: "Discuss the agenda" }));
  expect(picker).toHaveProperty("value", "");
  edit("Next draft");
  fireEvent.change(picker, { target: { value: "image" } });
  fireEvent.click(screen.getByRole("button", { name: "Review as work" }));
  expect(screen.queryByRole("combobox", { name: "Create for this message" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
  expect(await create()).toHaveProperty("value", "");
  expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  expect((await send("Next draft")).metadata).not.toHaveProperty("shibaChatCreate");
});

it("keeps the choice with a rejected draft and consumes it on the successful retry", async () => {
  render(<App />);
  const picker = await create();
  const draft = "Make a report";
  edit(draft);
  fireEvent.change(picker, { target: { value: "report" } });
  let reject!: (error: Error) => void;
  mocks.chat.sendMessage.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; }));
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(picker).toHaveProperty("disabled", true));
  await act(async () => reject(new Error("Disconnected")));
  expect(screen.getByRole("textbox", { name: "Message Shiba" })).toHaveProperty("value", draft);
  expect(picker).toHaveProperty("value", "report");
  expect(mocks.chat.sendMessage.mock.lastCall?.[0].metadata.shibaChatCreate).toBe("report");
  expect((await send(draft)).metadata.shibaChatCreate).toBe("report");
  expect(picker).toHaveProperty("value", "");
});

it("does not take an unsent Create choice into another conversation", async () => {
  render(<App />);
  const picker = await create();
  edit("Keep this draft");
  fireEvent.change(picker, { target: { value: "video" } });
  fireEvent.click(await screen.findByRole("button", { name: /Another conversation/ }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(thread.id));
  expect(await create()).toHaveProperty("value", "");
  expect((await send("Different conversation")).metadata).not.toHaveProperty("shibaChatCreate");
});

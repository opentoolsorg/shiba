// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomAgentsView, type CustomAgentWire } from "./CustomAgentsView";

const agent: CustomAgentWire = {
  id: "cag-reviewer", slug: "reviewer", version: 3,
  config: { name: "Reviewer", instructions: "Inspect every change", harness: "opencode",
    codingModel: "google/model-a", connectionId: "google-ready", sandboxProvider: "cloudflare",
    approvalPolicy: "standard", toolScopes: [] },
};
const connections = [{ id: "google-ready", label: "Google workspace", service: "google", status: "ready" as const }];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("saves selected model and ready connection from the creation form", async () => {
  const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ agent }, { status: 201 }) : Response.json({ agents: [] }));
  vi.stubGlobal("fetch", request);
  render(<CustomAgentsView connections={connections} modelSuggestions={["google/model-a"]} />);
  await screen.findByText("No bots");
  fireEvent.change(screen.getByLabelText("Slug", { exact: true }), { target: { value: "reviewer" } });
  fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Reviewer" } });
  fireEvent.change(screen.getByLabelText("Instructions", { exact: true }), { target: { value: "Inspect changes" } });
  fireEvent.change(screen.getByLabelText("Model", { exact: true }), { target: { value: "google/model-a" } });
  fireEvent.change(screen.getByLabelText("Model connection", { exact: true }), { target: { value: "google-ready" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await screen.findByText("Bot created.");
  const submission = request.mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(submission?.[1]?.body)).config).toMatchObject({ codingModel: "google/model-a", connectionId: "google-ready" });
});

it("preserves saved settings while clearing an optional model during edit", async () => {
  const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
    ? Response.json({ agent: { ...agent, version: 4 } }) : Response.json({ agents: [agent] }));
  vi.stubGlobal("fetch", request);
  render(<CustomAgentsView connections={connections} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit bot" }));
  fireEvent.change(screen.getByLabelText("Model", { exact: true }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Bot updated.");
  const submission = request.mock.calls.find(([, init]) => init?.method === "PATCH");
  const body = JSON.parse(String(submission?.[1]?.body));
  expect(body.expectedVersion).toBe(3);
  expect(body.config).toMatchObject({ approvalPolicy: "standard", toolScopes: [], connectionId: "google-ready" });
  expect(body.config).not.toHaveProperty("codingModel");
});

it("keeps conflicting edits until the user explicitly reloads the latest version", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return Response.json({ error: "Version conflict" }, { status: 409 });
    if (url.endsWith("/cag-reviewer")) return Response.json({ agent: { ...agent, version: 4, config: { ...agent.config, name: "New server name" } } });
    return Response.json({ agents: [agent] });
  }));
  render(<CustomAgentsView />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit bot" }));
  fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "My unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/Your draft is preserved/);
  expect((screen.getByLabelText("Name", { exact: true }) as HTMLInputElement).value).toBe("My unsaved draft");
  fireEvent.click(screen.getByRole("button", { name: "Reload latest bot" }));
  await waitFor(() => expect((screen.getByLabelText("Name", { exact: true }) as HTMLInputElement).value).toBe("New server name"));
});

it("archives and restores profiles without offering execution from the archived directory", async () => {
  let archived = false;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      archived = url.endsWith("/archive");
      return Response.json({ agent: { ...agent, ...(archived ? { archivedAt: 123 } : {}) } });
    }
    return Response.json({ agents: url.includes("archived=true") === archived ? [agent] : [] });
  });
  vi.stubGlobal("fetch", request);
  render(<CustomAgentsView onStartThread={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Archive bot Reviewer" }));
  await screen.findByText(/Bot archived/);
  fireEvent.click(screen.getByRole("button", { name: "Archived bots" }));
  await screen.findByRole("button", { name: "Restore bot Reviewer" });
  expect(screen.queryByRole("button", { name: "Launch bot Reviewer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit bot" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore bot Reviewer" }));
  await screen.findByText("Bot restored.");
  fireEvent.click(screen.getByRole("button", { name: "Active bots" }));
  await screen.findByRole("button", { name: "Launch bot Reviewer" });
  expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
});

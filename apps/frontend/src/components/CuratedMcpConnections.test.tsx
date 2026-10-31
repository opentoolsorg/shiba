// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuratedMcpConnections } from "./CuratedMcpConnections";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CuratedMcpConnections", () => {
  it.each(["OAuth", "bearer"])("releases a failed %s draft so bearer fallback can use the same label", async (failureMode) => {
    let activeDraft: string | null = null;
    let nextId = 0;
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ path, method, body });
      if (path.endsWith("/catalog-connections")) return Response.json({ connections: [] });
      if (path === "/api/v1/mcp/servers" && method === "POST") {
        if (activeDraft) return Response.json({ error: "connection_label_taken" }, { status: 409 });
        activeDraft = `server-${++nextId}`;
        return Response.json({ server: { id: activeDraft } }, { status: 201 });
      }
      if (path.endsWith("/oauth/begin")) {
        return Response.json({ error: "oauth_client_not_configured" }, { status: 503 });
      }
      if (path === `/api/v1/mcp/servers/${activeDraft}` && method === "DELETE") {
        activeDraft = null;
        return Response.json({ ok: true, disabled: true });
      }
      if (path.endsWith("/bearer") && failureMode === "bearer" && nextId === 1) {
        return Response.json({ error: "invalid_bearer_token" }, { status: 400 });
      }
      if (path.endsWith("/bearer") || path.endsWith("/discover")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 404 });
    }));
    render(<CuratedMcpConnections />);
    const label = screen.getAllByLabelText("Label")[0];
    const bearer = screen.getAllByLabelText("Bearer fallback (optional)")[0];
    const connect = screen.getAllByRole("button", { name: "Connect with OAuth" })[0];
    const saveBearer = screen.getAllByRole("button", { name: "Save bearer fallback" })[0];
    if (!label || !bearer || !connect || !saveBearer) throw new Error("Missing vendor connection controls");
    fireEvent.change(label, { target: { value: "prod" } });
    fireEvent.change(bearer, { target: { value: "vendor-token" } });
    fireEvent.click(failureMode === "OAuth" ? connect : saveBearer);
    expect(await screen.findByText(failureMode === "OAuth" ? "oauth_client_not_configured" : "invalid_bearer_token")).toBeTruthy();
    expect(requests.some(({ path, method }) => path === "/api/v1/mcp/servers/server-1" && method === "DELETE")).toBe(true);
    fireEvent.click(saveBearer);
    expect(await screen.findByText("Bearer saved — discover tools below in External MCP.")).toBeTruthy();
    await waitFor(() => expect(requests.find(({ path }) => path.endsWith("/bearer"))?.body).toEqual({ token: "vendor-token" }));
    const creates = requests.filter(({ path, method }) => path === "/api/v1/mcp/servers" && method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.body).toEqual(creates[1]?.body);
  });
});

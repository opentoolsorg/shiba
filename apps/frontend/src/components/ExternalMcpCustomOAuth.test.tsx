// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalMcpManagement } from "./ExternalMcpManagement";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(options: { registered?: boolean; authorizationUrl?: string; delayed?: Promise<Response> } = {}) {
  const server = { id: "custom-server", generation: 1, name: "Custom team", transport: "streamable_http", endpoint: "https://mcp.customer.com/mcp",
    credentialRef: null, authMode: "oauth", catalogId: null, status: "draft", health: "unknown", tools: [] };
  let registered = options.registered ?? true;
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    if (path === "/api/agents") return Response.json({ principals: [] });
    if (path === "/api/v1/mcp/servers" && method === "GET") return Response.json({ servers: registered ? [server] : [] });
    if (path === "/api/v1/mcp/servers" && method === "POST") { registered = true; return Response.json({ server }); }
    if (path.endsWith("/tools")) return Response.json({ tools: [], access: [] });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.endsWith("/oauth/begin")) return options.delayed ?? Response.json({ authorizationUrl: options.authorizationUrl ?? "https://auth.customer.com/authorize?state=fixture" });
    if (path === "/api/v1/mcp/servers/custom-server" && method === "DELETE") { server.status = "disabled"; return Response.json({ ok: true }); }
    if (path === "/api/v1/mcp/servers/custom-server" && method === "PATCH") { server.generation++; return Response.json({ server }); }
    return Response.json({ error: "Unexpected request" }, { status: 400 });
  });
  vi.stubGlobal("fetch", network); render(<ExternalMcpManagement />);
  return { network, server };
}
async function fillOAuth() {
  fireEvent.change(await screen.findByLabelText("OAuth issuer URL"), { target: { value: "https://auth.customer.com/tenant" } });
  fireEvent.change(screen.getByLabelText("OAuth public client ID"), { target: { value: "registered-public-client" } });
}
describe("custom MCP OAuth dashboard", () => {
  it("creates a custom OAuth draft without credential references or automatic discovery", async () => {
    const { network } = setup({ registered: false });
    fireEvent.change(screen.getByLabelText("MCP server name"), { target: { value: "Custom team" } });
    fireEvent.change(screen.getByLabelText("MCP server HTTPS endpoint"), { target: { value: "https://mcp.customer.com/mcp" } });
    fireEvent.change(screen.getByLabelText("MCP credential reference"), { target: { value: "MCP_CREDENTIAL_OLD" } });
    fireEvent.change(screen.getByLabelText("MCP authentication"), { target: { value: "oauth" } });
    expect(screen.queryByLabelText("MCP credential reference")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByLabelText("OAuth issuer URL");
    const creation = network.mock.calls.find(([url, init]) => String(url) === "/api/v1/mcp/servers" && init?.method === "POST");
    expect(JSON.parse(String(creation?.[1]?.body))).toMatchObject({ authMode: "oauth", credentialRef: null });
    expect(network.mock.calls.some(([url]) => /\/oauth\/begin|\/discover/.test(String(url)))).toBe(false);
  });
  it("shows an explicit safe sign-in link then refreshes to the review state", async () => {
    const { network, server } = setup(); await fillOAuth();
    const discover = screen.getByRole("button", { name: "Discover / retry" });
    expect((discover as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(discover);
    expect(network.mock.calls.some(([url]) => String(url).endsWith("/discover"))).toBe(false);
    fireEvent.change(screen.getByLabelText("OAuth scopes"), { target: { value: "reports:read" } });
    fireEvent.click(screen.getByRole("button", { name: "Start custom OAuth" }));
    const link = await screen.findByRole("link", { name: "Continue custom OAuth sign-in" });
    expect(link.getAttribute("href")).toBe("https://auth.customer.com/authorize?state=fixture");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const begin = network.mock.calls.find(([url]) => String(url).endsWith("/oauth/begin"));
    expect(JSON.parse(String(begin?.[1]?.body))).toEqual({ issuer: "https://auth.customer.com/tenant", clientId: "registered-public-client", scopes: "reports:read", redirectUri: `${window.location.origin}/api/v1/mcp/oauth/callback` });
    server.status = "discovered";
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection status" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Continue custom OAuth sign-in" })).toBeNull());
    expect(network.mock.calls.some(([url]) => /\/(review|enable|grant)$/.test(String(url)))).toBe(false);
  });
  it.each(["javascript:alert(1)", "https://untrusted.net/authorize", "https://user:pass@auth.customer.com/authorize", "https://auth.customer.com/authorize#fragment"])("does not expose unsafe authorization target %s", async (authorizationUrl) => {
    setup({ authorizationUrl }); await fillOAuth(); fireEvent.click(screen.getByRole("button", { name: "Start custom OAuth" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "OAuth returned an unsafe sign-in URL.");
    expect(screen.queryByRole("link", { name: "Continue custom OAuth sign-in" })).toBeNull();
  });
  it("does not duplicate a pending start or restore its link after disable", async () => {
    let finish: (response: Response) => void = () => {};
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const { network } = setup({ delayed }); await fillOAuth();
    const start = screen.getByRole("button", { name: "Start custom OAuth" }); fireEvent.click(start); fireEvent.click(start);
    await waitFor(() => expect(network.mock.calls.filter(([url]) => String(url).endsWith("/oauth/begin"))).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Disable server" }));
    await waitFor(() => expect(screen.queryByLabelText("OAuth issuer URL")).toBeNull());
    finish(Response.json({ authorizationUrl: "https://auth.customer.com/authorize?state=late" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Continue custom OAuth sign-in" })).toBeNull());
  });
  it("clears the displayed link when authorization settings change", async () => {
    setup(); await fillOAuth(); fireEvent.click(screen.getByRole("button", { name: "Start custom OAuth" }));
    await screen.findByRole("link", { name: "Continue custom OAuth sign-in" });
    fireEvent.change(screen.getByLabelText("OAuth issuer URL"), { target: { value: "https://auth.customer.com/another-tenant" } });
    expect(screen.queryByRole("link", { name: "Continue custom OAuth sign-in" })).toBeNull();
  });
  it.each([false, true])("invalidates pending consent after credential reference changes (in flight: %s)", async (inFlight) => {
    let finish: (response: Response) => void = () => {};
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const { network } = setup(inFlight ? { delayed } : {}); await fillOAuth();
    fireEvent.click(screen.getByRole("button", { name: "Start custom OAuth" }));
    await waitFor(() => expect(network.mock.calls.some(([url]) => String(url).endsWith("/oauth/begin"))).toBe(true));
    if (!inFlight) await screen.findByRole("link", { name: "Continue custom OAuth sign-in" });
    fireEvent.change(screen.getByLabelText("Edit Custom team credential reference"), { target: { value: "MCP_CREDENTIAL_NEW" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect((screen.getByLabelText("OAuth issuer URL") as HTMLInputElement).value).toBe(""));
    finish(Response.json({ authorizationUrl: "https://auth.customer.com/authorize?state=stale" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Continue custom OAuth sign-in" })).toBeNull());
  });
});

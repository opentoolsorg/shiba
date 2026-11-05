// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SkillsView } from "./SkillsView";

const serverSkill = (overrides: Record<string, unknown> = {}) => ({
  id: "skill-aaaaaaaaaaaaaaaaaaaaaaaa", version: 1, status: "draft", owned: true,
  name: "Imported", instructions: "Original notes", createdAt: 1, updatedAt: 1, ...overrides,
});
const localStorageMock = (entries: Record<string, string> = {}) => {
  const values = new Map(Object.entries(entries));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  return values;
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
function renderRunAttachedSkills() {
  render(<SkillsView />);
  fireEvent.click(screen.getByRole("button", { name: "Run-attached skills" }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SkillsView recovery and draft races", () => {
  it("rerenders an initial load error and retries successfully", async () => {
    localStorageMock();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/v1/extensions/skills")) return json([]);
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      reads += 1;
      return reads === 1 ? json({ error: "temporarily unavailable" }, 503) : json({ skills: [serverSkill({ name: "Recovered" })] });
    }));
    renderRunAttachedSkills();
    expect((await screen.findByRole("alert")).textContent).toContain("temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("imports legacy notes and source as a draft without deleting or activating the local record", async () => {
    const local = localStorageMock({
      "shiba-skills-v1": JSON.stringify([{ id: "brief", name: "Brief writing", notes: "Keep it concise.", repoUrl: "https://github.com/acme/brief" }]),
    });
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.startsWith("/api/v1/extensions/skills")) return json([]);
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      return method === "GET" ? json({ skills: [] }) : json({ skill: serverSkill({ name: String(body?.name), instructions: String(body?.instructions), sourceUrl: body?.sourceUrl }) }, 201);
    }));
    renderRunAttachedSkills();
    fireEvent.click(await screen.findByRole("button", { name: "Import legacy skills as drafts" }));
    await screen.findByRole("status");
    await waitFor(() => expect(screen.getByText("draft · v1")).toBeTruthy());
    expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
      name: "Brief writing",
      instructions: "Keep it concise.\n\nLegacy source: https://github.com/acme/brief",
      sourceUrl: "https://github.com/acme/brief",
    });
    expect(screen.queryByRole("button", { name: "Activate reviewed version" })).toBeNull();
    expect(JSON.parse(local.get("shiba-skills-v1")!)).toEqual([
      { id: "brief", name: "Brief writing", notes: "Keep it concise.", repoUrl: "https://github.com/acme/brief" },
    ]);
  });

  it("does not clear newer editor changes when an earlier save completes", async () => {
    localStorageMock();
    const post = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/v1/extensions/skills")) return json([]);
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      if (init?.method === "POST") return post.promise;
      return json({ skills: [] });
    }));
    renderRunAttachedSkills();
    fireEvent.change(await screen.findByLabelText("Skill name"), { target: { value: "First version" } });
    fireEvent.change(screen.getByLabelText("Skill instructions"), { target: { value: "First instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "New unsaved edit" } });
    fireEvent.change(screen.getByLabelText("Skill instructions"), { target: { value: "New unsaved instructions" } });
    post.resolve(json({ skill: serverSkill({ name: "First version", instructions: "First instructions" }) }, 201));
    await waitFor(() => expect((screen.getByLabelText("Skill name") as HTMLInputElement).value).toBe("New unsaved edit"));
    expect((screen.getByLabelText("Skill instructions") as HTMLTextAreaElement).value).toBe("New unsaved instructions");
  });

  it("ignores a late history response after selecting another skill", async () => {
    localStorageMock();
    const alpha = deferred<Response>(); const beta = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/extensions/skills")) return json([]);
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      if (url.startsWith("/api/skills?") ) return json({ skills: [
        serverSkill({ id: "skill-aaaaaaaaaaaaaaaaaaaaaaaa", name: "Alpha", instructions: "Current alpha" }),
        serverSkill({ id: "skill-bbbbbbbbbbbbbbbbbbbbbbbb", name: "Beta", instructions: "Current beta" }),
      ] });
      if (url.includes("skill-aaaaaaaaaaaaaaaaaaaaaaaa/versions")) return alpha.promise;
      if (url.includes("skill-bbbbbbbbbbbbbbbbbbbbbbbb/versions")) return beta.promise;
      return json({ skills: [] });
    }));
    renderRunAttachedSkills();
    await screen.findByText("Alpha");
    const versionButtons = screen.getAllByRole("button", { name: "Versions" });
    fireEvent.click(versionButtons[0]!);
    fireEvent.click(versionButtons[1]!);
    beta.resolve(json({ versions: [{ version: 1, name: "Beta", instructions: "Beta prior instructions", createdAt: 1 }] }));
    expect(await screen.findByText("Beta prior instructions")).toBeTruthy();
    alpha.resolve(json({ versions: [{ version: 1, name: "Alpha", instructions: "Alpha stale instructions", createdAt: 1 }] }));
    await waitFor(() => expect(screen.queryByText("Alpha stale instructions")).toBeNull());
    const betaRow = screen.getByText("Beta").closest("li");
    expect(betaRow).not.toBeNull();
    expect(within(betaRow!).getByText("Beta prior instructions")).toBeTruthy();
  });
});

describe("team-scoped skill review", () => {
  const workspaceA = `ws_${"a".repeat(24)}`, workspaceB = `ws_${"b".repeat(24)}`;
  it("installs a curated template as a scoped draft without activation", async () => {
    let installed = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { installed = true; return json({ skill: { status: "draft" } }, 201); }
      if (String(input) === "/api/skills/library") return json({ skills: [{ slug: "checklist", name: "Team checklist template", summary: "Review changes", version: 1, installed, installedStatus: "draft" }] });
      return json({ skills: installed ? [serverSkill({ name: "Installed checklist" })] : [] });
    }); vi.stubGlobal("fetch", fetcher);
    render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} />);
    fireEvent.click(await screen.findByRole("button", { name: "Browse team skill templates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install team draft" }));
    await screen.findByText("Installed checklist");
    const mutations = fetcher.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(mutations).toHaveLength(1); expect(mutations[0]?.[0]).toBe("/api/skills/library/checklist/install");
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceA);
    expect(screen.queryByRole("button", { name: "Activate reviewed version" })).toBeNull();
  });
  it("edits an owned version with CAS and retains unsaved answers after a conflict", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH" ? json({ error: "version_conflict" }, 409) : json({ skills: [serverSkill({ sourceUrl: "https://example.test/provenance" })] }));
    vi.stubGlobal("fetch", fetcher); render(<SkillsView workspaceRole="admin" workspaceId={workspaceA} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit version" }));
    fireEvent.change(screen.getByLabelText("Skill instructions"), { target: { value: "My newer unsaved instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new draft version" }));
    expect((await screen.findByRole("alert")).textContent).toContain("version_conflict");
    expect((screen.getByLabelText("Skill instructions") as HTMLTextAreaElement).value).toBe("My newer unsaved instructions");
    const patch = fetcher.mock.calls.find((call) => call[1]?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ expectedVersion: 1, sourceUrl: "https://example.test/provenance" });
  });
  it("keeps member configuration controls disabled and opens instruction skills in the same workspace", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/v1/extensions/skills") ? json([]) : json({ skills: [] }));
    vi.stubGlobal("fetch", fetcher); render(<SkillsView workspaceRole="member" workspaceId={workspaceA} />);
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Team instruction skills" }));
    await waitFor(() => expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/v1/extensions/skills?view=workspace"))).toBe(true));
    expect(screen.queryByRole("button", { name: "New Skill" })).toBeNull();
    for (const [, init] of fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>) expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceA);
  });
  it("loads team bundle drafts with explicit scope and requires separate review and activation clicks", async () => {
    let status = "draft";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { status = url.endsWith("/review") ? "review" : "active"; return json({ skill: serverSkill({ status }) }); }
      return json({ skills: [serverSkill({ status })] });
    }); vi.stubGlobal("fetch", fetcher);
    render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} actorId="owner@example.com" />);
    await screen.findByText("Imported");
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/skills?limit=25");
    expect(screen.queryByRole("button", { name: "Activate reviewed version" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await screen.findByRole("button", { name: "Activate reviewed version" });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Activate reviewed version" }));
    await screen.findByText(/Reviewed version activated/);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceA);
    for (const [, init] of fetcher.mock.calls.filter((call) => call[1]?.method === "POST")) expect(JSON.parse(String(init?.body))).toEqual({ version: 1, reviewedInstructions: "Original notes" });
    expect(fetcher.mock.calls.every((call) => String(call[0]).startsWith("/api/skills"))).toBe(true);
  });
  it("synchronously clears the prior workspace and aborts its requests before late output arrives", async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Headers(init?.headers).get("X-Shiba-Workspace") === workspaceA ? old.promise : json({ skills: [serverSkill({ name: "Team B only" })] }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} actorId="owner@example.com" />);
    fireEvent.change(screen.getByLabelText("Skill instructions"), { target: { value: "Workspace A unsaved notes" } });
    view.rerender(<SkillsView workspaceRole="owner" workspaceId={workspaceB} actorId="owner@example.com" />);
    expect((screen.getByLabelText("Skill instructions") as HTMLTextAreaElement).value).toBe("");
    expect((fetcher.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    await screen.findByText("Team B only");
    await act(async () => { old.resolve(json({ skills: [serverSkill({ name: "Team A secret" })] })); });
    expect(screen.queryByText("Team A secret")).toBeNull(); expect(screen.getByText("Team B only")).toBeTruthy();
  });
  it("drops team drafts immediately when the verified actor changes within the same workspace", async () => {
    const next = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ skills: [serverSkill({ name: "Actor A draft" })] })).mockReturnValueOnce(next.promise); vi.stubGlobal("fetch", fetcher);
    const view = render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} actorId="a@example.com" />); await screen.findByText("Actor A draft");
    view.rerender(<SkillsView workspaceRole="owner" workspaceId={workspaceA} actorId="b@example.com" />);
    expect(screen.queryByText("Actor A draft")).toBeNull();
    await act(async () => { next.resolve(json({ skills: [] })); });
    expect(screen.queryByText("Actor A draft")).toBeNull();
  });
  it("shows permission/version refusals without activating, and clears cached records on revocation", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? json({ error: "workspace_access_revoked" }, 403) : json({ skills: [serverSkill({ status: "review" })] }));
    vi.stubGlobal("fetch", fetcher); render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} />); await screen.findByText("Imported");
    fireEvent.click(screen.getByRole("button", { name: "Activate reviewed version" }));
    expect((await screen.findByRole("alert")).textContent).toContain("workspace_access_revoked");
    expect(screen.queryByText("Imported")).toBeNull(); expect(screen.queryByText("Original notes")).toBeNull();
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("never gives a shared non-owner skill review or activation controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ skills: [serverSkill({ owned: false, status: "active" })] })));
    render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} />); await screen.findByText("Imported");
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull(); expect(screen.queryByRole("button", { name: "Activate reviewed version" })).toBeNull(); expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
  });
  it("keeps history and pagination inside the explicit team scope", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("versions") ? json({ versions: [{ version: 1, name: "Prior", instructions: "Prior approved context" }] }) : String(input).includes("cursor=25") ? json({ skills: [serverSkill({ id: "second", name: "Second page" })] }) : json({ skills: [serverSkill()], nextCursor: "25" }));
    vi.stubGlobal("fetch", fetcher); render(<SkillsView workspaceRole="owner" workspaceId={workspaceA} />); await screen.findByText("Imported");
    fireEvent.click(screen.getByRole("button", { name: "Versions" })); await screen.findByText("Prior approved context");
    fireEvent.click(screen.getByRole("button", { name: "Load more skills" })); await screen.findByText("Second page");
    for (const call of fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>) expect(new Headers(call[1]?.headers).get("X-Shiba-Workspace")).toBe(workspaceA);
  });
});

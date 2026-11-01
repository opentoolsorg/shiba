// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SkillsView recovery and draft races", () => {
  it("rerenders an initial load error and retries successfully", async () => {
    localStorageMock();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      reads += 1;
      return reads === 1 ? json({ error: "temporarily unavailable" }, 503) : json({ skills: [serverSkill({ name: "Recovered" })] });
    }));
    render(<SkillsView />);
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
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      return method === "GET" ? json({ skills: [] }) : json({ skill: serverSkill({ name: String(body?.name), instructions: String(body?.instructions), sourceUrl: body?.sourceUrl }) }, 201);
    }));
    render(<SkillsView />);
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
      if (url === "/api/skills/library") return json({ ok: true, skills: [] });
      if (url.includes("/api/founder-skills")) return json({ skills: [] });
      if (init?.method === "POST") return post.promise;
      return json({ skills: [] });
    }));
    render(<SkillsView />);
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
    render(<SkillsView />);
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

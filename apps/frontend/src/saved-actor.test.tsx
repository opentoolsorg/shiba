// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as saved from "./saved";

const a = "owner@example.com", b = "invited@example.com";
const skill = (name: string) => ({ id: `skill-${name}`, version: 1, status: "draft", owned: true, name, instructions: `${name} private instructions`, createdAt: 1, updatedAt: 1 });
const deferred = () => { let resolve!: (response: Response) => void; const promise = new Promise<Response>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { saved.setSavedLibraryActor(null); localStorage.clear(); });
afterEach(() => { cleanup(); saved.setSavedLibraryActor(null); vi.unstubAllGlobals(); });

describe("verified saved-library actor boundary", () => {
  it("namespaces repos and drafts without adopting any old browser-global records", () => {
    localStorage.setItem("shiba-repos-v1", JSON.stringify(["https://github.com/owner/private"]));
    localStorage.setItem("shiba-skills-v1", JSON.stringify([{ id: "owner-legacy", name: "Owner legacy", notes: "private" }]));
    localStorage.setItem("shiba-composer-drafts-v1", JSON.stringify({ default: { text: "Old owner brief", updatedAt: 1 } }));
    saved.setSavedLibraryActor(a);
    expect(saved.getSavedRepos()).toEqual([]); expect(saved.getSavedSkillsSnapshot().legacySkills).toEqual([]); expect(saved.readDraft("default")).toBe("");
    saved.saveRepo("https://github.com/acme/first"); saved.writeDraft("default", "Actor A unsent brief");
    saved.setSavedLibraryActor(b);
    expect(saved.getSavedRepos()).toEqual([]); expect(saved.readDraft("default")).toBe("");
    saved.saveRepo("https://github.com/acme/second"); saved.writeDraft("default", "Actor B unsent brief");
    expect(saved.getSavedRepos(a)).toEqual([]); expect(saved.readDraft("default", a)).toBe("");
    saved.setSavedLibraryActor(a);
    expect(saved.getSavedRepos()).toEqual(["https://github.com/acme/first"]); expect(saved.readDraft("default")).toBe("Actor A unsent brief");
    expect(localStorage.getItem("shiba-repos-v1")).toContain("owner/private");
  });
  it("hides old actor snapshots synchronously and aborts late skill loads without replacing the new actor", async () => {
    const old = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ skills: [skill("B")] })); vi.stubGlobal("fetch", fetcher);
    saved.setSavedLibraryActor(a);
    const original = saved.reloadSavedSkills(); const rejected = original.catch((error: unknown) => error);
    saved.setSavedLibraryActor(b);
    expect(saved.getSavedSkills()).toEqual([]); expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await saved.reloadSavedSkills(); expect(saved.getSavedSkills().map((item) => item.name)).toEqual(["B"]);
    old.resolve(Response.json({ skills: [skill("A")] }));
    expect(await rejected).toBeInstanceOf(DOMException); expect(saved.getSavedSkills().map((item) => item.name)).toEqual(["B"]);
  });
  it("inherits the root-bound actor in legacy child hooks and blocks a stale repo callback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ skills: [] })));
    saved.setSavedLibraryActor(a); saved.saveRepo("https://github.com/acme/a");
    const hooks = renderHook(() => ({ repos: saved.useSavedRepos(), save: saved.useSaveRepo(), skills: saved.useSavedSkills() }));
    await waitFor(() => expect(hooks.result.current.skills.loading).toBe(false));
    const staleSave = hooks.result.current.save;
    await act(async () => saved.setSavedLibraryActor(b));
    expect(hooks.result.current.repos).toEqual([]);
    act(() => staleSave("https://github.com/owner/late")); expect(saved.getSavedRepos()).toEqual([]);
    act(() => hooks.result.current.save("https://github.com/acme/b")); expect(saved.getSavedRepos()).toEqual(["https://github.com/acme/b"]);
    saved.saveRepo("https://github.com/owner/explicit-late", a); expect(saved.getSavedRepos()).toEqual(["https://github.com/acme/b"]);
  });
  it("keeps explicit null signed out with no network reads or persistent writes", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const hooks = renderHook(() => ({ skills: saved.useSavedSkills(null), repos: saved.useSavedRepos(null) }));
    await saved.reloadSavedSkills(); saved.saveRepo("https://github.com/acme/blocked"); saved.writeDraft("default", "blocked");
    expect(hooks.result.current.skills.skills).toEqual([]); expect(hooks.result.current.skills.loading).toBe(false); expect(hooks.result.current.repos).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
    await expect(saved.saveSkill({ name: "blocked", instructions: "blocked" })).rejects.toMatchObject({ message: "Sign in before accessing saved skills." });
  });
  it("rejects late mutations and history results rather than publishing them into a new account", async () => {
    const mutation = deferred(), history = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(mutation.promise).mockReturnValueOnce(history.promise); vi.stubGlobal("fetch", fetcher);
    saved.setSavedLibraryActor(a);
    const oldMutation = saved.saveSkill({ name: "A", instructions: "A private instructions" }).catch((error: unknown) => error);
    const oldHistory = saved.getSkillVersions("skill-A").catch((error: unknown) => error);
    saved.setSavedLibraryActor(b);
    mutation.resolve(Response.json({ skill: skill("A") })); history.resolve(Response.json({ versions: [{ version: 1, name: "A", instructions: "A private instructions", createdAt: 1 }] }));
    expect(await oldMutation).toBeInstanceOf(DOMException); expect(await oldHistory).toBeInstanceOf(DOMException); expect(saved.getSavedSkills()).toEqual([]);
  });
  it("does not continue a multi-entry legacy import or write its marker after an actor switch", async () => {
    const post = deferred(); const fetcher = vi.fn().mockReturnValueOnce(post.promise); vi.stubGlobal("fetch", fetcher);
    saved.setSavedLibraryActor(a);
    localStorage.setItem(`shiba-skills-v1:actor:${encodeURIComponent(a)}`, JSON.stringify([{ id: "one", name: "One", notes: "A only" }, { id: "two", name: "Two", notes: "A only" }]));
    const result = saved.importLegacySkills().catch((error: unknown) => error);
    saved.setSavedLibraryActor(b); post.resolve(Response.json({ skill: skill("One") }));
    expect(await result).toBeInstanceOf(DOMException); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`shiba-skills-v1-imported-v1:actor:${encodeURIComponent(b)}`)).toBeNull(); expect(saved.getSavedSkillsSnapshot().legacySkills).toEqual([]);
  });
  it("rejects owner-tagged stale composer writes after the current actor changes", () => {
    saved.setSavedLibraryActor(a); const scope = saved.composerDraftScope(a, "default"); saved.writeDraft(scope, "A original");
    saved.setSavedLibraryActor(b); saved.writeDraft(scope, "A late private text"); expect(saved.readDraft(scope)).toBe("");
    saved.setSavedLibraryActor(a); expect(saved.readDraft(scope)).toBe("A original");
  });
  it("exposes an optional explicit actor hook without inheriting the legacy namespace", async () => {
    localStorage.setItem("shiba-repos-v1", JSON.stringify(["https://github.com/owner/private"]));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ skills: [] })));
    const hook = renderHook(({ actor }) => ({ repos: saved.useSavedRepos(actor), skills: saved.useSavedSkills(actor) }), { initialProps: { actor: a } });
    await waitFor(() => expect(hook.result.current.skills.loading).toBe(false));
    act(() => saved.saveRepo("https://github.com/acme/a", a)); expect(hook.result.current.repos).toEqual(["https://github.com/acme/a"]);
    hook.rerender({ actor: b }); expect(hook.result.current.repos).toEqual([]); expect(hook.result.current.skills.skills).toEqual([]);
  });
  it("does not revive a captured callback or request when the original actor returns", async () => {
    const old = deferred();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(Response.json({ skills: [] })));
    saved.setSavedLibraryActor(a);
    const hook = renderHook(() => saved.useSaveRepo()); const callback = hook.result.current;
    const rejected = saved.reloadSavedSkills().catch((error: unknown) => error);
    await act(async () => { saved.setSavedLibraryActor(b); saved.setSavedLibraryActor(a); });
    act(() => callback("https://github.com/owner/stale")); expect(saved.getSavedRepos()).toEqual([]);
    old.resolve(Response.json({ skills: [skill("old-A")] })); expect(await rejected).toBeInstanceOf(DOMException); expect(saved.getSavedSkills()).toEqual([]);
  });
  it("ignores late pagination and keeps the new actor's in-flight load coalesced", async () => {
    const oldPage = deferred(), newLoad = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ skills: [skill("A")], nextCursor: "50" })).mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newLoad.promise); vi.stubGlobal("fetch", fetcher);
    saved.setSavedLibraryActor(a); await saved.reloadSavedSkills();
    const oldResult = saved.loadMoreSavedSkills().catch((error: unknown) => error);
    saved.setSavedLibraryActor(b); const current = saved.reloadSavedSkills();
    oldPage.resolve(Response.json({ skills: [skill("A-page-two")] })); expect(await oldResult).toBeInstanceOf(DOMException);
    const coalesced = saved.reloadSavedSkills(); expect(fetcher).toHaveBeenCalledTimes(3);
    newLoad.resolve(Response.json({ skills: [skill("B")] })); await Promise.all([current, coalesced]);
    expect(saved.getSavedSkills().map((item) => item.name)).toEqual(["B"]);
  });
});

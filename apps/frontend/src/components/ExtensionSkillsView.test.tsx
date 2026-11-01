// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExtensionSkillRecord } from "@shiba/shared";
import { ExtensionSkillsView } from "./ExtensionSkillsView";

const makeSkill = (overrides: Partial<ExtensionSkillRecord> = {}): ExtensionSkillRecord => ({
  _id: "skill_shared",
  userId: "alice",
  workspaceId: "workspace-1",
  scope: "personal",
  name: "Writing",
  description: "Keep responses concise",
  instructions: "Use short paragraphs.",
  enabled: true,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  permissions: { canEdit: true, canMove: true, canArchive: true, canRestore: true, canDelete: true },
  ...overrides,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ExtensionSkillsView", () => {
  it("creates, enables, shares, archives, and restores skills across scoped views", async () => {
    const skills: ExtensionSkillRecord[] = [];
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });

      if (method === "GET" && url.startsWith("/api/v1/extensions/skills?")) {
        const view = new URL(url, "https://shiba.test").searchParams.get("view");
        const rows = skills.filter((skill) => view === "archived"
          ? skill.archivedAt !== undefined
          : skill.archivedAt === undefined && (view === "workspace" ? skill.scope === "workspace" : skill.scope === "personal"));
        return Response.json(rows);
      }
      if (method === "POST" && url === "/api/v1/extensions/skills") {
        const id = "skill_created";
        skills.push(makeSkill({ _id: id, name: String(body?.name), description: String(body?.description), instructions: String(body?.instructions), enabled: body?.enabled !== false, scope: body?.scope === "workspace" ? "workspace" : "personal" }));
        return Response.json({ id }, { status: 201 });
      }
      const match = url.match(/^\/api\/v1\/extensions\/skills\/([^/]+)(?:\/(scope|archive|restore))?$/);
      if (!match) return Response.json({ error: "not found" }, { status: 404 });
      const skill = skills.find((item) => item._id === decodeURIComponent(match[1]!));
      if (!skill) return Response.json({ error: "not found" }, { status: 404 });
      if (method === "PATCH") {
        Object.assign(skill, body);
        if (body?.name !== undefined || body?.description !== undefined || body?.instructions !== undefined) skill.version += 1;
        return Response.json({ success: true });
      }
      if (method === "POST" && match[2] === "scope") {
        skill.scope = body?.to === "workspace" ? "workspace" : "personal";
        return Response.json({ ok: true });
      }
      if (method === "POST" && match[2] === "archive") {
        skill.archivedAt = 10;
        skill.archivedFromScope = skill.scope;
        return Response.json({ ok: true });
      }
      if (method === "POST" && match[2] === "restore") {
        skill.scope = skill.archivedFromScope ?? skill.scope;
        delete skill.archivedAt;
        delete skill.archivedFromScope;
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }));

    render(<ExtensionSkillsView />);
    fireEvent.click((await screen.findAllByRole("button", { name: "New Skill" }))[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Research" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Research notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Cite sources." } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Research notes")).toBeTruthy();
    expect(calls.find((call) => call.method === "POST" && call.url === "/api/v1/extensions/skills")?.body).toMatchObject({
      name: "Research",
      description: "Research notes",
      instructions: "Cite sources.",
      scope: "personal",
    });

    fireEvent.click(screen.getByRole("button", { name: "Disable Research" }));
    await waitFor(() => expect(skills[0]?.enabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Edit Research" }));
    fireEvent.click(screen.getByRole("switch", { name: "Disabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(skills[0]?.enabled).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Edit Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Share to Workspace" }));
    await waitFor(() => expect(skills[0]?.scope).toBe("workspace"));
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText("Research notes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(skills[0]?.archivedAt).toBe(10));
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByText("Research notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(skills[0]?.archivedAt).toBeUndefined());
    expect(skills[0]?.scope).toBe("workspace");
  });

  it("filters personal, workspace, and archived skills by name, description, and instructions", async () => {
    const skills = [
      makeSkill(),
      makeSkill({ _id: "skill_workspace", scope: "workspace", name: "Review", description: "PR checks", instructions: "Check changes." }),
      makeSkill({ _id: "skill_archived", archivedAt: 2, archivedFromScope: "personal", name: "Archive me" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/extensions/skills?")) {
        const view = new URL(url, "https://shiba.test").searchParams.get("view");
        return Response.json(skills.filter((skill) => view === "archived"
          ? skill.archivedAt !== undefined
          : skill.archivedAt === undefined && skill.scope === view));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }));
    render(<ExtensionSkillsView />);
    expect(await screen.findByText("Keep responses concise")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search skills" }), { target: { value: "paragraphs" } });
    expect(screen.getByText("Writing")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search skills" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText("Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByText("Archive me")).toBeTruthy();
  });

  it("shows shared skills read-only when the viewer cannot manage them", async () => {
    const skill = makeSkill({
      scope: "workspace",
      name: "Shared",
      permissions: { canEdit: false, canMove: false, canArchive: false, canRestore: false, canDelete: false },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return Response.json(url.includes("view=workspace") ? [skill] : []);
    }));

    render(<ExtensionSkillsView />);
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Shared" }));
    expect(screen.getByRole("heading", { name: "View Skill" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share to Workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

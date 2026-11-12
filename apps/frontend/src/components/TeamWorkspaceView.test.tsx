// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamWorkspaceDetail, TeamWorkspaceRole } from "@shiba/shared";
import { TeamWorkspaceView } from "./TeamWorkspaceView";

const idA = `ws_${"a".repeat(24)}`,
  idB = `ws_${"b".repeat(24)}`;
function detail(
  role: TeamWorkspaceRole = "owner",
  id = idA,
  actorId = "owner@example.com",
): TeamWorkspaceDetail {
  const membership = { workspaceId: id, userId: actorId, role, version: 2, joinedAt: 1 };
  return {
    workspaceId: id,
    name: id === idA ? "Acme team" : "Beta team",
    version: 7,
    createdAt: 1,
    membership,
    members: [
      membership,
      { workspaceId: id, userId: "member@example.com", role: "member", version: 4, joinedAt: 1 },
    ],
    invitations: [
      {
        invitationId: "invite1",
        workspaceId: id,
        email: "guest@example.com",
        role: "member",
        issuerUserId: actorId,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        status: "pending",
      },
    ],
  };
}
function pendingInvitation() {
  const invitation = detail().invitations?.[0];
  if (!invitation) throw new Error("Missing test invitation");
  return invitation;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});
const loaded = async () => {
  await screen.findByRole("heading", { name: "Acme team" });
};

describe("team workspace settings", () => {
  it("requires an explicit authenticated accept click and sends only a JSON token", async () => {
    const fetcher = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ workspace: detail() }),
    );
    vi.stubGlobal("fetch", fetcher);
    const accepted = vi.fn();
    render(
      <TeamWorkspaceView
        actorId="owner@example.com"
        invitationToken="secret-token"
        onInvitationAccepted={accepted}
      />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(accepted).toHaveBeenCalledWith(idA));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/workspaces/invitations/accept");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ token: "secret-token" });
    expect(localStorage.length).toBe(0);
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });
  it("blocks unauthenticated acceptance and reports exact-email/revoked refusals", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: "Invitation unavailable, expired, revoked, or email does not match." },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const view = render(<TeamWorkspaceView actorId={null} invitationToken="secret-token" />);
    expect(
      (screen.getByRole("button", { name: "Accept invitation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<TeamWorkspaceView actorId="wrong@example.com" invitationToken="secret-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("email does not match");
  });
  it("sends rename CAS and exposes server conflicts without silently retrying", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return init?.method === "PATCH"
        ? Response.json({ error: "Workspace changed. Refresh before renaming." }, { status: 409 })
        : Response.json({ workspace: detail() });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "New team" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Workspace changed");
    expect(requests.filter((request) => request.method === "PATCH")).toEqual([
      { method: "PATCH", body: { name: "New team", expectedVersion: 7 } },
    ]);
  });
  it("protects the last owner and sends member role changes with that member's version", async () => {
    const fetcher = vi.fn(async () => Response.json({ workspace: detail() }));
    vi.stubGlobal("fetch", fetcher);
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    expect(
      (screen.getByLabelText("Role for owner@example.com") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Leave workspace" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Role for member@example.com"), {
      target: { value: "admin" },
    });
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        `/api/workspaces/${idA}/members/member%40example.com`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ expectedVersion: 4, role: "admin" }),
        }),
      ),
    );
  });
  it("gives admins only member-level invite and roster controls; hides manager data from members", async () => {
    let workspace = detail("admin");
    workspace.members.push({
      workspaceId: idA,
      userId: "second-admin@example.com",
      role: "admin",
      version: 1,
      joinedAt: 1,
    });
    const fetcher = vi.fn(async () => Response.json({ workspace }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    expect(screen.queryByLabelText("Role for second-admin@example.com")).toBeNull();
    expect((screen.getByLabelText("Invitation role") as HTMLSelectElement).options).toHaveLength(1);
    workspace = detail("member", idB, "member@example.com");
    view.rerender(<TeamWorkspaceView actorId="member@example.com" workspaceId={idB} />);
    expect(screen.queryByText("guest@example.com")).toBeNull();
    await screen.findByRole("heading", { name: "Beta team" });
    expect(screen.queryByLabelText("Teammate email")).toBeNull();
    expect(screen.queryByText("guest@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save name" })).toBeNull();
  });
  it("creates a link once, rechecks membership before fragment-safe clipboard copy and revokes it", async () => {
    let revoked = false;
    const copy = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: copy },
      configurable: true,
    });
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json({ invitation: pendingInvitation(), token: "raw-token" });
      if (init?.method === "DELETE") {
        revoked = true;
        return Response.json({ revoked: true });
      }
      const workspace = detail();
      const invitation = workspace.invitations?.[0];
      if (revoked && invitation) invitation.status = "revoked";
      return Response.json({ workspace });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    fireEvent.change(screen.getByLabelText("Teammate email"), {
      target: { value: "guest@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));
    await screen.findByRole("button", { name: "Copy invitation link" });
    expect(copy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    const copied = copy.mock.calls[0]?.[0];
    if (!copied) throw new Error("No copied invitation");
    const url = new URL(copied);
    expect(url.search).toBe("?view=team&invite=1");
    expect(url.hash).toBe("#invite=raw-token");
    expect(localStorage.length).toBe(0);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Revoke invitation for guest@example.com",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke invitation for guest@example.com" }),
    );
    await screen.findByText("Invitation revoked. Its link can no longer be used.");
    expect(screen.queryByRole("button", { name: "Copy invitation link" })).toBeNull();
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("suppresses duplicate mutations and ignores late actor-A invite responses after a switch", async () => {
    let resolveInvite!: (value: Response) => void;
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          resolveInvite = resolve;
        });
      return Response.json({
        workspace: String(path).includes(idB) ? detail("member", idB, "b@example.com") : detail(),
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const view = render(
      <TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} onChanged={changed} />,
    );
    await loaded();
    fireEvent.change(screen.getByLabelText("Teammate email"), {
      target: { value: "guest@example.com" },
    });
    const button = screen.getByRole("button", { name: "Create invitation link" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    view.rerender(
      <TeamWorkspaceView actorId="b@example.com" workspaceId={idB} onChanged={changed} />,
    );
    expect(screen.queryByText("guest@example.com")).toBeNull();
    await act(async () => {
      resolveInvite(Response.json({ invitation: pendingInvitation(), token: "old-secret" }));
    });
    await screen.findByRole("heading", { name: "Beta team" });
    expect(screen.queryByRole("button", { name: "Copy invitation link" })).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
  it("refuses clipboard disclosure when an owner was demoted after creating a link", async () => {
    let role: TeamWorkspaceRole = "owner";
    const copy = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: copy },
      configurable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ invitation: pendingInvitation(), token: "private-link" })
          : Response.json({ workspace: detail(role) }),
      ),
    );
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    fireEvent.change(screen.getByLabelText("Teammate email"), {
      target: { value: "guest@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));
    const button = await screen.findByRole("button", { name: "Copy invitation link" });
    role = "member";
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Copy invitation link" })).toBeNull(),
    );
    expect(copy).not.toHaveBeenCalled();
    expect(screen.queryByText("guest@example.com")).toBeNull();
  });
  it("does not replace an unsaved rename draft during membership refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspace: detail() })),
    );
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Unsaved name" },
    });
    fireEvent(window, new Event("focus"));
    await act(async () => {});
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe(
      "Unsaved name",
    );
  });
  it("drops cached roster and invitation controls if membership is revoked", async () => {
    let revoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        revoked
          ? Response.json({ error: "Workspace not found." }, { status: 404 })
          : Response.json({ workspace: detail() }),
      ),
    );
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} />);
    await loaded();
    revoked = true;
    fireEvent(window, new Event("focus"));
    await screen.findByRole("heading", { name: "Workspace unavailable" });
    expect(screen.queryByText("guest@example.com")).toBeNull();
    expect(screen.queryByLabelText("Teammate email")).toBeNull();
  });
  it("creates a separate workspace only after explicit submit without sharing private context", async () => {
    const fetcher = vi.fn(async () => Response.json({ workspace: detail() }));
    vi.stubGlobal("fetch", fetcher);
    const select = vi.fn();
    render(<TeamWorkspaceView actorId="owner@example.com" onSelectWorkspace={select} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Acme team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(select).toHaveBeenCalledWith(idA));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/workspaces",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Acme team" }) }),
    );
  });
});


describe("team coworker launchpad", () => {
  it("opens existing room and Slack surfaces without starting work", async () => {
    const fetcher = vi.fn(async () => Response.json({ workspace: detail() }));
    vi.stubGlobal("fetch", fetcher);
    const onOpenChat = vi.fn(), onOpenApps = vi.fn();
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} onOpenChat={onOpenChat} onOpenApps={onOpenApps} />);
    await loaded();
    expect(screen.getByRole("region", { name: "Team coworker launchpad" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open shared rooms" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Slack setup" }));
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(onOpenApps).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Invite teammates" }));
    expect(screen.getByRole("button", { name: /Invitations/ }).getAttribute("aria-pressed")).toBe("true");
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("keeps invitation authority with managers while members can open Slack setup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace: detail("member") })));
    const onOpenApps = vi.fn();
    render(<TeamWorkspaceView actorId="owner@example.com" workspaceId={idA} onOpenApps={onOpenApps} />);
    await loaded();
    expect(screen.queryByRole("button", { name: "Invite teammates" })).toBeNull();
    expect(screen.getByText("Ask a workspace owner or admin to invite teammates.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open Slack setup" }));
    expect(onOpenApps).toHaveBeenCalledOnce();
  });

  it("drops the launchpad on scope changes and revoked membership", async () => {
    let revoked = false;
    vi.stubGlobal("fetch", vi.fn(async () => revoked
      ? Response.json({ error: "Workspace not found." }, { status: 404 })
      : Response.json({ workspace: detail() })));
    const props = { actorId: "owner@example.com", workspaceId: idA, onOpenApps: vi.fn() };
    const view = render(<TeamWorkspaceView {...props} />);
    await loaded();
    revoked = true;
    fireEvent(window, new Event("focus"));
    await screen.findByRole("heading", { name: "Workspace unavailable" });
    expect(screen.queryByRole("region", { name: "Team coworker launchpad" })).toBeNull();
    view.rerender(<TeamWorkspaceView {...props} workspaceId={idB} />);
    expect(screen.queryByRole("button", { name: "Open Slack setup" })).toBeNull();
  });
});

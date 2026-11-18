// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmployeeAccessSettings } from "./EmployeeAccessSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const workspaceId = `ws_${"a".repeat(24)}`;
describe("EmployeeAccessSettings", () => {
  it("lets existing member and group overrides return to inheritance and reports failed removals", async () => {
    const grants = [{ principalKind: "user", principalId: "member@example.test", name: "member@example.test", level: "none" }, { principalKind: "group", principalId: "finance", name: "Finance team", level: "chat" }];
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/groups")) return Response.json({ groups: [{ groupId: "finance", name: "Finance team" }] });
      if (input.startsWith("/api/workspaces/")) return Response.json({ workspace: { members: [{ userId: "member@example.test" }] } });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        if (body.principalKind === "group") return Response.json({ error: "Removal failed" }, { status: 503 });
        return Response.json({ level: "manage", grants: grants.filter((row) => row.principalKind !== "user") });
      }
      return Response.json({ level: "manage", grants });
    }));
    render(<EmployeeAccessSettings workspaceId={workspaceId} employeeId="employee" />);
    const member = await screen.findByLabelText("member@example.test access") as HTMLSelectElement;
    expect(member.value).toBe("none");
    fireEvent.change(member, { target: { value: "inherit" } });
    await screen.findByText("Access updated and recorded in the audit log.");
    expect(member.value).toBe("inherit");
    fireEvent.change(screen.getByLabelText("Finance team access"), { target: { value: "inherit" } });
    expect((await screen.findByRole("alert")).textContent).toBe("Removal failed");
    expect(writes).toEqual([{ principalKind: "user", principalId: "member@example.test", level: "inherit" }, { principalKind: "group", principalId: "finance", level: "inherit" }]);
  });
  it("shows the Everyone default and saves member and group levels with workspace authority", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceId);
      if (input.endsWith("/groups")) return Response.json({ groups: [{ groupId: "finance", name: "Finance team" }] });
      if (input.startsWith("/api/workspaces/")) return Response.json({ workspace: { members: [{ userId: "member@example.test" }] } });
      if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return Response.json({ level: "manage", grants: [] }); }
      return Response.json({ level: "manage", grants: [] });
    }));
    render(<EmployeeAccessSettings workspaceId={workspaceId} employeeId="employee" />);
    const everyone = await screen.findByLabelText("Everyone access") as HTMLSelectElement;
    expect(everyone.value).toBe("manage");
    fireEvent.change(screen.getByLabelText("member@example.test access"), { target: { value: "view" } });
    await screen.findByText("Access updated and recorded in the audit log.");
    fireEvent.change(screen.getByLabelText("Finance team access"), { target: { value: "chat" } });
    await screen.findByText("Access updated and recorded in the audit log.");
    expect(writes).toEqual([{ principalKind: "user", principalId: "member@example.test", level: "view" }, { principalKind: "group", principalId: "finance", level: "chat" }]);
  });
  it("is read-only without manage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ level: "view", grants: [] })));
    render(<EmployeeAccessSettings workspaceId={workspaceId} employeeId="employee" />);
    expect(await screen.findByText(/Your access: view/)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("reports failed access loads without presenting controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Not found." }, { status: 404 })));
    render(<EmployeeAccessSettings workspaceId={workspaceId} employeeId="employee" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Not found.");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

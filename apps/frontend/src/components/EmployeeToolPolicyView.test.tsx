// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmployeeToolPolicyView } from "./EmployeeToolPolicyView";

const json = (body: unknown, status = 200) => Response.json(body, { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("EmployeeToolPolicyView", () => {
  it("loads real API state, configures exact resources, and decides a pending exact-payload approval", async () => {
    let policyVersion = 1;
    let grants: Array<{ subjectType: string; subjectId: string; capabilityId: string; resourceId: string; lifecycle: string }> = [];
    let approvals = [{ approvalId: "approval-1", employeeId: "employee-1", employeeVersion: 1, actorId: "researcher", action: "queue_run", resourceId: "https://github.com/acme/app", payload: { repoUrl: "https://github.com/acme/app", task: "Review dependency updates" }, status: "pending", createdAt: 10, expiresAt: 99_999_999_999 }];
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url === "/api/custom-agents") return json({ agents: [{ id: "employee-1", slug: "researcher", version: policyVersion, config: { name: "Researcher" } }] });
      if (url === "/api/agents") return json({ principals: [{ principal: "researcher", scopes: ["sandbox:exec"], created: 1, live: true }] });
      if (url === "/api/whoami") return json({ agent: "owner@example.test", auth: "better-auth" });
      if (url === "/api/employee-tools/approvals" && method === "GET") return json({ approvals });
      if (url === "/api/employee-tools/approvals/approval-1" && method === "POST") { approvals = []; return json({ ok: true, status: body?.approved ? "approved" : "denied" }); }
      if (url.endsWith("/policy") && method === "GET") return json({ employeeVersion: policyVersion, toolScopes: grants.map((grant) => grant.capabilityId), grants });
      if (url.endsWith("/policy") && method === "PUT") {
        expect(body).toMatchObject({ actorId: "owner@example.test", role: "member", expectedVersion: policyVersion });
        const resourceMap = body?.resourcesByCapability as Record<string, string[]>;
        grants = Object.entries(resourceMap).flatMap(([capabilityId, values]) => values.flatMap((resourceId) => [
          { subjectType: "workspace", subjectId: "workspace", capabilityId, resourceId, lifecycle: "active" },
          { subjectType: "actor", subjectId: "owner@example.test", capabilityId, resourceId, lifecycle: "active" },
          { subjectType: "role", subjectId: "member", capabilityId, resourceId, lifecycle: "active" },
        ]));
        policyVersion += 1;
        return json({ ok: true, employeeVersion: policyVersion });
      }
      return json({ error: `Unexpected ${method} ${url}` }, 500);
    }));

    render(<EmployeeToolPolicyView />);
    expect(await screen.findByText(/Review dependency updates/)).toBeTruthy();
    expect((screen.getByLabelText("Actor identity") as HTMLSelectElement).value).toBe("owner@example.test");
    fireEvent.click(screen.getByLabelText(/Queue a coding run/));
    fireEvent.change(screen.getByLabelText(/Allowed repository url values/), { target: { value: "https://github.com/acme/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save grants" }));
    await screen.findByText(/Policy saved/);
    expect(requests.find((request) => request.method === "PUT")?.body?.resourcesByCapability).toEqual({ "mcp:shiba:queue_run": ["https://github.com/acme/app"] });

    fireEvent.click(screen.getByRole("button", { name: "Approve exact payload" }));
    await waitFor(() => expect(screen.queryByText(/Review dependency updates/)).toBeNull());
    expect(requests.find((request) => request.url.endsWith("/approval-1"))?.body).toEqual({ employeeId: "employee-1", approved: true });
    expect(screen.getByText(/can retry the same call/)).toBeTruthy();
    expect(screen.getByText(/do not constrain shell\/CLI tools/)).toBeTruthy();
  });
});

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmployeeRuntimeRoutine } from "@shiba/shared";
import { BotDetailsTab } from "./BotDetailsTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const baseRoutine: EmployeeRuntimeRoutine = {
  id: "sch_existing", conversationId: "thread-1", name: "Existing review", prompt: "Review the inbox",
  intervalSeconds: 3600, nextRunAt: 1_800_000_000_000, createdAt: 1,
};

function renderDetails() {
  render(
    <BotDetailsTab
      editing
      modelEdit={null}
      instructions=""
      instructionsSaved=""
      onInstructionsChange={() => undefined}
      onInstructionsSave={() => undefined}
      notice={null}
      saveBusy={false}
      toolsRows={[]}
      toolsLoading={false}
      toolsError={null}
      advanced={[]}
      agentId="agent-1"
      workspaceId={`ws_${"a".repeat(24)}`}
      conversationId="thread-1"
      openInstructionsSignal={0}
    />,
  );
}

describe("BotDetailsTab routines", () => {
  it("lists, schedules, and cancels runtime routines for the selected thread", async () => {
    const workspaceId = `ws_${"a".repeat(24)}`;
    let routines = [baseRoutine];
    const posts: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/runtime/routines?") && (!init?.method || init.method === "GET")) return Response.json({ routines });
      if (path.endsWith("/runtime/routines") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body, headers: new Headers(init.headers) });
        const routine = { id: "sch_new", conversationId: "thread-1", name: body.name, prompt: body.prompt, intervalSeconds: body.intervalSeconds, nextRunAt: 1_800_000_003_600, createdAt: 2 } as EmployeeRuntimeRoutine;
        routines = [...routines, routine];
        return Response.json({ routine }, { status: 201 });
      }
      if (path.endsWith("/runtime/routines/delete") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body, headers: new Headers(init.headers) });
        routines = routines.filter((routine) => routine.id !== body.routineId);
        return Response.json({ ok: true, deleted: true });
      }
      throw new Error(`unexpected fetch ${path}`);
    }));

    renderDetails();
    fireEvent.click(screen.getByRole("button", { name: /Routines/ }));
    expect(await screen.findByText("Review the inbox")).toBeTruthy();
    expect(screen.getByText("every 1 hour")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Routine name/), { target: { value: "Daily scan" } });
    fireEvent.change(screen.getByLabelText(/^Prompt/), { target: { value: "Summarize new workspace activity" } });
    fireEvent.change(screen.getByLabelText("Routine interval"), { target: { value: "1440" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule routine" }));
    expect(await screen.findByText("Summarize new workspace activity")).toBeTruthy();
    const create = posts.find((post) => post.path.endsWith("/runtime/routines"));
    expect(create?.body).toEqual({ conversationId: "thread-1", name: "Daily scan", prompt: "Summarize new workspace activity", intervalSeconds: 86400 });
    expect(create?.headers.get("X-Shiba-Workspace")).toBe(workspaceId);

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel routine" })[0]!);
    expect(await screen.findByText("Routine cancelled.")).toBeTruthy();
    expect(screen.queryByText("Review the inbox")).toBeNull();
    expect(posts.find((post) => post.path.endsWith("/runtime/routines/delete"))?.body).toEqual({ conversationId: "thread-1", routineId: "sch_existing" });
  });
});

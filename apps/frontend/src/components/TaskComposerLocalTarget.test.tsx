// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLocalRunTarget } from "../local-run-target";
import { TaskComposer } from "./TaskComposer";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ onSubmit, initialTarget = "local" }: { onSubmit: () => void; initialTarget?: "sandbox" | "local" }) {
  const [target, setTarget] = useState<"sandbox" | "local">(initialTarget);
  const fleet = useLocalRunTarget({ harness: "opencode", desktopStatus: null });
  return <TaskComposer repoUrl="https://github.com/example/project" task="Fix the parser" baseBranch="main"
    publishPullRequest={false} harness="opencode" busy={false} isSubmitting={false} clearing={false}
    routing={{ codingModel: "", connectionId: "", onCodingModelChange: vi.fn(), onConnectionChange: vi.fn(), reasoningEffort: "" as const, onReasoningEffortChange: vi.fn() }}
    onRepoUrlChange={vi.fn()} onTaskChange={vi.fn()} onBaseBranchChange={vi.fn()} onPublishPullRequestChange={vi.fn()}
    onHarnessChange={vi.fn()} onSubmit={onSubmit} onClear={vi.fn()}
    runTarget={target} onRunTargetChange={setTarget} localRunAvailable={fleet.localRunAvailable}
    localComputers={fleet.computers} targetMachineId={fleet.targetMachineId}
    onTargetMachineChange={fleet.selectMachine} localComputersLoading={fleet.loading}
    localComputersError={fleet.error} onRefreshLocalComputers={fleet.refresh} />;
}

const computer = (machineId: string) => ({
  machineId, hostname: `Mac ${machineId}`, platform: "darwin-arm64", daemonVersion: "1.0",
  status: "idle", harnesses: ["opencode"], lastHeartbeat: Date.now(),
});

it("requires an explicit paired computer before enabling a Local task", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [computer("a"), computer("b")] })));
  const submit = vi.fn();
  render(<Harness onSubmit={submit} />);
  await screen.findByText("Choose a paired computer before sending.");
  expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Run on: Local" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Local computer" }), { target: { value: "b" } });
  await screen.findByText("Local: Mac b");
  expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Send task" }));
  expect(submit).toHaveBeenCalledOnce();
});

it("reopens the Local target menu after the one-computer selection closes it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [computer("only")] })));
  render(<Harness onSubmit={vi.fn()} initialTarget="sandbox" />);

  fireEvent.click(screen.getByRole("button", { name: "Run on: Cloud" }));
  const localOption = screen.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ });
  await waitFor(() => expect(localOption.hasAttribute("disabled")).toBe(false));
  fireEvent.click(localOption);
  await screen.findByText("Local: Mac only");
  expect(screen.getByRole("button", { name: "Run on: Local" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh paired computers" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Run on: Local" }));
  expect(screen.getByRole("button", { name: "Refresh paired computers" })).toBeTruthy();
});

it("keeps the Local target menu open when multiple computers need a choice", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [computer("a"), computer("b")] })));
  render(<Harness onSubmit={vi.fn()} initialTarget="sandbox" />);

  fireEvent.click(await screen.findByRole("button", { name: "Run on: Cloud" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ }));
  expect(screen.getByRole("button", { name: "Refresh paired computers" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Local computer" })).toBeTruthy();
});

it("keeps Local unavailable with no compatible paired computers", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [] })));
  render(<Harness onSubmit={vi.fn()} initialTarget="sandbox" />);

  fireEvent.click(await screen.findByRole("button", { name: "Run on: Cloud" }));
  const localOption = screen.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ });
  await waitFor(() => expect(localOption.hasAttribute("disabled")).toBe(true));
  expect(screen.getByRole("button", { name: "Refresh paired computers" })).toBeTruthy();
});

it("keeps Local selected and blocks sending after its computer goes offline", async () => {
  let online = true;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: online ? [computer("a")] : [] })));
  const submit = vi.fn();
  render(<Harness onSubmit={submit} />);
  await screen.findByText("Local: Mac a");
  online = false;
  fireEvent.click(screen.getByRole("button", { name: "Run on: Local" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh paired computers" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true));
  expect(screen.getByRole("button", { name: "Run on: Local" })).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  // Cloud execution is available only after an explicit user selection.
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Cloud \(Sandbox\)/ }));
  expect(screen.getByRole("button", { name: "Run on: Cloud" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(false);
});

import { describe, expect, it } from "vitest";
import { describeTaskRoute } from "./supported-task-routes";

const repository = { runtime: "sandbox", workType: "repository", harness: "claude-code", model: "anthropic/example", connectionId: "", connections: [] } as const;

describe("declared coding task routes", () => {
  it.each(["opencode", "claude-code", "codex"])("describes %s API work on a sandbox and explicit local artifact work", (harness) => {
    expect(describeTaskRoute({ ...repository, harness }).blockedReason).toBeNull();
    expect(describeTaskRoute({ ...repository, harness, workType: "artifact-workspace" }).blockedReason).toBeNull();
    const local = describeTaskRoute({ ...repository, harness, runtime: "local" });
    expect(local.blockedReason).toBeNull();
    expect(local.account).toContain("computer's CLI credentials");
    expect(local.billing).toContain("check the account on that computer");
    expect(describeTaskRoute({ ...repository, harness, runtime: "local", workType: "artifact-workspace" }).blockedReason).toBeNull();
  });

  it("does not route a local ChatGPT subscription harness or connected-app work through a CLI", () => {
    expect(describeTaskRoute({ ...repository, harness: "codex-subscription", runtime: "local" }).blockedReason).toContain("cannot run on a paired computer");
    expect(describeTaskRoute({ ...repository, workType: "connected-app" }).blockedReason).toContain("separate granted app-tools");
  });

  it("refuses the native cloud Claude login stub rather than claiming an auth volume is mounted", () => {
    expect(describeTaskRoute({ ...repository, harness: "claude-login" }).blockedReason).toContain("persistent auth volumes are not implemented");
  });

  it.each(["disabled", "invalid", "unconfigured"])("refuses a selected %s connection rather than describing an automatic replacement", (status) => {
    const result = describeTaskRoute({ ...repository, connectionId: "chosen", connections: [{ id: "chosen", label: "My API", status, service: "anthropic" }] });
    expect(result.blockedReason).toContain(`is ${status}`);
    expect(result.account).toContain("My API");
  });

  it("requires an explicit route change after a selected connection disappears", () => {
    const result = describeTaskRoute({ ...repository, connectionId: "revoked" });
    expect(result.blockedReason).toContain("selected model connection is unavailable");
  });

  it("keeps ChatGPT-plan billing distinct from API billing in both directions", () => {
    const plan = { id: "plan", label: "My ChatGPT", status: "ready", service: "openai-subscription" };
    const api = { id: "api", label: "My OpenAI API", status: "ready", service: "openai" };
    const selected = describeTaskRoute({ ...repository, harness: "codex-subscription", connectionId: "plan", connections: [plan, api] });
    expect(selected.blockedReason).toBeNull();
    expect(selected.billing).toContain("ChatGPT plan");
    expect(selected.account).toContain("Signed-in user's");
    expect(describeTaskRoute({ ...repository, harness: "codex", connectionId: "plan", connections: [plan, api] }).blockedReason).toContain("Choose that harness explicitly");
    expect(describeTaskRoute({ ...repository, harness: "codex-subscription", connectionId: "api", connections: [plan, api] }).blockedReason).toContain("requires a ChatGPT connection");
  });

  it("does not claim resolved account identity, model defaults, or legacy runtime enablement", () => {
    const result = describeTaskRoute({ ...repository, model: "", harness: "claude-subscription" });
    expect(result.model).toContain("resolved at approval");
    expect(result.account).toContain("resolved by the server");
    expect(result.note).toContain("deployment-gated");
  });
});

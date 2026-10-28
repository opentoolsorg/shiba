import { describe, expect, it } from "vitest";
import {
  approvalEvidenceFor,
  buildLocalRunEnvelope,
  createPendingApproval,
  decideRunTransition,
  expectedDeliverablesSchema,
  resolvePendingApproval,
  runInputHash,
  type CustomAgentRecord,
} from "@shiba/shared";
import { createRun } from "../src/runs.js";
import { decodeCreateCustomAgent, decodeUpdateCustomAgent } from "../src/custom-agents-schema.js";
import { overridesFromCustomAgent } from "../src/custom-agents-resolve.js";

const input = {
  repoUrl: "https://github.com/acme/workspace", task: "Prepare the campaign plan",
  baseBranch: "main", publishPullRequest: false,
};
const config = { name: "Research", instructions: "Prepare a source-backed draft", harness: "claude-code" };

describe("expected deliverable contracts", () => {
  it("accepts bounded nested document paths and an explicit empty list", () => {
    expect(expectedDeliverablesSchema.parse(["deliverables/launch-plan.md", "research/sources.json", "ops/data.csv", "notes.txt"])).toHaveLength(4);
    expect(expectedDeliverablesSchema.parse([])).toEqual([]);
  });

  it.each([
    "/report.md", "../report.md", "reports/../report.md", "./report.md", ".private/report.md",
    "reports/.private.md", "reports//report.md", "C:/report.md", "reports\\report.md", "report.md\0",
    "report\n.md", "report.exe", "report.html", "report.md ", " reports.md", "reports/ report.md",
    "report.md/", "report.md?x=1", "report.md#fragment", "x".repeat(238) + ".md",
  ])("rejects unsafe or unsupported path %j", (path) => {
    expect(expectedDeliverablesSchema.safeParse([path]).success).toBe(false);
  });

  it("rejects overflow and duplicate paths on case-sensitive and case-insensitive workspaces", () => {
    expect(expectedDeliverablesSchema.safeParse(Array.from({ length: 9 }, (_, i) => `report-${i}.md`)).success).toBe(false);
    expect(expectedDeliverablesSchema.safeParse(["report.md", "report.md"]).success).toBe(false);
    expect(expectedDeliverablesSchema.safeParse(["Report.md", "report.md"]).success).toBe(false);
  });

  it("validates bot create/update boundaries and snapshots configured defaults", () => {
    for (const expectedDeliverables of [["report.md"], []]) {
      expect(decodeCreateCustomAgent({ slug: "research", config: { ...config, expectedDeliverables } })?.config.expectedDeliverables).toEqual(expectedDeliverables);
      expect(decodeUpdateCustomAgent({ config: { ...config, expectedDeliverables } })?.config.expectedDeliverables).toEqual(expectedDeliverables);
    }
    expect(decodeCreateCustomAgent({ slug: "research", config: { ...config, expectedDeliverables: ["../private.md"] } })).toBeNull();
    expect(decodeUpdateCustomAgent({ config: { ...config, expectedDeliverables: [".private/report.md"] } })).toBeNull();
    const profile: CustomAgentRecord = { id: "bot-1", orgId: "org-1", slug: "research", version: 1, createdAt: 1, updatedAt: 1, config: { ...config, expectedDeliverables: ["v1.md"] } };
    const frozen = overridesFromCustomAgent(profile);
    profile.config = { ...profile.config, expectedDeliverables: ["v2.md"] };
    expect(frozen.expectedDeliverables).toEqual(["v1.md"]);
  });

  it("binds requested outputs into approval evidence and keeps legacy absent hashes unchanged", () => {
    const baseline = runInputHash(input);
    expect(runInputHash({ ...input, expectedDeliverables: undefined })).toBe(baseline);
    expect(runInputHash({ ...input, expectedDeliverables: [] })).not.toBe(baseline);
    expect(runInputHash({ ...input, expectedDeliverables: ["report.md"] })).not.toBe(baseline);
    expect(runInputHash({ ...input, expectedDeliverables: ["v1.md"] })).not.toBe(runInputHash({ ...input, expectedDeliverables: ["v2.md"] }));
  });

  it("copies queue requirements and refuses altered queue replay or approval start", () => {
    const paths = ["v1.md"];
    const approvals = createPendingApproval([], { ...input, expectedDeliverables: paths, threadKey: "operator", approvalId: "ap-1", createdAt: 1 });
    paths[0] = "v2.md";
    expect(approvals[0]?.expectedDeliverables).toEqual(["v1.md"]);
    const resolved = resolvePendingApproval(approvals, { threadKey: "operator", approvalId: "ap-1", approved: true, decidedBy: "human" }, 2).approvals[0]!;
    const approvedInput = { ...input, expectedDeliverables: ["v1.md"] };
    const approval = approvalEvidenceFor(resolved, approvedInput);
    const run = createRun({ ...approvedInput, runId: "run-1", sandboxId: "sandbox-1", approval, now: 2 });
    expect(run.expectedDeliverables).toEqual(["v1.md"]);
    approvedInput.expectedDeliverables[0] = "v3.md";
    expect(run.expectedDeliverables).toEqual(["v1.md"]);
    expect(decideRunTransition({ run }, { type: "start", commandId: "start", runId: run.runId, at: 3 })).not.toHaveProperty("error");
    expect(decideRunTransition({ run: { ...run, expectedDeliverables: ["v2.md"] } }, { type: "start", commandId: "start", runId: run.runId, at: 3 })).toHaveProperty("error.code", "approval_mismatch");
    expect(decideRunTransition({ run }, { type: "queue", commandId: "queue-again", runId: run.runId, input: { ...input, expectedDeliverables: ["v2.md"], sandboxId: run.sandboxId }, at: 3 })).toHaveProperty("error.code", "input_conflict");
  });

  it("keeps frozen requirements in the local daemon envelope", () => {
    const paths = ["deliverables/report.md"];
    const envelope = buildLocalRunEnvelope({
      input: { ...input, sandboxId: "sandbox-1", expectedDeliverables: paths }, harnessName: "claude-code",
      workdir: "/workspace/sandbox-1", configFiles: [], setupCommands: [], argv: ["claude"], env: {},
      execAllowlist: [], setupAllowlist: [], deadlineAt: 10000, now: 1, dummyKey: "shiba-egress-placeholder",
    });
    paths[0] = "changed.md";
    expect(envelope.expectedDeliverables).toEqual(["deliverables/report.md"]);
  });
});

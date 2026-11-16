import assert from "node:assert/strict";
import test from "node:test";
import { deriveOnboardingStatus } from "./onboarding-status.ts";

const empty = {
  draftTaskId: null, draftTask: null, dismissedAt: null, connectionVerifiedAt: null,
  firstSuccessfulRunAt: null, activatedAt: null,
  evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false },
};
const brief = {
  goal: "Research buyer needs", audience: "Product team", acceptance: "A cited brief",
  completedSteps: [], skippedSteps: [], employeeId: null, employeeVersion: null,
  employeeTemplateId: null, preparedAt: null,
};
const ready = { ...empty, draftTaskId: "draft_first", draftTask: { ...brief, preparedAt: 100 } };

test("no draft starts at goal and lists only required incomplete steps", () => {
  const status = deriveOnboardingStatus(empty);
  assert.equal(status.complete, false);
  assert.equal(status.nextStep.id, "goal");
  assert.deepEqual(status.remaining.map((step) => step.id), ["goal", "audience", "acceptance", "review", "provider", "first-run", "accept-deliverable"]);
});

test("required answers lead to review, including explicit completed steps", () => {
  assert.equal(deriveOnboardingStatus({ ...empty, draftTask: brief }).nextStep.id, "review");
  const draftTask = { ...brief, goal: " ", completedSteps: ["goal"] };
  assert.equal(deriveOnboardingStatus({ ...empty, draftTask }).nextStep.id, "review");
});

test("preparation needs its retained id and then leads to provider", () => {
  assert.equal(deriveOnboardingStatus(ready).nextStep.id, "provider");
  assert.equal(deriveOnboardingStatus({ ...ready, draftTaskId: null }).nextStep.id, "review");
});

test("provider evidence or timestamp leads to the first run", () => {
  for (const input of [
    { ...ready, evidence: { ...empty.evidence, connectedProvider: true } },
    { ...ready, connectionVerifiedAt: 100 },
  ]) assert.equal(deriveOnboardingStatus(input).nextStep.id, "first-run");
});

test("a successful run still needs an approved deliverable", () => {
  const status = deriveOnboardingStatus({ ...ready, connectionVerifiedAt: 100, firstSuccessfulRunAt: 101 });
  assert.equal(status.complete, false);
  assert.equal(status.nextStep.id, "accept-deliverable");
  assert.equal(deriveOnboardingStatus({ ...ready, connectionVerifiedAt: 100, evidence: { ...empty.evidence, successfulRun: true } }).nextStep.id, "accept-deliverable");
});

test("activation clears all remaining actions even when probes are unknown", () => {
  const status = deriveOnboardingStatus({ ...empty, activatedAt: 100 });
  assert.equal(status.complete, true);
  assert.equal(status.nextStep, null);
  assert.deepEqual(status.remaining, []);
});

test("skipped optional employees never interrupt required steps", () => {
  const draftTask = { ...brief, employeeTemplateId: "research", skippedSteps: ["employee"] };
  const status = deriveOnboardingStatus({ ...empty, draftTask });
  assert.equal(status.nextStep.id, "review");
  assert.equal(status.steps.find((step) => step.id === "employee").complete, false);
  assert.equal(deriveOnboardingStatus({ ...ready, draftTask: { ...draftTask, preparedAt: 100 } }).nextStep.id, "provider");
});

test("a pending template offers employee creation after the brief is ready", () => {
  const status = deriveOnboardingStatus({ ...empty, draftTask: { ...brief, employeeTemplateId: "research" } });
  assert.equal(status.complete, false);
  assert.equal(status.nextStep.id, "employee");
  assert.deepEqual(status.nextStep.target, { kind: "view", view: "custom-agents" });
  const saved = deriveOnboardingStatus({ ...empty, draftTask: { ...brief, employeeId: "employee_1", employeeVersion: 1 } });
  assert.equal(saved.steps.find((step) => step.id === "employee").complete, true);
  assert.equal(saved.nextStep.id, "review");
});

test("dismissal and unknown evidence do not earn completion", () => {
  const input = { ...ready, dismissedAt: 100, evidence: { connectedProvider: null, successfulRun: null, acceptedDeliverable: null } };
  const status = deriveOnboardingStatus(input);
  assert.equal(status.complete, false);
  assert.equal(status.nextStep.id, "provider");
  assert.deepEqual(status.remaining.map((step) => step.id), ["provider", "first-run", "accept-deliverable"]);
});

test("derivation is deterministic and leaves its input untouched", () => {
  const input = structuredClone(ready);
  const before = structuredClone(input);
  assert.deepEqual(deriveOnboardingStatus(input), deriveOnboardingStatus(input));
  assert.deepEqual(input, before);
});

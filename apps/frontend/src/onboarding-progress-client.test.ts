import { describe, expect, it, vi } from "vitest";
import { OnboardingConflictError, OnboardingProgressClient } from "./onboarding-progress-client";
import type { FirstRunProgressSnapshot } from "./components/FirstRunWizard";

const initial: FirstRunProgressSnapshot = {
  currentStep: "channels", dismissedAt: null, connectionVerifiedAt: null,
  firstSuccessfulRunAt: null, acceptedArtifactAt: null, activatedAt: null, revision: 0,
  evidence: { connectedProvider: null, successfulRun: null, acceptedDeliverable: null },
};

describe("OnboardingProgressClient", () => {
  it("adopts a newer conflicting draft without silently overwriting it", async () => {
    const latest = { ...initial, revision: 3 };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method
      ? Response.json(latest, { status: 409 }) : Response.json(initial));
    const applied = vi.fn();
    const client = new OnboardingProgressClient(fetcher, applied);
    await client.read();
    await expect(client.update({ action: "save-draft", draftTask: { goal: "My pending goal" } })).rejects.toBeInstanceOf(OnboardingConflictError);
    expect(applied).toHaveBeenLastCalledWith(latest);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("serializes resume and dismissal using the latest revision", async () => {
    const requests: Array<{ action: string; expectedRevision: number }> = [];
    let server = initial;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json(server);
      const body = JSON.parse(String(init.body)) as { action: string; expectedRevision: number };
      requests.push(body);
      server = { ...server, dismissedAt: body.action === "dismiss" ? 500 : null, revision: body.expectedRevision + 1 };
      return Response.json(server);
    });
    const applied: Array<FirstRunProgressSnapshot | null> = [];
    const client = new OnboardingProgressClient(fetcher, (progress) => applied.push(progress));
    await client.read();
    await client.update({ action: "resume" });
    await client.update({ action: "dismiss", currentStep: "channels" });
    expect(requests).toEqual([{ action: "resume", expectedRevision: 0 }, { action: "dismiss", currentStep: "channels", expectedRevision: 1 }]);
    expect(applied.at(-1)).toMatchObject({ dismissedAt: 500, revision: 2 });
  });

  it("ignores stale read snapshots and clears state when the account signs out", async () => {
    let finishStaleRead: ((response: Response) => void) | undefined;
    let reads = 0;
    let server = initial;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        reads += 1;
        if (reads === 2) return new Promise<Response>((resolve) => { finishStaleRead = resolve; });
        return Response.json(server);
      }
      server = { ...server, currentStep: "agent", revision: 1 };
      return Response.json(server);
    });
    const applied: Array<FirstRunProgressSnapshot | null> = [];
    const client = new OnboardingProgressClient(fetcher, (progress) => applied.push(progress));
    await client.read();
    const stale = client.read();
    await vi.waitFor(() => expect(reads).toBe(2));
    await client.update({ action: "step", currentStep: "agent" });
    finishStaleRead?.(Response.json(initial));
    await stale;
    expect(applied.at(-1)).toMatchObject({ currentStep: "agent", revision: 1 });
    client.reset();
    expect(applied.at(-1)).toBeNull();
  });
});

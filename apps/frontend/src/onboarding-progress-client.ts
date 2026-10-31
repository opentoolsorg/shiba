import type { FirstRunProgressSnapshot, FirstRunStepId } from "./components/FirstRunWizard";

export type FirstRunProgressAction = "step" | "dismiss" | "resume";
export interface FirstRunProgressUpdate {
  action: FirstRunProgressAction;
  currentStep?: FirstRunStepId;
}
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Account-scoped progress client with serialized writes and stale-read fencing. */
export class OnboardingProgressClient {
  private snapshot: FirstRunProgressSnapshot | null = null;
  private generation = 0;
  private lifecycle = 0;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly fetcher: Fetcher, private readonly onProgress: (progress: FirstRunProgressSnapshot | null) => void) {}

  reset(): void {
    this.lifecycle += 1;
    this.generation += 1;
    this.snapshot = null;
    this.onProgress(null);
  }

  async read(): Promise<FirstRunProgressSnapshot | null> {
    const generation = ++this.generation;
    const lifecycle = this.lifecycle;
    const response = await this.fetcher("/api/onboarding/progress", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Onboarding progress could not be loaded.");
    const progress = await response.json() as FirstRunProgressSnapshot;
    if (!this.accept(progress, lifecycle, generation)) return null;
    return this.snapshot;
  }

  update(body: FirstRunProgressUpdate): Promise<void> {
    const generation = ++this.generation;
    const lifecycle = this.lifecycle;
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      if (lifecycle !== this.lifecycle) return;
      if (this.snapshot === null) await this.readForMutation(lifecycle);
      if (lifecycle !== this.lifecycle || this.snapshot === null) return;
      let response = await this.send(body, this.snapshot.revision);
      if (response.status === 409) {
        const latest = await response.json() as FirstRunProgressSnapshot;
        if (lifecycle !== this.lifecycle) return;
        this.accept(latest, lifecycle, generation);
        response = await this.send(body, latest.revision);
      }
      if (!response.ok) throw new Error("Onboarding progress could not be saved.");
      this.accept(await response.json() as FirstRunProgressSnapshot, lifecycle, generation);
    });
    this.mutationQueue = operation.then(() => {}, () => {});
    return operation;
  }

  private async readForMutation(lifecycle: number): Promise<void> {
    const response = await this.fetcher("/api/onboarding/progress", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Onboarding progress could not be loaded.");
    this.accept(await response.json() as FirstRunProgressSnapshot, lifecycle);
  }

  private accept(progress: FirstRunProgressSnapshot, lifecycle: number, generation?: number): boolean {
    if (lifecycle !== this.lifecycle) return false;
    const currentRevision = this.snapshot?.revision;
    if (currentRevision !== undefined && progress.revision < currentRevision) return false;
    const newerRevision = currentRevision === undefined || progress.revision > currentRevision;
    if (!newerRevision && generation !== undefined && generation !== this.generation) return false;
    this.snapshot = progress;
    this.onProgress(progress);
    return true;
  }

  private send(body: FirstRunProgressUpdate, expectedRevision: number): Promise<Response> {
    return this.fetcher("/api/onboarding/progress", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, expectedRevision }),
    });
  }
}

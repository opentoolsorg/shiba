export interface LocalWorkerFixture {
  origin: string;
  persistDir: string;
  tempRoot: string;
  logs: string[];
  adapterToken: string;
  stop(): Promise<void>;
}

export function startWorkerFixture(options?: {
  repoRoot?: string;
  buildAssets?: boolean;
  localRuntime?: boolean;
}): Promise<LocalWorkerFixture>;

export function waitForWorkerReady(options: {
  worker: { exitCode: number | null; signalCode: string | null; fixtureSpawnError?: string };
  origin: string;
  logs: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<void>;

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

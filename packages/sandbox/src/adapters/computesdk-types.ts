/**
 * Minimal ComputeSDK surface used by the shiba adapter (verified against computesdk@4.1.12).
 * @see https://github.com/computesdk/computesdk
 */

export interface ComputesdkCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
}

export interface ComputesdkRunCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ComputesdkProcessHandle {
  kill(signal?: string): Promise<void>;
  wait(options?: { timeout?: number }): Promise<ComputesdkCommandResult & { signal: string | null }>;
}

export interface ComputesdkFilesystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** ComputeSDK universal instance (computesdk@4.1.12 `Instance` interface). */
export interface ComputesdkInstance {
  readonly instanceId: string;
  readonly provider: string;
  runCommand(command: string, options?: ComputesdkRunCommandOptions): Promise<ComputesdkCommandResult>;
  startProcess(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ComputesdkProcessHandle>;
  getUrl(options: { port: number; protocol?: string }): Promise<string>;
  destroy(): Promise<void>;
  readonly filesystem: ComputesdkFilesystem;
}

export interface ComputesdkInstanceManager {
  create(options?: { metadata?: Record<string, unknown> }): Promise<ComputesdkInstance>;
  getById(instanceId: string): Promise<ComputesdkInstance | null>;
  destroy(instanceId: string): Promise<void>;
}

/** Injectable client for tests and lazy Node loaders. */
export interface ComputesdkClient {
  readonly backendProvider: string;
  instances: ComputesdkInstanceManager;
}

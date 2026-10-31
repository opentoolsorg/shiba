import type { PreviewPortGateway } from "./port-gateway.js";

export const PREVIEW_PORT = 8080;
export const PORT_READY_TIMEOUT_MS = 30_000;
export const NAV_TIMEOUT_MS = 60_000;

export interface PreviewSandboxExecResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface PreviewSandbox extends PreviewPortGateway {
  exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<PreviewSandboxExecResult>;
  startProcess(
    command: string,
    options?: { cwd?: string },
  ): Promise<{
    waitForPort(port: number, options?: { timeout?: number }): Promise<void>;
    kill?(): Promise<void>;
  }>;
}

export interface PreviewPuppeteerPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean; type?: string }): Promise<ArrayBuffer | Uint8Array>;
  setRequestInterception(value: boolean): Promise<void>;
  on(event: "request", handler: (request: import("./request-policy.js").InterceptedRequest) => void): unknown;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number; visible?: boolean },
  ): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  evaluateOnNewDocument<Args extends unknown[]>(
    pageFunction: (...args: Args) => void,
    ...args: Args
  ): Promise<void>;
}

export interface PreviewPuppeteerBrowser {
  newPage(): Promise<PreviewPuppeteerPage>;
  close(): Promise<void>;
}

export interface PreviewBrowserDeps {
  launch?: (browser: Fetcher) => Promise<PreviewPuppeteerBrowser>;
  screenshotTimeoutMs?: number;
}

import type { PreviewPuppeteerBrowser, PreviewPuppeteerPage } from "../preview/types.js";

export interface BrowserSession {
  sessionId: string;
  runId: string;
  page: PreviewPuppeteerPage;
  browser: PreviewPuppeteerBrowser;
  createdAt: number;
  currentUrl: string | null;
}

const sessions = new Map<string, BrowserSession>();

export function getBrowserSession(runId: string): BrowserSession | null {
  return sessions.get(runId) ?? null;
}

export function setBrowserSession(session: BrowserSession): void {
  sessions.set(session.runId, session);
}

export async function closeBrowserSession(runId: string): Promise<void> {
  const session = sessions.get(runId);
  if (!session) return;
  sessions.delete(runId);
  try {
    await session.browser.close();
  } catch {
    // best-effort
  }
}

export function closeAllBrowserSessions(): void {
  const keys = [...sessions.keys()];
  for (const key of keys) void closeBrowserSession(key);
}
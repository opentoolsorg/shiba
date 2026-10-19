/**
 * Tokenized preview hostnames (`{port}-{sandboxId}-{token}.{workerHost}`),
 * matching the 0.12 exposePort shape so existing links keep working.
 */
const PREVIEW_HOST_RE = /^(\d+)-([a-zA-Z0-9_.-]{1,128})-([a-zA-Z0-9_-]{8,128})\./;

export interface PreviewRoute {
  port: number;
  sandboxId: string;
  token: string;
}

export function parsePreviewHostname(hostname: string): PreviewRoute | null {
  const match = PREVIEW_HOST_RE.exec(hostname);
  if (!match) return null;
  const port = Number(match[1]);
  const sandboxId = match[2];
  const token = match[3];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!sandboxId || !token) return null;
  return { port, sandboxId, token };
}

export function mintPreviewToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function previewUrlFor(port: number, sandboxId: string, token: string, workerHostname: string): string {
  return `https://${port}-${sandboxId}-${token}.${workerHostname}`;
}

export const PORT_TOKENS_KEY = "port-tokens-v1";

export type PortTokenMap = Record<string, string>;

export function loadPortTokens(raw: unknown): PortTokenMap {
  if (typeof raw !== "object" || raw === null) return {};
  return { ...(raw as PortTokenMap) };
}

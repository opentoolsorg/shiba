/** Small bounded HTTP helpers shared by channel adapters. Errors never echo URLs (tokens ride some paths). */

export const CHANNEL_API_TIMEOUT_MS = 30_000;

export async function channelFetch(
  fetchImpl: typeof fetch,
  label: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(CHANNEL_API_TIMEOUT_MS) });
  } catch {
    throw new Error(`${label} request failed.`);
  }
}

export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json().catch(() => ({}));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export async function readFile(response: Response, label: string): Promise<{ data: Uint8Array; contentType: string }> {
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

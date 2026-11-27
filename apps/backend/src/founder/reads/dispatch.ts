import { abortable, boundedBody } from "@shiba/openconnector-read-gateway";
import { ADAPTERS, type ReadProvider } from "./adapter.js";

export interface ReadHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/** The only fetch site: the provider's own origin, no redirects, 5 s, 32 KiB, strict UTF-8, status 200, deadline re-checked after the body. */
export async function dispatchReadRequest(request: ReadHttpRequest, expiresAt: number, provider: ReadProvider) {
  if (Date.now() >= expiresAt) throw new Error(`${provider}_authority_changed`);
  if (new URL(request.url).origin !== ADAPTERS[provider].origin) throw new Error(`${provider}_request_unconfirmed`);
  const signal = AbortSignal.timeout(Math.max(1, Math.min(5000, expiresAt - Date.now())));
  const response = await abortable(fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body } : {}),
    redirect: "manual",
    signal,
  }), signal);
  if (response.status !== 200) throw new Error(`${provider}_request_unconfirmed`);
  const bytes = await boundedBody(response.body, 32768, signal);
  if (Date.now() >= expiresAt) throw new Error(`${provider}_authority_changed`);
  return {
    body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    capturedBytes: bytes.length,
  };
}

/** Same-origin request policy for untrusted preview HTML (T33 / Phase 3 E2E). */

export interface InterceptedRequest {
  url(): string;
  isInterceptResolutionHandled(): boolean;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export async function allowSameOriginOnly(request: InterceptedRequest, previewUrl: string): Promise<void> {
  if (request.isInterceptResolutionHandled()) return;
  try {
    const target = new URL(request.url());
    const isHttp = target.protocol === "http:" || target.protocol === "https:";
    const isNonNetwork =
      target.protocol === "data:" || target.protocol === "blob:" || target.protocol === "about:";
    const allowed = isNonNetwork || (isHttp && target.origin === new URL(previewUrl).origin);
    if (allowed) {
      await request.continue();
    } else {
      await request.abort();
    }
  } catch {
    if (!request.isInterceptResolutionHandled()) {
      await request.abort().catch(() => undefined);
    }
  }
}

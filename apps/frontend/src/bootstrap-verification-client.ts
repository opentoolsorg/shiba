import { withAuthTimeout } from "./auth-timeout";

export interface BootstrapVerificationStatus {
  kind: "bootstrap"; email: string; emailVerified: boolean; available: boolean; statusSnapshot: string; reason?: string;
}
export class BootstrapVerificationError extends Error {
  constructor(public readonly status: number) {
    super(status === 429 ? "A verification link was requested recently. Wait one minute before sending again."
      : status === 503 ? "Verification delivery could not be confirmed. Check your email before requesting another link."
        : status === 401 ? "Sign in to your bootstrap account to check verification."
          : "Verification could not be confirmed. Reload the account status or request a new link.");
  }
}
async function call(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try { return await withAuthTimeout((async () => {
    const response = await fetch(path, { ...init, signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new BootstrapVerificationError(response.status);
    return response.json();
  })()); } finally { controller.abort(); signal?.removeEventListener("abort", abort); }
}
export async function getBootstrapVerificationStatus(signal?: AbortSignal): Promise<BootstrapVerificationStatus> {
  const value = await call("/api/auth/bootstrap-verification", { method: "GET" }, signal) as BootstrapVerificationStatus;
  if (value?.kind !== "bootstrap" || typeof value.email !== "string" || typeof value.emailVerified !== "boolean" ||
    typeof value.available !== "boolean" || !/^[a-f0-9]{64}$/.test(value.statusSnapshot)) throw new BootstrapVerificationError(502);
  return value;
}
export async function requestBootstrapVerification(statusSnapshot: string, signal?: AbortSignal): Promise<"sent" | "verified"> {
  if (!/^[a-f0-9]{64}$/.test(statusSnapshot)) throw new BootstrapVerificationError(400);
  const value = await call("/api/auth/bootstrap-verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSnapshot: statusSnapshot }) }, signal) as { sent?: unknown; emailVerified?: unknown };
  if (value?.sent === true) return "sent";
  if (value?.sent === false && value.emailVerified === true) return "verified";
  throw new BootstrapVerificationError(502);
}
export async function confirmBootstrapVerification(token: string, signal?: AbortSignal): Promise<void> {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new BootstrapVerificationError(400);
  const result = await call("/api/auth/bootstrap-verification/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }, signal) as { verified?: unknown };
  if (result?.verified !== true) throw new BootstrapVerificationError(502);
}

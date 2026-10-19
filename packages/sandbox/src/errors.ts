/** Typed error codes — adapters map provider failures here; callers branch without string matching. */
export type SandboxErrorCode =
  | "not_found"
  | "not_running"
  | "timeout"
  | "egress_denied"
  | "capability_unsupported"
  | "provider_misconfigured"
  | "exec_failed"
  | "io_failed"
  | "unknown";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly provider?: string;
  readonly cause?: unknown;

  constructor(
    code: SandboxErrorCode,
    message: string,
    opts?: { provider?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.provider = opts?.provider;
    this.cause = opts?.cause;
  }
}

export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof SandboxError;
}

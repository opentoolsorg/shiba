const REDACT_PATTERNS: RegExp[] = [
  /\bshk_[a-zA-Z0-9_-]{8,}\b/g,
  /\bshb_[a-zA-Z0-9_-]{8,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function redactBody(body: unknown): unknown {
  if (typeof body === "string") return redactSecrets(body);
  if (body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(redactBody);
  const record: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
    record[key] = typeof val === "string" ? redactSecrets(val) : redactBody(val);
  }
  return record;
}

export class ShibaApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ShibaApiError";
    this.status = status;
    this.body = redactBody(body);
  }
}

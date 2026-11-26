export type ConnectorErrorCode = "not_configured" | "auth_expired" | "forbidden" | "rate_limited" | "unavailable";

export class ConnectorProviderError extends Error {
  constructor(message: string, readonly code: ConnectorErrorCode = "unavailable", readonly status = 503) {
    super(message);
    this.name = "ConnectorProviderError";
  }
}

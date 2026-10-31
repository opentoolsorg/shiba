export interface ReasonNetworkCompanionOperation {
  operationId: string;
  claimToken: string;
  sessionId: string;
  destination: string;
  message: string;
  idempotencyKey: string;
  replyTo?: string;
}
export interface ReasonNetworkMcpClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(request: { name: string; arguments: Record<string, unknown>; _meta: { sessionId: string } }): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}
export declare function connectReasonNetworkStdio(options: { executablePath: string; timeoutMs?: number }): Promise<ReasonNetworkMcpClient>;
export declare function createReasonNetworkCompanion(input: {
  connect(): Promise<ReasonNetworkMcpClient>;
  beforeSend?(operation: ReasonNetworkCompanionOperation): Promise<boolean | "expired">;
}): (operation: ReasonNetworkCompanionOperation) => Promise<{ state: "accepted" | "unknown" | "cancelled" | "expired"; messageId?: string }>;

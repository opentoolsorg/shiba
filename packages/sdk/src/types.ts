import type { components, paths } from "./generated/openapi.js";

export type ApiPaths = paths;
export type ApiComponents = components;

export type CreateThreadInput = Omit<
  components["schemas"]["CreateThreadRequest"],
  "requestId"
> & { requestId?: string };

export type SendMessageInput = components["schemas"]["SendMessageRequest"];

export type Thread = {
  threadId?: string;
  repoUrl?: string;
  title?: string;
  status?: string;
  lane?: string;
  archived?: boolean;
  costUsd?: number | null;
  createdAt?: number;
  updatedAt?: number;
  pullUrl?: string | null;
  summary?: string | null;
  error?: string | null;
  expectedDeliverables?: components["schemas"]["ExpectedDeliverables"];
  deliverables?: components["schemas"]["RunDeliverable"][];
};

export type PublicStreamEvent = {
  id?: string;
  orgId?: string;
  projectId?: string | null;
  threadId?: string | null;
  runId?: string | null;
  sequence?: string;
  type?: string;
  data?: Record<string, unknown>;
  occurredAt?: string;
  publishedAt?: string;
  cursor?: string;
};

export type ThreadListResponse = { threads?: Thread[] };

export type ThreadGetResponse = { thread?: Thread };

export type CreateThreadResponse = {
  id?: string;
  threadId?: string | null;
  approvalId?: string;
  deduped?: boolean;
  status?: string;
};

export type SendMessageResponse = components["schemas"]["AdmitReceipt"] & {
  threadId?: string;
  approvalId?: string;
};

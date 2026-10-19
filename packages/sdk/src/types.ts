import type { components, paths } from "./generated/openapi.js";

export type ApiPaths = paths;
export type ApiComponents = components;

export type CreateThreadInput = Omit<
  components["schemas"]["CreateThreadRequest"],
  "requestId"
> & { requestId?: string };

export type SendMessageInput = components["schemas"]["SendMessageRequest"];

export type Thread = components["schemas"]["Thread"];

export type PublicStreamEvent = components["schemas"]["PublicStreamEvent"];

export type ThreadListResponse =
  paths["/threads"]["get"]["responses"][200]["content"]["application/json"];

export type ThreadGetResponse =
  paths["/threads/{threadId}"]["get"]["responses"][200]["content"]["application/json"];

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

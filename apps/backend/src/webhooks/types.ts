export const WEBHOOK_EVENT_KINDS = [
  "run.completed",
  "run.failed",
  "approval.requested",
  "pr.opened",
  "task.updated",
  "automation.finished",
] as const;

export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

export interface WebhookSubscriptionRow {
  id: string;
  workspace_id: string;
  url: string;
  events_json: string;
  secret_key_id: string;
  secret_cipher: string;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface WebhookDeliveryRow {
  id: string;
  subscription_id: string;
  event: string;
  payload_json: string;
  attempt: number;
  status: "pending" | "delivered" | "failed" | "dead_letter";
  response_code: number | null;
  response_body: string | null;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookQueueMessage {
  deliveryId: string;
  subscriptionId: string;
  attempt: number;
}
import { z } from "zod";

/** Provider-independent employee runtime wire contracts. */

export const EMPLOYEE_RUNTIME_MESSAGE_MAX_LENGTH = 12000;

export const EMPLOYEE_RUNTIME_MODES = ["chat", "work"] as const;
export type EmployeeRuntimeMode = (typeof EMPLOYEE_RUNTIME_MODES)[number];

export const employeeRuntimeProfileSchema = z.object({
  orgId: z.string().trim().min(1).max(128),
  employeeId: z.string().trim().min(1).max(128),
  employeeVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).optional(),
  instructions: z.string().max(32000).default(""),
  model: z.string().trim().max(200).optional(),
});
export type EmployeeRuntimeProfile = z.infer<typeof employeeRuntimeProfileSchema>;

export const employeeRuntimeChatRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(128).default("default"),
  message: z.string().trim().min(1).max(EMPLOYEE_RUNTIME_MESSAGE_MAX_LENGTH),
  mode: z.enum(EMPLOYEE_RUNTIME_MODES).default("chat"),
});
export type EmployeeRuntimeChatRequest = z.infer<typeof employeeRuntimeChatRequestSchema>;

export const employeeRuntimeConversationRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(128).default("default"),
});
export type EmployeeRuntimeConversationRequest = z.infer<typeof employeeRuntimeConversationRequestSchema>;

export const employeeRuntimeRecoveryRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(128).optional(),
}).strict();
export type EmployeeRuntimeRecoveryRequest = z.infer<typeof employeeRuntimeRecoveryRequestSchema>;

export const employeeRuntimeMemoryWriteSchema = z.object({
  conversationId: z.string().trim().min(1).max(128).optional(),
  scope: z.enum(["employee", "thread"]).default("employee"),
  kind: z.enum(["fact", "preference", "summary", "skill"]).default("fact"),
  content: z.string().trim().min(1).max(8000),
  essential: z.boolean().default(false),
});
export type EmployeeRuntimeMemoryWrite = z.infer<typeof employeeRuntimeMemoryWriteSchema>;

export const employeeRuntimeMemoryUpdateSchema = z.object({
  memoryId: z.string().trim().min(1).max(128),
  conversationId: z.string().trim().min(1).max(128).optional(),
  content: z.string().trim().min(1).max(8000).optional(),
  essential: z.boolean().optional(),
}).refine((value) => value.content !== undefined || value.essential !== undefined, { message: "content or essential is required" });
export type EmployeeRuntimeMemoryUpdateRequest = z.infer<typeof employeeRuntimeMemoryUpdateSchema>;

export const employeeRuntimeMemoryDeleteSchema = z.object({
  memoryId: z.string().trim().min(1).max(128),
  conversationId: z.string().trim().min(1).max(128).optional(),
});
export type EmployeeRuntimeMemoryDeleteRequest = z.infer<typeof employeeRuntimeMemoryDeleteSchema>;

export const employeeRuntimeCancelSchema = z.object({
  executionId: z.string().trim().min(1).max(128),
  conversationId: z.string().trim().min(1).max(128).default("default"),
});
export type EmployeeRuntimeCancelRequest = z.infer<typeof employeeRuntimeCancelSchema>;

export interface EmployeeRuntimeMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  executionId?: string;
}

export interface EmployeeRuntimeMemory {
  id: string;
  conversationId?: string;
  scope: "employee" | "thread";
  kind: "fact" | "preference" | "summary" | "skill";
  content: string;
  essential: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EmployeeRuntimeExecution {
  id: string;
  conversationId: string;
  mode: EmployeeRuntimeMode;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  checkpoint: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  recoverable?: boolean;
}

export interface EmployeeRuntimeConversationSummary {
  conversationId: string;
  summary: string;
  throughMessageId: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface EmployeeRuntimeState {
  conversationId: string;
  messages: EmployeeRuntimeMessage[];
  memories: EmployeeRuntimeMemory[];
  executions: EmployeeRuntimeExecution[];
  conversationSummary?: EmployeeRuntimeConversationSummary;
  permissions?: { canRecover?: boolean };
}

export interface EmployeeRuntimeChatResponse {
  execution: EmployeeRuntimeExecution;
  message: EmployeeRuntimeMessage;
  answer: string;
}

export type EmployeeRuntimeStreamEvent =
  | { type: "execution"; execution: EmployeeRuntimeExecution }
  | { type: "delta"; text: string }
  | { type: "done"; execution: EmployeeRuntimeExecution; message: EmployeeRuntimeMessage; answer: string }
  | { type: "error"; error: string; execution?: EmployeeRuntimeExecution };

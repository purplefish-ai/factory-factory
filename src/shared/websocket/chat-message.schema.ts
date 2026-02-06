/**
 * Zod schemas for validating incoming chat WebSocket messages.
 * Provides type-safe parsing with runtime validation.
 */

import { z } from 'zod';

// ============================================================================
// Attachment Schema
// ============================================================================

export const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  data: z.string(),
  contentType: z.enum(['image', 'text']).optional(),
});

// ============================================================================
// Chat Settings Schema
// ============================================================================

export const ChatSettingsSchema = z.object({
  selectedModel: z.string().nullable(),
  thinkingEnabled: z.boolean(),
  planModeEnabled: z.boolean(),
});

// ============================================================================
// Chat Message Schema (Discriminated Union)
// ============================================================================

export const ChatMessageSchema = z.discriminatedUnion('type', [
  // List sessions - no session required
  z.object({ type: z.literal('list_sessions') }),

  // Start a session
  z.object({
    type: z.literal('start'),
    thinkingEnabled: z.boolean().optional(),
    planModeEnabled: z.boolean().optional(),
    selectedModel: z.string().nullable().optional(),
    model: z.string().optional(),
  }),

  // User input (direct message, not queued)
  z.object({
    type: z.literal('user_input'),
    text: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  }),

  // Queue a message for sending
  z.object({
    type: z.literal('queue_message'),
    id: z.string().min(1),
    text: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
    settings: ChatSettingsSchema.optional(),
  }),

  // Remove a queued message
  z.object({
    type: z.literal('remove_queued_message'),
    messageId: z.string().min(1),
  }),

  // Stop the session
  z.object({ type: z.literal('stop') }),

  // Get session history
  z.object({ type: z.literal('get_history') }),

  // Load session data
  z.object({ type: z.literal('load_session') }),

  // Get queued messages (lightweight alternative to load_session)
  z.object({ type: z.literal('get_queue') }),

  // Answer a question from AskUserQuestion tool
  z.object({
    type: z.literal('question_response'),
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),

  // Respond to a permission request
  z.object({
    type: z.literal('permission_response'),
    requestId: z.string().min(1),
    allow: z.boolean(),
  }),

  // Set the model
  z.object({
    type: z.literal('set_model'),
    model: z.string().optional(),
  }),

  // Set thinking budget (max thinking tokens)
  z.object({
    type: z.literal('set_thinking_budget'),
    max_tokens: z.number().nullable(),
  }),

  // Rewind files to a previous state
  z.object({
    type: z.literal('rewind_files'),
    userMessageId: z.string().min(1),
    dryRun: z.boolean().optional(),
  }),
]);

// ============================================================================
// Exported Types
// ============================================================================

export type ChatMessageInput = z.infer<typeof ChatMessageSchema>;

// Narrow types for specific message types
export type ListSessionsMessage = Extract<ChatMessageInput, { type: 'list_sessions' }>;
export type StartMessageInput = Extract<ChatMessageInput, { type: 'start' }>;
export type UserInputMessage = Extract<ChatMessageInput, { type: 'user_input' }>;
export type QueueMessageInput = Extract<ChatMessageInput, { type: 'queue_message' }>;
export type RemoveQueuedMessageInput = Extract<ChatMessageInput, { type: 'remove_queued_message' }>;
export type StopMessage = Extract<ChatMessageInput, { type: 'stop' }>;
export type GetHistoryMessage = Extract<ChatMessageInput, { type: 'get_history' }>;
export type LoadSessionMessage = Extract<ChatMessageInput, { type: 'load_session' }>;
export type GetQueueMessage = Extract<ChatMessageInput, { type: 'get_queue' }>;
export type QuestionResponseMessage = Extract<ChatMessageInput, { type: 'question_response' }>;
export type PermissionResponseMessage = Extract<ChatMessageInput, { type: 'permission_response' }>;
export type SetModelMessage = Extract<ChatMessageInput, { type: 'set_model' }>;
export type SetThinkingBudgetMessage = Extract<ChatMessageInput, { type: 'set_thinking_budget' }>;
export type RewindFilesMessage = Extract<ChatMessageInput, { type: 'rewind_files' }>;

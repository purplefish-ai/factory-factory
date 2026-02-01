/**
 * Zod schemas for validating incoming chat WebSocket messages.
 * Provides type-safe parsing with runtime validation.
 */

import { z } from 'zod';

// ============================================================================
// Attachment Schema
// ============================================================================

const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  data: z.string(),
});

export type MessageAttachment = z.infer<typeof AttachmentSchema>;

// ============================================================================
// Chat Settings Schema
// ============================================================================

const ChatSettingsSchema = z.object({
  selectedModel: z.string().nullable(),
  thinkingEnabled: z.boolean(),
  planModeEnabled: z.boolean(),
});

export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

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
    id: z.string(),
    text: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
    settings: ChatSettingsSchema.optional(),
  }),

  // Remove a queued message
  z.object({
    type: z.literal('remove_queued_message'),
    messageId: z.string(),
  }),

  // Stop the session
  z.object({ type: z.literal('stop') }),

  // Get session history
  z.object({ type: z.literal('get_history') }),

  // Load session data
  z.object({ type: z.literal('load_session') }),

  // Answer a question from AskUserQuestion tool
  z.object({
    type: z.literal('question_response'),
    requestId: z.string(),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),

  // Respond to a permission request
  z.object({
    type: z.literal('permission_response'),
    requestId: z.string(),
    allow: z.boolean(),
  }),
]);

// ============================================================================
// Exported Types
// ============================================================================

export type ChatMessageInput = z.infer<typeof ChatMessageSchema>;

// Narrow types for specific message types
export type QuestionResponseMessage = Extract<ChatMessageInput, { type: 'question_response' }>;
export type PermissionResponseMessage = Extract<ChatMessageInput, { type: 'permission_response' }>;
export type QueueMessageInput = Extract<ChatMessageInput, { type: 'queue_message' }>;
export type StartMessageInput = Extract<ChatMessageInput, { type: 'start' }>;
export type UserInputMessage = Extract<ChatMessageInput, { type: 'user_input' }>;
export type RemoveQueuedMessageInput = Extract<ChatMessageInput, { type: 'remove_queued_message' }>;

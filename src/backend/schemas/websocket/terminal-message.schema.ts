/**
 * Zod schemas for validating incoming terminal WebSocket messages.
 * Provides type-safe parsing with runtime validation.
 */

import { z } from 'zod';

// ============================================================================
// Terminal Message Schema (Discriminated Union)
// ============================================================================

export const TerminalMessageSchema = z.discriminatedUnion('type', [
  // Create a new terminal
  z.object({
    type: z.literal('create'),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),

  // Send input to a terminal
  z.object({
    type: z.literal('input'),
    terminalId: z.string(),
    data: z.string(),
  }),

  // Resize a terminal
  z.object({
    type: z.literal('resize'),
    terminalId: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),

  // Destroy a terminal
  z.object({
    type: z.literal('destroy'),
    terminalId: z.string(),
  }),

  // Set active terminal
  z.object({
    type: z.literal('set_active'),
    terminalId: z.string(),
  }),

  // Ping (keepalive)
  z.object({ type: z.literal('ping') }),
]);

// ============================================================================
// Exported Types
// ============================================================================

export type TerminalMessageInput = z.infer<typeof TerminalMessageSchema>;

// Narrow types for specific message types
export type CreateTerminalMessage = Extract<TerminalMessageInput, { type: 'create' }>;
export type InputTerminalMessage = Extract<TerminalMessageInput, { type: 'input' }>;
export type ResizeTerminalMessage = Extract<TerminalMessageInput, { type: 'resize' }>;
export type DestroyTerminalMessage = Extract<TerminalMessageInput, { type: 'destroy' }>;
export type SetActiveTerminalMessage = Extract<TerminalMessageInput, { type: 'set_active' }>;

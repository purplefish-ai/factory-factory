/**
 * Zod schemas for validating incoming setup-terminal WebSocket messages.
 * These messages power the lightweight pre-workspace terminal.
 */

import { z } from 'zod';

export const SetupTerminalMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create'),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('input'),
    data: z.string(),
  }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);

export type SetupTerminalMessageInput = z.infer<typeof SetupTerminalMessageSchema>;

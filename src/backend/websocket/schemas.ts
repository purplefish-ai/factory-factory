import { z } from 'zod';

/**
 * Terminal WebSocket message schemas and validation
 */

// Terminal dimension limits
export const TERMINAL_LIMITS = {
  MIN_COLS: 20,
  MAX_COLS: 500,
  MIN_ROWS: 5,
  MAX_ROWS: 200,
  DEFAULT_COLS: 80,
  DEFAULT_ROWS: 24,
} as const;

// Session name validation - alphanumeric, hyphens, underscores
const sessionNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[\w-]+$/,
    'Session name must contain only alphanumeric characters, hyphens, and underscores'
  );

// Input message - keyboard input from client
const inputMessageSchema = z.object({
  type: z.literal('input'),
  data: z.string(),
});

// Resize message - terminal dimension change
const resizeMessageSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().min(TERMINAL_LIMITS.MIN_COLS).max(TERMINAL_LIMITS.MAX_COLS),
  rows: z.number().int().min(TERMINAL_LIMITS.MIN_ROWS).max(TERMINAL_LIMITS.MAX_ROWS),
});

// Combined terminal message schema (discriminated union)
export const terminalMessageSchema = z.discriminatedUnion('type', [
  inputMessageSchema,
  resizeMessageSchema,
]);

// Connection query parameters
export const connectionParamsSchema = z.object({
  session: sessionNameSchema,
  cols: z.coerce
    .number()
    .int()
    .min(TERMINAL_LIMITS.MIN_COLS)
    .max(TERMINAL_LIMITS.MAX_COLS)
    .default(TERMINAL_LIMITS.DEFAULT_COLS),
  rows: z.coerce
    .number()
    .int()
    .min(TERMINAL_LIMITS.MIN_ROWS)
    .max(TERMINAL_LIMITS.MAX_ROWS)
    .default(TERMINAL_LIMITS.DEFAULT_ROWS),
});

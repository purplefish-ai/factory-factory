/**
 * Zod schemas for validating Claude CLI tool inputs.
 *
 * These schemas provide runtime validation for tool inputs that were previously
 * type-cast without validation. Each schema matches the actual input format
 * sent by the Claude CLI/SDK.
 */

import { z } from 'zod';

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Minimal logger interface for validation warnings.
 * Compatible with the project's Logger type.
 */
export interface ValidationLogger {
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
}

// ============================================================================
// ExitPlanMode Input Schema
// ============================================================================

/**
 * Allowed prompt for plan mode execution.
 */
export const AllowedPromptSchema = z.object({
  tool: z.string(),
  prompt: z.string(),
});

/**
 * ExitPlanMode tool input.
 * SDK sends `plan` (inline content), CLI may send `planFile` (file path).
 */
export const ExitPlanModeInputSchema = z.object({
  plan: z.string().optional(), // SDK format (inline content)
  planFile: z.string().optional(), // CLI format (file path)
  allowedPrompts: z.array(AllowedPromptSchema).optional(),
});

export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;

// ============================================================================
// AskUserQuestion Input Schema
// ============================================================================

/**
 * Option for an AskUserQuestion question.
 */
export const AskUserQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

/**
 * A single question in AskUserQuestion input.
 */
export const AskUserQuestionItemSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(AskUserQuestionOptionSchema),
  multiSelect: z.boolean().optional(),
});

/**
 * AskUserQuestion tool input.
 */
export const AskUserQuestionInputSchema = z.object({
  questions: z.array(AskUserQuestionItemSchema),
});

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

// ============================================================================
// Task (Subagent) Input Schema
// ============================================================================

/**
 * Task tool input for spawning subagents.
 */
export const TaskToolInputSchema = z.object({
  subagent_type: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  max_turns: z.number().optional(),
  run_in_background: z.boolean().optional(),
  resume: z.string().optional(),
});

export type TaskToolInput = z.infer<typeof TaskToolInputSchema>;

// ============================================================================
// Command-based Tools Input Schema (Bash, etc.)
// ============================================================================

/**
 * Command tool input (used by Bash and similar tools).
 */
export const CommandToolInputSchema = z.object({
  command: z.string().optional(),
  description: z.string().optional(),
  timeout: z.number().optional(),
});

export type CommandToolInput = z.infer<typeof CommandToolInputSchema>;

// ============================================================================
// Hook Callback Input Schema
// ============================================================================

/**
 * Hook callback input from the CLI.
 */
export const HookCallbackInputSchema = z.object({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  permission_mode: z.string(),
  hook_event_name: z.string(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

export type HookCallbackInput = z.infer<typeof HookCallbackInputSchema>;

// ============================================================================
// CanUseTool Request Input Schema
// ============================================================================

/**
 * CanUseTool request input for permission checks.
 */
export const CanUseToolInputSchema = z.object({
  tool_name: z.string().optional(),
});

export type CanUseToolInput = z.infer<typeof CanUseToolInputSchema>;

// ============================================================================
// Utility: Safe Parser with Logging
// ============================================================================

/**
 * Result of a successful parse.
 */
export interface ParseSuccess<T> {
  success: true;
  data: T;
}

/**
 * Result of a failed parse.
 */
export interface ParseFailure {
  success: false;
  data: null;
}

/**
 * Result of safeParseToolInput.
 */
export type SafeParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Safely parse tool input with optional logging on failure.
 *
 * @param schema - Zod schema to validate against
 * @param input - The raw input to validate
 * @param toolName - Name of the tool (for logging)
 * @param logger - Optional logger for warnings
 * @returns Parse result with success flag and data (or null on failure)
 */
export function safeParseToolInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
  toolName: string,
  logger?: ValidationLogger
): SafeParseResult<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    if (logger) {
      logger.warn(`[Tool Input] ${toolName} input validation failed`, {
        toolName,
        errors: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        inputKeys: input && typeof input === 'object' ? Object.keys(input) : [],
      });
    }
    return { success: false, data: null };
  }
  return { success: true, data: result.data };
}

/**
 * Extract value from input with type guard, logging warning on type mismatch.
 *
 * @param input - The raw input object
 * @param key - Key to extract
 * @param typeGuard - Type guard function to validate the value
 * @param toolName - Tool name for logging
 * @param logger - Optional logger
 * @returns The value if it exists and passes the type guard, undefined otherwise
 */
export function extractInputValue<T>(
  input: Record<string, unknown>,
  key: string,
  typeGuard: (v: unknown) => v is T,
  toolName: string,
  logger?: ValidationLogger
): T | undefined {
  if (!(key in input)) {
    return undefined;
  }
  const value = input[key];
  if (!typeGuard(value)) {
    if (logger) {
      logger.warn(`[Tool Input] ${toolName}.${key} has unexpected type`, {
        toolName,
        key,
        actualType: typeof value,
      });
    }
    return undefined;
  }
  return value;
}

/**
 * Type guard for string values.
 */
export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * Type guard for arrays.
 */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

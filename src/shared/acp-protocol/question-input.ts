import { z } from 'zod';
import type { AskUserQuestion } from './protocol/interaction';

const nonEmptyText = z.string().refine((value) => value.trim().length > 0);
const questionInputSchema = z
  .array(
    z.object({
      id: z.string().optional(),
      question: nonEmptyText,
      header: z.string().optional(),
      options: z
        .array(
          z.object({
            label: nonEmptyText,
            description: z
              .unknown()
              .optional()
              .transform((value) => (typeof value === 'string' ? value : '')),
          })
        )
        .nullish()
        .transform((options) => options ?? []),
      multiSelect: z.boolean().optional(),
    })
  )
  .min(1);

/** Validate and normalize the question payload used by live and restored prompts. */
export function getAskUserQuestions(
  input: Record<string, unknown> | null | undefined
): AskUserQuestion[] {
  const result = questionInputSchema.safeParse(input?.questions);
  return result.success ? result.data : [];
}

/**
 * Returns true when the tool input looks like AskUserQuestion input.
 * This supports adapters that map question prompts to a non-standard tool name.
 */
export function hasAskUserQuestionInput(
  input: Record<string, unknown> | null | undefined
): boolean {
  return getAskUserQuestions(input).length > 0;
}

/**
 * Returns true when a pending request should be treated as a user-question prompt.
 */
export function isUserQuestionRequest(request: {
  toolName: string;
  rawToolName?: string;
  input?: Record<string, unknown>;
}): boolean {
  // An MCP tool may use both a question-shaped argument and a question-like
  // display title without being a provider's interactive question request.
  if (request.rawToolName?.startsWith('mcp__') || request.toolName.startsWith('mcp__')) {
    return false;
  }
  return hasAskUserQuestionInput(request.input);
}

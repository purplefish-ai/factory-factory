import { z } from 'zod';
import type { AskUserQuestion } from './protocol/interaction';
import { questionValidationSchema } from './question-validation';

export type { AskUserQuestion };
export { compileQuestionPattern, getStringAnswerError } from './question-validation';

export const companionNoteSchema = z.object({
  questionId: z.string().min(1),
  revealOnValue: z.string().optional(),
});

const nonEmptyText = z.string().refine((value) => value.trim().length > 0);
const questionInputSchema = z
  .array(
    z
      .object({
        id: z.string().optional(),
        question: nonEmptyText,
        header: z.string().optional(),
        options: z
          .array(
            z.object({
              label: nonEmptyText,
              value: nonEmptyText.optional(),
              description: z
                .unknown()
                .optional()
                .transform((value) => (typeof value === 'string' ? value : '')),
            })
          )
          .nullish()
          .transform((options) => options ?? []),
        multiSelect: z.boolean().optional(),
        optional: z.boolean().optional(),
        allowOther: z.boolean().optional(),
        companionNote: companionNoteSchema.optional().catch(undefined),
        validation: questionValidationSchema.optional(),
      })
      .transform(({ companionNote, ...question }) =>
        companionNote ? { ...question, companionNote } : question
      )
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

/** Provider identity wins over display titles and provider-shaped tool arguments. */
export function isMcpToolRequest(request: { toolName: string; rawToolName?: string }): boolean {
  return !!request.rawToolName?.startsWith('mcp__') || request.toolName.startsWith('mcp__');
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
  if (isMcpToolRequest(request)) {
    return false;
  }
  return hasAskUserQuestionInput(request.input);
}

const secretQuestionSchema = z.object({
  isSecret: z.unknown().optional(),
  secret: z.unknown().optional(),
  format: z.unknown().optional(),
  writeOnly: z.unknown().optional(),
  _meta: z
    .object({
      codex: z.object({ isSecret: z.unknown().optional() }).nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
});

/** Detect provider privacy flags without depending on display or unrelated metadata. */
export function isSecretQuestion(input: unknown): boolean {
  const flags = secretQuestionSchema.safeParse(input).data;
  if (!flags) {
    return false;
  }
  const codex = flags._meta?.codex;
  // A present boolean flag must explicitly opt out, even if its value is malformed.
  return (
    (['isSecret', 'secret', 'writeOnly'] as const).some(
      (key) => Object.hasOwn(flags, key) && flags[key] !== false
    ) ||
    (!!codex && Object.hasOwn(codex, 'isSecret') && codex.isSecret !== false) ||
    (Object.hasOwn(flags, 'format') &&
      (typeof flags.format !== 'string' || flags.format === 'password'))
  );
}

export function hasSecretQuestion(input: Record<string, unknown>): boolean {
  return Array.isArray(input.questions) && input.questions.some(isSecretQuestion);
}

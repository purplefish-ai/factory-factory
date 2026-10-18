import { z } from 'zod';

export const questionValidationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['number', 'integer']),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
  z.object({
    type: z.literal('string'),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
  }),
  z.object({
    type: z.literal('array'),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
  }),
]);

export type QuestionValidation = z.infer<typeof questionValidationSchema>;

export function getStringAnswerError(
  rules: Extract<QuestionValidation, { type: 'string' }>,
  text: string
): string | null {
  let value = z.string();
  if (rules.minLength !== undefined) {
    value = value.min(rules.minLength);
  }
  if (rules.maxLength !== undefined) {
    value = value.max(rules.maxLength);
  }
  try {
    if (rules.pattern !== undefined) {
      value = value.regex(new RegExp(rules.pattern));
    }
  } catch {
    return 'The requested response pattern is invalid.';
  }
  if (rules.format === 'email') {
    value = value.email();
  }
  if (rules.format === 'uri') {
    value = value.url();
  }
  if (rules.format === 'date') {
    value = value.date();
  }
  if (rules.format === 'date-time') {
    value = value.datetime({ offset: true });
  }
  const result = value.safeParse(text);
  return result.success ? null : (result.error.issues[0]?.message ?? 'Enter a valid response.');
}

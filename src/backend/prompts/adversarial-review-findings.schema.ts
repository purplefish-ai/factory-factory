import { z } from 'zod';

export const adversarialReviewCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']),
  severity: z.enum(['blocking', 'suggestion', 'nit']),
  body: z.string().min(1),
});

export const adversarialReviewFindingsSchema = z.object({
  summary: z.string().min(1),
  comments: z.array(adversarialReviewCommentSchema),
});

export type AdversarialReviewComment = z.infer<typeof adversarialReviewCommentSchema>;
export type AdversarialReviewFindings = z.infer<typeof adversarialReviewFindingsSchema>;

const JSON_FENCE_PATTERN = /```json\s*([\s\S]*?)```/g;

/**
 * Extract the last fenced ```json block from the review session's final
 * message and validate it against the findings contract. Per the
 * JSON.parse-boundary rule, the parsed value is never cast — Zod proves the
 * shape.
 */
export function parseAdversarialReviewFindings(rawMessage: string): AdversarialReviewFindings {
  const matches = [...rawMessage.matchAll(JSON_FENCE_PATTERN)];
  const lastMatch = matches.at(-1);
  if (!lastMatch?.[1]) {
    throw new Error('No fenced JSON findings block found in the review session output');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(lastMatch[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Findings block is not valid JSON: ${message}`);
  }

  const result = adversarialReviewFindingsSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Findings block failed validation: ${result.error.message}`);
  }
  return result.data;
}

import { z } from 'zod';

export const questionResponsesRecoveryProfile = 'base-json-question-responses-1';

// Freeze the wire shape independently of runtime question UI and transcript changes.
const questionSchema = z
  .strictObject({
    id: z.string().optional(),
    question: z.string(),
    header: z.string().optional(),
    answers: z.array(z.string()),
    note: z.string().optional(),
    redacted: z.literal(true).optional(),
  })
  .refine(
    (question) =>
      !question.redacted || (question.answers.length === 0 && !Object.hasOwn(question, 'note')),
    'Redacted questions cannot contain answers or notes'
  );

const responseSchema = z.strictObject({
  sessionId: z.string().min(1),
  providerSessionId: z.string().min(1),
  toolUseId: z.string().min(1),
  timestamp: z.iso.datetime(),
  summary: z.strictObject({
    toolUseId: z.string().min(1),
    requestId: z.string().optional(),
    status: z.enum(['answered', 'cancelled', 'unavailable']),
    questions: z.array(questionSchema),
  }),
});

export const questionResponsesRecoverySchema = z
  .strictObject({
    version: z.literal(1),
    responses: z.array(responseSchema),
  })
  .superRefine((section, ctx) => {
    const identities = new Set<string>();
    for (const [index, row] of section.responses.entries()) {
      const key = JSON.stringify([row.sessionId, row.providerSessionId, row.toolUseId]);
      if (identities.has(key) || row.toolUseId !== row.summary.toolUseId) {
        ctx.addIssue({
          code: 'custom',
          path: ['responses', index, 'toolUseId'],
          message: 'Question response identity is duplicate or does not match its summary',
        });
      }
      identities.add(key);
    }
  });

export type QuestionResponsesRecovery = z.infer<typeof questionResponsesRecoverySchema>;

import { z } from 'zod';
import {
  ArchivedJsonRecordSchema,
  ArchivedToolResultContentSchema,
} from './archived-content-schema';

export const QuestionResponseSchema = z.object({
  toolUseId: z.string().min(1),
  requestId: z.string().optional(),
  status: z.enum(['answered', 'cancelled', 'unavailable']),
  questions: z.array(
    z.object({
      id: z.string().optional(),
      question: z.string(),
      header: z.string().optional(),
      answers: z.array(z.string()),
      note: z.string().optional(),
      redacted: z.literal(true).optional(),
    })
  ),
});

export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;

export const QuestionToolDetailsSchema = z.object({
  toolName: z.string(),
  input: ArchivedJsonRecordSchema.optional(),
  result: ArchivedToolResultContentSchema.optional(),
});

export type QuestionToolDetails = z.infer<typeof QuestionToolDetailsSchema>;

/** Project optional properties from local tool inputs just as the JSON wire would. */
export function buildQuestionToolDetails(
  toolName: string,
  input: unknown,
  result?: unknown
): QuestionToolDetails {
  let wireInput: unknown;
  try {
    wireInput = JSON.parse(JSON.stringify(input));
  } catch {
    // Provider details are optional; the plain question summary can still be kept.
  }
  return {
    toolName,
    input: ArchivedJsonRecordSchema.safeParse(wireInput).data,
    result: ArchivedToolResultContentSchema.safeParse(result).data,
  };
}

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

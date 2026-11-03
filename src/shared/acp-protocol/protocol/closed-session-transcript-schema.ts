import { z } from 'zod';
import { ArchivedJsonRecordSchema, ArchivedJsonValueSchema } from './archived-content-schema';

/** Compatible read DTO: envelope extensions and legacy rows remain opaque JSON. */
export const ClosedSessionReadTranscriptSchema = ArchivedJsonRecordSchema.transform(
  (value, ctx) => {
    const messages = z.array(ArchivedJsonValueSchema).safeParse(value.messages);
    if (!messages.success) {
      ctx.issues.push({
        code: 'custom',
        message: 'Expected a messages JSON array',
        path: ['messages'],
        input: value.messages,
      });
      return z.NEVER;
    }
    // Spread preserves own reserved keys while inference requires validated messages.
    return { ...value, messages: messages.data };
  }
);

export type ClosedSessionReadTranscript = z.infer<typeof ClosedSessionReadTranscriptSchema>;

export function parseClosedSessionReadTranscript(serialized: unknown) {
  const value: unknown = JSON.parse(z.string().parse(serialized));
  return ClosedSessionReadTranscriptSchema.parse(value);
}

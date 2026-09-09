import { z } from 'zod';

const styleSchema = z.record(z.string(), z.union([z.string(), z.number()]).optional());

export const diffHighlightRequestSchema = z.object({
  lines: z.array(
    z.object({
      type: z.enum(['header', 'addition', 'deletion', 'context', 'hunk']),
      content: z.string(),
      lineNumber: z.object({ old: z.number().optional(), new: z.number().optional() }).optional(),
    })
  ),
  language: z.string(),
  theme: z.record(z.string(), styleSchema),
});

export const diffHighlightResponseSchema = z
  .map(
    z.number().int().nonnegative(),
    z.array(z.object({ content: z.string(), style: styleSchema.optional() }))
  )
  .nullable();

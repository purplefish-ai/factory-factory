import { z } from 'zod';
import { MAX_IMAGE_SIZE } from '@/shared/attachment-limits';

const DirectInputImageSourceSchema = z.object({
  type: z.literal('base64'),
  media_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_IMAGE_SIZE / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((data) => data.length % 4 === 0)
    .refine(
      (data) =>
        (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) <=
        MAX_IMAGE_SIZE
    ),
});

/** Direct input remains untrusted until both block shape and image encoding are checked. */
export const DirectInputContentItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), source: DirectInputImageSourceSchema }),
]);

export const DirectInputContentSchema = z.union([
  z.string(),
  z.array(DirectInputContentItemSchema),
]);

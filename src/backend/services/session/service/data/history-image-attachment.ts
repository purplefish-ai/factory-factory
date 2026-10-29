import { z } from 'zod';
import type { MessageAttachment } from '@/shared/acp-protocol';
import { MAX_IMAGE_SIZE } from '@/shared/attachment-limits';

const HistoryImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HistoryImageDataSchema = z
  .string()
  .min(1)
  .max(Math.ceil(MAX_IMAGE_SIZE / 3) * 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((data) => data.length % 4 === 0);

export const HistoryImageSourceSchema = z.object({
  media_type: HistoryImageMediaTypeSchema,
  data: HistoryImageDataSchema,
});

export type HistoryImageSource = z.infer<typeof HistoryImageSourceSchema>;

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

/** Parse a base64 image data URL; returns null for remote URLs or unsupported images. */
export function parseImageDataUrl(value: unknown): HistoryImageSource | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const parsed = HistoryImageSourceSchema.safeParse({ media_type: match[1], data: match[2] });
  return parsed.success ? parsed.data : null;
}

/** Build replay attachments from validated images, dropping any above the upload size limit. */
export function buildHistoryImageAttachments(
  images: { source: HistoryImageSource; index: number }[],
  idPrefix: string
): MessageAttachment[] {
  let imageIndex = 0;
  return images.flatMap(({ source, index }) => {
    const { data, media_type: mediaType } = source;
    const size = Buffer.byteLength(data, 'base64');
    if (size > MAX_IMAGE_SIZE) {
      return [];
    }
    imageIndex += 1;
    return [
      {
        id: `${idPrefix}-${index}`,
        name: `image-${imageIndex}.${mediaType.slice('image/'.length)}`,
        type: mediaType,
        contentType: 'image' as const,
        size,
        data,
      },
    ];
  });
}

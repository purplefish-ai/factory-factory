import { z } from 'zod';
import type { ImageItem, TextItem, ToolResultContentValue } from '@/shared/acp-protocol';
import { HistoryImageSourceSchema, parseImageDataUrl } from './history-image-attachment';

const itemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  source: z.unknown().optional(),
});

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeItem(value: unknown): { image: boolean; content: ImageItem | TextItem } {
  const parsed = itemSchema.safeParse(value);
  if (!parsed.success) {
    return { image: false, content: { type: 'text', text: serialize(value) } };
  }
  const item = parsed.data;
  if (item.type !== 'input_image' && item.type !== 'image') {
    return { image: false, content: { type: 'text', text: item.text ?? serialize(value) } };
  }
  const image = HistoryImageSourceSchema.safeParse(
    item.type === 'input_image'
      ? parseImageDataUrl(item.image_url)
      : (item.source ?? { data: item.data, media_type: item.mimeType })
  );
  return {
    image: true,
    content: image.success
      ? { type: 'image', source: { type: 'base64', ...image.data } }
      : {
          type: 'text',
          text: `Image unavailable: ${item.image_url ?? serialize(item.source ?? value)}`,
        },
  };
}

/** Keep generated images in Codex rollouts compatible with live ACP results. */
export function normalizeCodexFunctionOutput(output: unknown): ToolResultContentValue {
  if (typeof output === 'string') {
    return output;
  }
  if (output === undefined || output === null) {
    return '';
  }
  if (Array.isArray(output)) {
    const items = output.map(normalizeItem);
    if (items.some((item) => item.image)) {
      return items.map((item) => item.content);
    }
  }
  return serialize(output);
}

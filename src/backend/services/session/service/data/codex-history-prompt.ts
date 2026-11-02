import type { AgentContentItem, HistoryMessage } from '@/shared/acp-protocol';
import { parseImageDataUrl } from './history-image-attachment';

/** Preserve native user block order before the UI joins text and groups images. */
export function codexHistoryPrompt(
  content: { type: string; text?: string; image_url?: string }[],
  kinds?: string[]
): AgentContentItem[] | undefined {
  const prompt = content.flatMap<AgentContentItem>((block, index) => {
    if (block.type === 'input_text' && (!kinds || kinds[index] === 'user.text')) {
      return [{ type: 'text', text: block.text ?? '' }];
    }
    if (block.type === 'input_image' && (!kinds || kinds[index] === 'user.image')) {
      const source = parseImageDataUrl(block.image_url);
      return source ? [{ type: 'image', source: { type: 'base64', ...source } }] : [];
    }
    return [];
  });
  return prompt.length > 1 || prompt[0]?.type === 'image' ? prompt : undefined;
}

/** An event's UI text may omit images or flatten response-item text blocks. */
export function restoreCodexEventPrompt(
  message: HistoryMessage,
  response: HistoryMessage | undefined,
  isEvent: boolean
): HistoryMessage {
  if (!(isEvent && message.type === 'user' && response?.type === 'user')) {
    return message;
  }
  return {
    ...message,
    ...(!message.attachments && response.attachments ? { attachments: response.attachments } : {}),
    ...(response.providerPrompt !== undefined ? { providerPrompt: response.providerPrompt } : {}),
  };
}

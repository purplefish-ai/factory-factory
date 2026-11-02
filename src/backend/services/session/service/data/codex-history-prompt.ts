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

export interface CodexHistoryItem {
  source: 'event' | 'response';
  message: HistoryMessage;
  turnId?: string;
}
type UserHistory = Extract<HistoryMessage, { type: 'user' }>;

function representsEvent(event: UserHistory, responses: UserHistory[]): boolean {
  const text = responses
    .map((response) => response.content)
    .filter(Boolean)
    .join('\n');
  if (text !== event.content) {
    return false;
  }
  const images = responses.flatMap((response) => response.attachments ?? []);
  return (
    !event.attachments?.length ||
    (event.attachments.length === images.length &&
      event.attachments.every(
        (image, index) => image.data === images[index]?.data && image.type === images[index]?.type
      ))
  );
}

function restoreEvent(event: UserHistory, responses: UserHistory[]): UserHistory {
  const attachments = responses.flatMap((response) => response.attachments ?? []);
  const prompt = responses.flatMap<AgentContentItem>((response) => {
    const content = response.providerPrompt;
    if (Array.isArray(content)) {
      return content;
    }
    return [{ type: 'text', text: typeof content === 'string' ? content : response.content }];
  });
  // A single plain-text response already has the same projection; preserve its
  // absent provenance rather than changing the established legacy wire shape.
  const keepPrompt = responses.length > 1 || responses[0]?.providerPrompt !== undefined;
  return {
    ...event,
    ...(!event.attachments?.length && attachments.length ? { attachments } : {}),
    ...(keepPrompt ? { providerPrompt: prompt } : {}),
  };
}

function uniqueUsers(messages: UserHistory[]): Map<string, UserHistory | null> {
  const byText = new Map<string, UserHistory | null>();
  for (const message of messages) {
    byText.set(message.content, byText.has(message.content) ? null : message);
  }
  return byText;
}

/** Match copies within one parsed turn; unmatched native records remain history. */
export function projectCodexTurnUsers(items: CodexHistoryItem[]) {
  const users = items.flatMap((item) =>
    item.message.type === 'user' ? [{ ...item, message: item.message }] : []
  );
  const events = users.filter((item) => item.source === 'event');
  const responses = users.filter((item) => item.source === 'response');
  const replacements = new Map<HistoryMessage, HistoryMessage>();
  const covered = new Set<HistoryMessage>();
  const event = events[0];
  const responseMessages = responses.map((item) => item.message);
  const first = items.findIndex((item) => item.message === responses[0]?.message);
  const last = items.findIndex((item) => item.message === responses.at(-1)?.message);
  const oneNativePrompt =
    event?.turnId &&
    events.length === 1 &&
    responses.length > 1 &&
    responses.every((item) => item.turnId === event.turnId) &&
    items.slice(first, last + 1).every((item) => item.message.type === 'user') &&
    representsEvent(event.message, responseMessages);
  if (oneNativePrompt) {
    replacements.set(event.message, restoreEvent(event.message, responseMessages));
    responseMessages.forEach((message) => covered.add(message));
    return { replacements, covered };
  }
  const uniqueEvents = uniqueUsers(events.map((item) => item.message));
  const uniqueResponses = uniqueUsers(responseMessages);
  for (const item of events) {
    const response = uniqueResponses.get(item.message.content);
    if (
      uniqueEvents.get(item.message.content) &&
      response &&
      representsEvent(item.message, [response])
    ) {
      replacements.set(item.message, restoreEvent(item.message, [response]));
      covered.add(response);
    }
  }
  return { replacements, covered };
}

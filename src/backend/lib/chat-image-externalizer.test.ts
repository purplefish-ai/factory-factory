import { describe, expect, it } from 'vitest';
import {
  type ImageSource,
  type MessageAttachment,
  MessageState,
  type WebSocketMessage,
} from '@/shared/acp-protocol';
import { CHAT_IMAGE_ID_PATTERN } from '@/shared/chat-image-ref';
import { noisePng } from '@/test-utils/image-fixtures';
import { externalizeChatImages } from './chat-image-externalizer';
import { ChatImageStore } from './chat-image-store';

const png = noisePng(4, 3);
const pngData = png.toString('base64');

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att-1',
    name: 'shot.png',
    type: 'image/png',
    size: png.length,
    data: pngData,
    contentType: 'image',
    ...overrides,
  };
}

function accepted(attachments: MessageAttachment[]): WebSocketMessage {
  return {
    type: 'session_delta',
    data: {
      type: 'message_state_changed',
      id: 'm1',
      newState: MessageState.ACCEPTED,
      userMessage: { text: 'look', timestamp: '2026-11-23T00:00:00.000Z', attachments },
    },
  };
}

function toolResult(source: ImageSource): WebSocketMessage {
  return {
    type: 'session_delta',
    data: {
      type: 'agent_message',
      order: 1,
      data: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'screenshot' },
                { type: 'image', source },
              ],
            },
          ],
        },
      },
    },
  };
}

describe('externalizeChatImages', () => {
  it('replaces an image attachment with a reference and keeps its bytes in the store', () => {
    const store = new ChatImageStore();
    const sent = externalizeChatImages(accepted([attachment()]), store);

    const attachments = JSON.parse(JSON.stringify(sent)).data.userMessage.attachments;
    expect(attachments).toEqual([
      {
        id: 'att-1',
        name: 'shot.png',
        type: 'image/png',
        size: png.length,
        data: '',
        contentType: 'image',
        ref: {
          id: expect.stringMatching(CHAT_IMAGE_ID_PATTERN),
          size: png.length,
          width: 4,
          height: 3,
        },
      },
    ]);
    expect(store.get(attachments[0].ref.id)).toEqual({
      mediaType: 'image/png',
      data: pngData,
      size: png.length,
    });
  });

  it('names an image by its content, so the same bytes always get the same URL', () => {
    const store = new ChatImageStore();
    const refOf = (message: WebSocketMessage) =>
      JSON.parse(JSON.stringify(message)).data.userMessage.attachments[0].ref.id;
    const first = refOf(externalizeChatImages(accepted([attachment()]), store));
    const again = refOf(externalizeChatImages(accepted([attachment({ id: 'other' })]), store));
    const other = refOf(
      externalizeChatImages(
        accepted([attachment({ data: noisePng(4, 3).toString('base64') })]),
        store
      )
    );
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('replaces a tool result image with a reference source', () => {
    const store = new ChatImageStore();
    const sent = externalizeChatImages(
      toolResult({ type: 'base64', media_type: 'image/png', data: pngData }),
      store
    );
    const image = JSON.parse(JSON.stringify(sent)).data.data.message.content[0].content[1];
    expect(image).toEqual({
      type: 'image',
      source: {
        type: 'ref',
        media_type: 'image/png',
        id: expect.stringMatching(CHAT_IMAGE_ID_PATTERN),
        size: png.length,
        width: 4,
        height: 3,
      },
    });
    expect(store.get(image.source.id)?.data).toBe(pngData);
  });

  it('externalizes every event of a replay batch', () => {
    const store = new ChatImageStore();
    const events = [
      accepted([attachment()]),
      toolResult({ type: 'base64', media_type: 'image/png', data: pngData }),
    ]
      .map((message) => (message.type === 'session_delta' ? message.data : null))
      .filter((event) => event !== null);
    const sent = JSON.stringify(externalizeChatImages(events, store));
    expect(sent).not.toContain(pngData);
    expect(sent.length).toBeLessThan(2000);
  });

  it('leaves text attachments, unsupported images and image-free payloads untouched', () => {
    const store = new ChatImageStore();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const untouched = accepted([
      attachment({ id: 'text', type: 'text/plain', contentType: 'text', data: 'hello' }),
      attachment({ id: 'svg', type: 'image/svg+xml', data: svg }),
    ]);
    expect(externalizeChatImages(untouched, store)).toBe(untouched);

    const plain: WebSocketMessage = {
      type: 'session_delta',
      data: { type: 'slash_commands', slashCommands: [] },
    };
    expect(externalizeChatImages(plain, store)).toBe(plain);
  });

  it('copies only what it changes and never mutates the stored transcript', () => {
    const store = new ChatImageStore();
    const original = accepted([attachment()]);
    const snapshot = JSON.stringify(original);
    externalizeChatImages(original, store);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('registers the image again after the store evicted it', () => {
    const store = new ChatImageStore({ maxChars: pngData.length });
    const message = accepted([attachment()]);
    const id = JSON.parse(JSON.stringify(externalizeChatImages(message, store))).data.userMessage
      .attachments[0].ref.id;
    store.put('filler', { mediaType: 'image/png', data: pngData, size: png.length });
    expect(store.get(id)).toBeUndefined();
    externalizeChatImages(message, store);
    expect(store.get(id)?.data).toBe(pngData);
  });
});

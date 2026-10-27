import { describe, expect, it, vi } from 'vitest';
import { createDefaultApplicationDependencies } from '@/backend/app-context';
import { sessionConfigService } from '@/backend/services/session';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { ChatMessageInput } from '@/shared/websocket';
import { createChatMessageRouterForApplication } from './chat-message-router';

const router = createChatMessageRouterForApplication(
  createDefaultApplicationDependencies().services
);

describe('chat command routing from application composition', () => {
  it('returns a typed missing-session error without touching the socket', async () => {
    const outcome = await router.handleMessage(null, '/tmp/work', {
      type: 'set_model',
      model: 'chosen',
    });
    expect(outcome).toEqual({ replies: [{ type: 'error', error: { kind: 'no_session' } }] });
  });

  it('returns plain model capabilities from the application command registry', async () => {
    const model = vi.spyOn(sessionConfigService, 'setSessionModel').mockResolvedValue(undefined);
    vi.spyOn(sessionConfigService, 'getChatBarCapabilities').mockResolvedValue(
      EMPTY_CHAT_BAR_CAPABILITIES
    );
    const outcome = await router.handleMessage('session-command', '/tmp/work', {
      type: 'set_model',
      model: 'chosen',
    });
    expect(model).toHaveBeenCalledWith('session-command', 'chosen');
    expect(outcome).toEqual({
      replies: [{ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES }],
    });
  });
});

it.each([
  { type: 'start' },
  { type: 'stop' },
  { type: 'user_input', text: 'human' },
  { type: 'queue_message', id: 'human', text: 'human' },
  { type: 'remove_queued_message', messageId: 'human' },
  { type: 'resume_queued_messages' },
] satisfies ChatMessageInput[])(
  'routes missing-session %o as a typed outcome without touching a socket',
  async (message) => {
    expect(await router.handleMessage(null, '/tmp', message)).toEqual({
      replies: [{ type: 'error', error: { kind: 'no_session' } }],
    });
  }
);

import { describe, expect, it, vi } from 'vitest';
import { sessionCommandFactories } from '@/backend/services/session';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { ChatMessageInput } from '@/shared/websocket';
import { createChatMessageRouter } from './chat-message-router';
import { createChatRouterServices } from './chat-message-router.test-helpers';

describe('chat message routing at the transport boundary', () => {
  it.each([
    { type: 'load_session', loadRequestId: 'load-1' },
    { type: 'start' },
    { type: 'stop' },
    { type: 'user_input', text: 'human' },
    { type: 'queue_message', id: 'human', text: 'human' },
    { type: 'remove_queued_message', messageId: 'human' },
    { type: 'resume_queued_messages' },
    { type: 'set_model', model: 'chosen' },
    { type: 'set_config_option', configId: 'model', value: 'chosen' },
    { type: 'set_thinking_budget', max_tokens: null },
    { type: 'permission_response', requestId: 'permission-1', optionId: 'allow' },
  ] satisfies ChatMessageInput[])(
    'returns a typed missing-session error for %o',
    async (message) => {
      const services = createChatRouterServices(sessionCommandFactories);
      const router = createChatMessageRouter(services);
      expect(await router.handleMessage(null, '/tmp/work', message)).toEqual({
        replies: [{ type: 'error', error: { kind: 'no_session' } }],
      });
      expect(services.load.prepareLoad).not.toHaveBeenCalled();
      expect(services.startup.getOrCreateSessionClient).not.toHaveBeenCalled();
      expect(services.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
    }
  );

  it('returns model capabilities as a requester outcome without publishing a session event', async () => {
    const services = createChatRouterServices(sessionCommandFactories);
    const outcome = await createChatMessageRouter(services).handleMessage(
      'session-command',
      '/tmp/work',
      { type: 'set_model', model: 'chosen' }
    );
    expect(services.config.setSessionModel).toHaveBeenCalledWith('session-command', 'chosen');
    expect(outcome).toEqual({
      replies: [{ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES }],
    });
    expect(services.eventBus.publishToSession).not.toHaveBeenCalled();
  });

  it('routes load-session errors as typed requester outcomes before any replay or activation', async () => {
    const services = createChatRouterServices(sessionCommandFactories);
    vi.mocked(services.load.prepareLoad).mockResolvedValue({
      status: 'error',
      outcome: { replies: [{ type: 'error', error: { kind: 'session_not_found' } }] },
    });
    expect(
      await createChatMessageRouter(services).handleMessage('missing', '/tmp/work', {
        type: 'load_session',
        loadRequestId: 'load-1',
      })
    ).toEqual({ replies: [{ type: 'error', error: { kind: 'session_not_found' } }] });
    expect(services.load.prepareLoad).toHaveBeenCalledWith({
      sessionId: 'missing',
      loadRequestId: 'load-1',
    });
    expect(services.load.captureReplay).not.toHaveBeenCalled();
    expect(services.load.completeLoad).not.toHaveBeenCalled();
  });
});

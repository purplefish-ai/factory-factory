import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  chatMessageHandlerService,
  sessionConfigService,
} from '@/backend/services/session/service/lifecycle/session-services';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';

describe('chat command routing during transport migration', () => {
  it('returns a typed missing-session error without touching the socket', async () => {
    const ws = { send: vi.fn() };
    const outcome = await chatMessageHandlerService.handleMessage(
      ws as unknown as WebSocket,
      null,
      '/tmp/work',
      { type: 'set_model', model: 'chosen' }
    );
    expect(outcome).toEqual({ replies: [{ type: 'error', error: { kind: 'no_session' } }] });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns plain model replies from the mixed registry rather than sending them', async () => {
    const ws = { send: vi.fn() };
    const model = vi.spyOn(sessionConfigService, 'setSessionModel').mockResolvedValue(undefined);
    vi.spyOn(sessionConfigService, 'getChatBarCapabilities').mockResolvedValue(
      EMPTY_CHAT_BAR_CAPABILITIES
    );
    const outcome = await chatMessageHandlerService.handleMessage(
      ws as unknown as WebSocket,
      'session-command',
      '/tmp/work',
      { type: 'set_model', model: 'chosen' }
    );
    expect(model).toHaveBeenCalledWith('session-command', 'chosen');
    expect(outcome).toEqual({
      replies: [{ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES }],
    });
    expect(ws.send).not.toHaveBeenCalled();
  });
});

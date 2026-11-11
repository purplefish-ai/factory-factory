import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '@/lib/chat-protocol';
import { parseChatServerMessage } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import { createActionFromWebSocketMessage } from './index';

describe('permission request WebSocket messages', () => {
  it('preserves array acpOptions', () => {
    const acpOptions = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ];
    const action = createActionFromWebSocketMessage({
      type: 'permission_request',
      requestId: 'req-123',
      toolName: 'Bash',
      acpOptions,
    });

    expect((action as { payload: PermissionRequest }).payload.acpOptions).toEqual(acpOptions);
  });

  it('rejects non-array acpOptions at the transport boundary', () => {
    const parsed = parseChatServerMessage({
      type: 'permission_request',
      requestId: 'req-123',
      toolName: 'Bash',
      acpOptions: {
        0: { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        length: 1,
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('omits absent acpOptions', () => {
    const action = createActionFromWebSocketMessage({
      type: 'permission_request',
      requestId: 'req-123',
      toolName: 'Bash',
    });

    expect((action as { payload: PermissionRequest }).payload).not.toHaveProperty('acpOptions');
  });
});

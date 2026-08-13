import { describe, expect, it } from 'vitest';
import type { PermissionRequest, WebSocketMessage } from '@/lib/chat-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
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

  it('omits non-array acpOptions', () => {
    const action = createActionFromWebSocketMessage(
      unsafeCoerce<WebSocketMessage>({
        type: 'permission_request',
        requestId: 'req-123',
        toolName: 'Bash',
        acpOptions: {
          0: { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          length: 1,
        },
      })
    );

    expect((action as { payload: PermissionRequest }).payload).not.toHaveProperty('acpOptions');
  });
});

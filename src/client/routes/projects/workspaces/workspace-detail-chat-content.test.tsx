// @vitest-environment jsdom
import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';

vi.mock('@/client/features/chat', () => ({
  useGroupedChatMessages: () => [],
  VirtualizedMessageList: () => null,
  ChatInput: () => null,
  PermissionPrompt: () => null,
  QuestionPrompt: () => null,
  RewindConfirmationDialog: () => null,
}));
vi.mock('@/client/features/voice', () => ({ VoiceModeToggle: () => null }));
vi.mock('./use-retry-workspace-init', () => ({
  useRetryWorkspaceInit: () => ({ retry: vi.fn(), retryInit: { isPending: false } }),
}));

describe('ChatContent init banner ownership', () => {
  it.each(['warning', 'error'] as const)(
    'leaves %s script failures to the workspace banner',
    (kind) => {
      const props = {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        messages: [],
        queuedMessages: [],
        sessionStatus: { phase: 'ready' },
        sessionRuntime: createInitialSessionRuntimeState(),
        chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
        pendingRequest: { type: 'none' },
        pendingMessages: new Map(),
        inputRef: createRef(),
        viewportRef: createRef(),
        initBanner: {
          kind,
          message: 'Init script failed',
          showRetry: true,
          showPlay: false,
          showDismiss: true,
        },
        isScriptFailed: true,
      } as unknown as ChatContentProps;
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        flushSync(() => root.render(<ChatContent {...props} />));
        expect(container.textContent).not.toContain('Init script failed');
        flushSync(() => root.render(<ChatContent {...props} isScriptFailed={false} />));
        expect(container.textContent).toContain('Init script failed');
        expect(container.textContent).toContain('Retry setup');
      } finally {
        flushSync(() => root.unmount());
      }
    }
  );
});

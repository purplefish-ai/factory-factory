// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkspaceChat, type WorkspaceChatProps } from './workspace-chat-slot';
import type { ChatContentProps } from './workspace-detail-chat-content';

const session = vi.hoisted(() => ({ runtimeSessionId: null as string | null }));
const content = vi.hoisted(() => vi.fn((_props: ChatContentProps) => null));

vi.mock('@/client/features/chat', () => ({
  useChatSessionState: () => ({
    runtimeSessionId: session.runtimeSessionId,
    sessionStatus: { phase: 'ready' },
    processStatus: { state: 'alive' },
    messages: [],
  }),
}));
vi.mock('./workspace-detail-chat-content', () => ({ ChatContent: content }));
vi.mock('./workspace-chat-image-drop-zone', () => ({
  WorkspaceChatImageDropZone: ({ children }: { children: ReactNode }) => children,
}));

it.each([
  { positionReady: true, runtimeSessionId: 'session-1', ready: true },
  { positionReady: true, runtimeSessionId: 'previous-session', ready: false },
  { positionReady: true, runtimeSessionId: null, ready: false },
  { positionReady: false, runtimeSessionId: 'session-1', ready: false },
])(
  'readies the transcript only for stored positions and the selected session: %j',
  ({ positionReady, runtimeSessionId, ready }) => {
    session.runtimeSessionId = runtimeSessionId;
    const props = {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      issueAutoStart: false,
      active: true,
      position: { ready: positionReady, initialPosition: null, onPositionChange: () => undefined },
    } as unknown as WorkspaceChatProps;
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() => root.render(<WorkspaceChat {...props} />));
      expect(content.mock.lastCall?.[0].transcriptScroll).toMatchObject({
        identity: 'workspace-1/main/session-1',
        ready,
      });
    } finally {
      flushSync(() => root.unmount());
    }
  }
);

// @vitest-environment jsdom
import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useSessionManagement } from './use-workspace-detail';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ id: 'new' }),
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    session: {
      createAndStartSession: {
        useMutation: () => ({
          mutate: mocks.mutate,
          mutateAsync: mocks.mutateAsync,
          isPending: false,
        }),
      },
      deleteSession: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    workspace: {
      archive: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      openInIde: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      getAvailableIdes: { useQuery: () => ({}) },
    },
  },
}));

function SessionManagementHarness({
  onResult,
}: {
  onResult: (result: ReturnType<typeof useSessionManagement>) => void;
}) {
  onResult(
    useSessionManagement({
      workspaceId: 'workspace',
      slug: 'project',
      sessions: [],
      inputRef: createRef(),
      selectedDbSessionId: 'active-codex',
      setSelectedDbSessionId: vi.fn(),
      ...{ selectedModel: 'gpt-6-sol' },
      selectedProvider: 'CLAUDE',
      onArchiveGitIndexLocked: vi.fn(),
    })
  );
  return null;
}

describe('new session provider boundary', () => {
  it.each(['chat', 'quick action'])(
    'does not forward the active Codex model to a new Claude %s',
    async (kind) => {
      mocks.mutate.mockClear();
      mocks.mutateAsync.mockClear();
      let result: ReturnType<typeof useSessionManagement> | undefined;
      const root = createRoot(document.createElement('div'));
      try {
        flushSync(() =>
          root.render(
            createElement(SessionManagementHarness, {
              onResult: (next) => {
                result = next;
              },
            })
          )
        );
        if (kind === 'chat') {
          result?.handleNewChat();
          expect(mocks.mutate).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'CLAUDE', model: undefined }),
            expect.anything()
          );
        } else {
          await result?.handleQuickAction('Review', 'Review this');
          expect(mocks.mutateAsync).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'CLAUDE', model: undefined })
          );
        }
      } finally {
        flushSync(() => root.unmount());
      }
    }
  );
});

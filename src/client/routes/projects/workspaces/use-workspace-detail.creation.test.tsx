// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
      bulkArchive: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
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
      onArchiveGitIndexLocked: vi.fn(),
    })
  );
  return null;
}

describe('new session provider boundary', () => {
  it.each(['chat', 'quick action'])(
    'leaves provider and model to the workspace for a new %s without sessions',
    async (kind) => {
      mocks.mutate.mockClear();
      mocks.mutateAsync.mockClear();
      let result: ReturnType<typeof useSessionManagement> | undefined;
      const queryClient = new QueryClient();
      const root = createRoot(document.createElement('div'));
      try {
        flushSync(() =>
          root.render(
            createElement(
              QueryClientProvider,
              { client: queryClient },
              createElement(SessionManagementHarness, {
                onResult: (next) => {
                  result = next;
                },
              })
            )
          )
        );
        if (kind === 'chat') {
          result?.handleNewChat();
          expect(mocks.mutate).toHaveBeenCalledOnce();
          expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('provider');
          expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('model');
        } else {
          await result?.handleQuickAction('Review', 'Review this');
          expect(mocks.mutateAsync).toHaveBeenCalledOnce();
          expect(mocks.mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('provider');
          expect(mocks.mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('model');
        }
      } finally {
        flushSync(() => root.unmount());
        queryClient.clear();
      }
    }
  );
});

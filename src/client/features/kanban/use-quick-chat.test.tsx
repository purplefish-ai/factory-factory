// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuickChat } from './use-quick-chat';

const launchMocks = vi.hoisted(() => ({
  inputs: [] as unknown[],
}));

const sessionsByWorkspace = vi.hoisted(
  () =>
    new Map<
      string,
      | Array<{
          id: string;
          provider?: 'CLAUDE' | 'CODEX';
          model?: string;
          codexAccountId?: string | null;
        }>
      | undefined
    >()
);

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/client/features/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/features/chat')>()),
  useChatWebSocket: vi.fn(() => ({})),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      session: {
        listSessions: {
          cancel: vi.fn(),
          getData: vi.fn(),
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
      },
    }),
    session: {
      listSessions: {
        useQuery: ({ workspaceId }: { workspaceId: string }) => ({
          data: sessionsByWorkspace.get(workspaceId),
        }),
      },
      createAndStartSession: {
        useMutation: () => ({
          mutate: vi.fn(
            (
              input: { workspaceId: string; codexAccountId?: string },
              options?: { onSuccess?: (session: { id: string; codexAccountId?: string }) => void }
            ) => {
              launchMocks.inputs.push(input);
              options?.onSuccess?.({
                id: `created-for-${input.workspaceId}`,
                codexAccountId: input.codexAccountId,
              });
            }
          ),
          isPending: false,
        }),
      },
      deleteSession: {
        useMutation: () => ({
          mutate: vi.fn(),
        }),
      },
    },
  },
}));

vi.mock('@/hooks/use-auto-scroll', () => ({
  useAutoScroll: () => ({
    onScroll: vi.fn(),
    isNearBottom: true,
    scrollToBottom: vi.fn(),
  }),
}));

type QuickChatResult = ReturnType<typeof useQuickChat>;

interface HarnessProps {
  workspaceId: string | null;
  revision: number;
  onResult: (result: QuickChatResult) => void;
}

function Harness({ workspaceId, revision, onResult }: HarnessProps) {
  void revision;
  onResult(useQuickChat(workspaceId, 'CODEX'));
  return null;
}

interface RenderedHook {
  getResult: () => QuickChatResult;
  rerender: (workspaceId: string | null) => void;
}

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderHook(workspaceId: string | null): RenderedHook {
  const container = document.createElement('div');
  const root = createRoot(container);
  let result: QuickChatResult | undefined;
  let revision = 0;

  document.body.appendChild(container);
  mountedRoots.push({ container, root });

  const render = (nextWorkspaceId: string | null) => {
    revision += 1;
    flushSync(() => {
      root.render(
        createElement(Harness, {
          workspaceId: nextWorkspaceId,
          revision,
          onResult: (nextResult) => {
            result = nextResult;
          },
        })
      );
    });
  };

  render(workspaceId);

  return {
    getResult: () => {
      if (!result) {
        throw new Error('Expected the hook harness to expose a result');
      }
      return result;
    },
    rerender: render,
  };
}

beforeEach(() => {
  sessionsByWorkspace.clear();
  launchMocks.inputs.length = 0;
});

afterEach(() => {
  for (const { container, root } of mountedRoots.splice(0)) {
    flushSync(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
});

describe('useQuickChat session selection', () => {
  it.each([
    ['new chat', (result: QuickChatResult) => result.handleNewChat()],
    ['quick action', (result: QuickChatResult) => result.handleQuickAction('Review', 'Review it')],
  ])('keeps a session selected after a %s while the session list is stale', (_label, create) => {
    sessionsByWorkspace.set('workspace-a', []);
    const rendered = renderHook('workspace-a');

    flushSync(() => {
      create(rendered.getResult());
    });

    rendered.rerender('workspace-a');
    expect(rendered.getResult().selectedSessionId).toBe('created-for-workspace-a');
  });

  it('clears a stale session after the new workspace confirms it has no sessions', async () => {
    sessionsByWorkspace.set('workspace-a', [{ id: 'session-a' }]);
    const rendered = renderHook('workspace-a');

    await vi.waitFor(() => {
      expect(rendered.getResult().selectedSessionId).toBe('session-a');
    });

    rendered.rerender('workspace-b');
    expect(rendered.getResult().selectedSessionId).toBe('session-a');

    sessionsByWorkspace.set('workspace-b', []);
    rendered.rerender('workspace-b');

    await vi.waitFor(() => {
      expect(rendered.getResult().selectedSessionId).toBeNull();
    });
  });
});

it.each(['chat', 'quick action'])(
  "starts a new %s with the workspace's original provider and model",
  (kind) => {
    sessionsByWorkspace.set('workspace-a', [
      { id: 'first', provider: 'CODEX', model: 'gpt-sol' },
      { id: 'second', provider: 'CLAUDE', model: 'opus' },
    ]);
    const mounted = renderHook('workspace-a');
    flushSync(() => {
      if (kind === 'chat') {
        mounted.getResult().handleNewChat();
      } else {
        mounted.getResult().handleQuickAction('Review', 'Review this');
      }
    });
    expect(launchMocks.inputs).toEqual([
      expect.objectContaining({ workspaceId: 'workspace-a', provider: 'CODEX', model: 'gpt-sol' }),
    ]);
    expect(launchMocks.inputs[0]).not.toHaveProperty('reasoningEffort');
    expect(launchMocks.inputs[0]).not.toHaveProperty('planModeEnabled');
  }
);

it('retains a created account binding while the list is stale, then follows selection and refreshed data', () => {
  sessionsByWorkspace.set('workspace-a', [
    { id: 'old', provider: 'CODEX', codexAccountId: 'personal' },
  ]);
  const mounted = renderHook('workspace-a');
  flushSync(() => mounted.getResult().handleNewChat('work'));
  expect(mounted.getResult().selectedCodexAccountId).toBe('work');
  mounted.rerender('workspace-a');
  expect(mounted.getResult().selectedCodexAccountId).toBe('work');
  flushSync(() => mounted.getResult().setSelectedSessionId('old'));
  expect(mounted.getResult().selectedCodexAccountId).toBe('personal');
  sessionsByWorkspace.set('workspace-a', [
    { id: 'created-for-workspace-a', codexAccountId: 'work' },
  ]);
  flushSync(() => mounted.getResult().setSelectedSessionId('created-for-workspace-a'));
  mounted.rerender('workspace-a');
  expect(mounted.getResult().selectedCodexAccountId).toBe('work');
});

it('forwards the workspace provider and explicit account when no sessions remain', () => {
  sessionsByWorkspace.set('workspace-a', []);
  const mounted = renderHook('workspace-a');
  flushSync(() => mounted.getResult().handleNewChat('work'));
  expect(launchMocks.inputs).toEqual([
    expect.objectContaining({ provider: 'CODEX', codexAccountId: 'work' }),
  ]);
});

// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuickChat } from './use-quick-chat';

const launchMocks = vi.hoisted(() => ({
  inputs: [] as unknown[],
  workspace: { defaultSessionProvider: 'WORKSPACE_DEFAULT' } as
    | { defaultSessionProvider: string }
    | undefined,
  workspaceError: null as Error | null,
  refetchWorkspace: vi.fn().mockResolvedValue({}),
  settings: {
    defaultSessionProvider: 'CODEX',
    defaultClaudeModel: 'saved-sonnet',
    defaultCodexModel: 'saved-sol',
  },
}));

const sessionsByWorkspace = vi.hoisted(() => new Map<string, Array<{ id: string }> | undefined>());

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
    userSettings: {
      get: { useQuery: () => ({ data: launchMocks.settings }) },
      getProviderOptions: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    workspace: {
      get: {
        useQuery: () => ({
          data: launchMocks.workspace,
          error: launchMocks.workspaceError,
          refetch: launchMocks.refetchWorkspace,
        }),
      },
    },
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
              input: { workspaceId: string },
              options?: { onSuccess?: (session: { id: string }) => void }
            ) => {
              launchMocks.inputs.push(input);
              options?.onSuccess?.({ id: `created-for-${input.workspaceId}` });
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
  onResult(useQuickChat(workspaceId));
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
  launchMocks.workspace = { defaultSessionProvider: 'WORKSPACE_DEFAULT' };
  launchMocks.workspaceError = null;
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
  'uses independent saved and explicit provider models for a new %s',
  (kind) => {
    sessionsByWorkspace.set('workspace-a', [{ id: 'existing-codex' }]);
    const mounted = renderHook('workspace-a');
    const selection = () => mounted.getResult().launchSelection.pickerProps;
    flushSync(() => selection().onProviderChange?.('CLAUDE'));
    expect(mounted.getResult().launchSelection.model).toBe('saved-sonnet');
    flushSync(() => selection().onModelChange?.('chosen-opus'));
    flushSync(() => {
      if (kind === 'chat') {
        mounted.getResult().handleNewChat();
      } else {
        mounted.getResult().handleQuickAction('Review', 'Review this');
      }
    });
    expect(launchMocks.inputs).toEqual([
      expect.objectContaining({
        workspaceId: 'workspace-a',
        provider: 'CLAUDE',
        model: 'chosen-opus',
      }),
    ]);
    expect(mounted.getResult().launchSelection.provider).toBe('CODEX');
    expect(mounted.getResult().launchSelection.model).toBe('saved-sol');
  }
);

it('exposes workspace defaults failure with retry and recovers without reopening Quick Chat', () => {
  launchMocks.workspace = undefined;
  launchMocks.workspaceError = new Error('Workspace lookup failed');
  const mounted = renderHook('workspace-a');
  expect(mounted.getResult().launchSelection.loading).toBe(false);
  expect(mounted.getResult().launchSelection.ready).toBe(false);
  expect(mounted.getResult().launchSelection.error).toBe('Could not load workspace defaults');
  mounted.getResult().launchSelection.pickerProps.onRetry?.();
  expect(launchMocks.refetchWorkspace).toHaveBeenCalledOnce();
  launchMocks.workspaceError = null;
  launchMocks.workspace = { defaultSessionProvider: 'CLAUDE' };
  mounted.rerender('workspace-a');
  expect(mounted.getResult().launchSelection.ready).toBe(true);
  expect(mounted.getResult().launchSelection.creationDefaults).toEqual({
    provider: 'CLAUDE',
    model: 'saved-sonnet',
  });
});

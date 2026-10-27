// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuickChat } from '@/client/features/kanban/use-quick-chat';
import { trpc } from '@/client/lib/trpc';
import { useSessionManagement } from '@/client/routes/projects/workspaces/use-workspace-detail';
import { useSelectedSessionId } from '@/client/routes/projects/workspaces/use-workspace-detail-hooks';
import type { SessionProviderValue } from '@/lib/session-provider-selection';

vi.mock('@/client/features/chat/use-chat-websocket', () => ({ useChatWebSocket: () => ({}) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

type Surface = 'full' | 'quick';
interface Commands {
  selected: string | null;
  newChat: () => void;
  quickAction: () => void | Promise<void>;
  close: (id: string) => void;
  select: (id: string) => void;
  pending: boolean;
}
const roots: Root[] = [];
const clients: QueryClient[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  clients.splice(0).forEach((client) => client.clear());
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function readWorkspaceId(input: unknown): string {
  return typeof input === 'object' && input && 'workspaceId' in input
    ? String(input.workspaceId)
    : '';
}

interface SurfaceProps {
  workspaceId: string;
  provider: SessionProviderValue;
  onResult: (commands: Commands) => void;
}
function Full({ workspaceId, provider, onResult }: SurfaceProps) {
  const { data: sessions } = trpc.session.listSessions.useQuery({ workspaceId });
  const { selectedDbSessionId, setSelectedDbSessionId } = useSelectedSessionId(
    workspaceId,
    sessions?.[0]?.id ?? null,
    (sessions ?? []).map((s) => s.id)
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const management = useSessionManagement({
    workspaceId,
    slug: 'project',
    sessions,
    inputRef,
    selectedDbSessionId,
    setSelectedDbSessionId,
    selectedModel: 'claude-model',
    selectedProvider: provider,
    onArchiveGitIndexLocked: vi.fn(),
  });
  onResult({
    selected: selectedDbSessionId,
    newChat: management.handleNewChat,
    quickAction: () => management.handleQuickAction('Review', 'Review prompt'),
    close: management.handleCloseSession,
    select: management.handleSelectSession,
    pending: management.createSession.isPending,
  });
  return <textarea ref={inputRef} />;
}
function Quick({ workspaceId, onResult }: SurfaceProps) {
  const chat = useQuickChat(workspaceId);
  onResult({
    selected: chat.selectedSessionId,
    newChat: chat.handleNewChat,
    quickAction: () => chat.handleQuickAction('Review', 'Review prompt'),
    close: chat.handleCloseSession,
    select: chat.setSelectedSessionId,
    pending: chat.isCreatingSession,
  });
  return null;
}

function renderSurface(surface: Surface, provider: SessionProviderValue = 'CLAUDE') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  const rosters = new Map([
    [
      'a',
      [
        { id: 'a1', name: 'Chat 2' },
        { id: 'a2', name: 'Chat 7' },
      ],
    ],
    ['b', [{ id: 'b1', name: 'Other' }]],
  ]);
  const requests: Array<{ path: string; input: unknown }> = [];
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            const respond = (data: unknown) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            if (op.type === 'mutation') {
              pending.push({
                resolve: respond,
                reject: (error) => observer.error(TRPCClientError.from(error)),
              });
            } else if (op.path === 'session.listSessions') {
              const workspaceId = readWorkspaceId(op.input);
              respond(rosters.get(workspaceId) ?? []);
            } else {
              respond({ ides: [], preferredIde: 'cursor' });
            }
          }),
    ],
  });
  let result: Commands | undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const SurfaceComponent = surface === 'full' ? Full : Quick;
  const render = (workspaceId: string) =>
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <trpc.Provider client={client} queryClient={queryClient}>
            <MemoryRouter>
              <SurfaceComponent
                workspaceId={workspaceId}
                provider={provider}
                onResult={(commands) => {
                  result = commands;
                }}
              />
            </MemoryRouter>
          </trpc.Provider>
        </QueryClientProvider>
      )
    );
  render('a');
  return {
    get: () => {
      if (!result) {
        throw new Error('Missing surface result');
      }
      return result;
    },
    render,
    requests,
    pending,
    queryClient,
    rosters,
    cache: (workspaceId: string) =>
      queryClient.getQueryData(getQueryKey(trpc.session.listSessions, { workspaceId }, 'query')),
    setRoster: (workspaceId: string, value: Array<{ id: string; name: string }>) => {
      rosters.set(workspaceId, value);
      queryClient.setQueryData(
        getQueryKey(trpc.session.listSessions, { workspaceId }, 'query'),
        value
      );
    },
  };
}

describe.each<Surface>(['full', 'quick'])('%s chat session collection', (surface) => {
  it.each(['chat', 'action'])(
    'keeps a late %s completion in its originating workspace',
    async (kind) => {
      const view = renderSurface(surface);
      await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
      const operation = kind === 'chat' ? view.get().newChat() : view.get().quickAction();
      await vi.waitFor(() => expect(view.pending).toHaveLength(1));
      view.render('b');
      await vi.waitFor(() => expect(view.get().selected).toBe('b1'));
      view.pending[0]?.resolve({ id: 'created-a' });
      await operation;
      await vi.waitFor(() =>
        expect(
          view.queryClient.getQueryState(
            getQueryKey(trpc.session.listSessions, { workspaceId: 'a' }, 'query')
          )?.isInvalidated
        ).toBe(true)
      );
      expect(view.get().selected).toBe('b1');
      expect(localStorage.getItem('workspace-selected-session-a')).not.toBe('created-a');
      expect(view.requests.filter((r) => r.path === 'session.createAndStartSession')).toHaveLength(
        1
      );
    }
  );

  it.each(['chat', 'action'])(
    'preserves defaults, naming, prompt scheduling and loading for a %s',
    async (kind) => {
      const view = renderSurface(surface);
      await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
      const operation = kind === 'chat' ? view.get().newChat() : view.get().quickAction();
      await vi.waitFor(() => expect(view.get().pending).toBe(true));
      expect(view.requests.filter((r) => r.path === 'session.createAndStartSession')).toEqual([
        {
          path: 'session.createAndStartSession',
          input: {
            workspaceId: 'a',
            workflow: 'followup',
            initialPrompt: '',
            ...(surface === 'full' ? { provider: 'CLAUDE', model: 'claude-model' } : { model: '' }),
            ...(kind === 'chat'
              ? { name: 'Chat 8' }
              : { name: 'Review', initialMessage: 'Review prompt' }),
          },
        },
      ]);
      view.pending[0]?.resolve({ id: 'created-a' });
      await operation;
      await vi.waitFor(() => expect(view.get().selected).toBe('created-a'));
      await vi.waitFor(() => expect(view.get().pending).toBe(false));
      expect(localStorage.getItem('workspace-selected-session-a')).toBe(
        surface === 'full' ? 'created-a' : null
      );
      if (surface === 'full' && kind === 'chat') {
        await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('TEXTAREA'));
      } else {
        expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
      }
    }
  );

  it.each(['chat', 'action'])(
    'reports a failed %s once without changing selection or retrying creation',
    async (kind) => {
      const view = renderSurface(surface);
      await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
      const operation = kind === 'chat' ? view.get().newChat() : view.get().quickAction();
      await vi.waitFor(() => expect(view.pending).toHaveLength(1));
      view.pending[0]?.reject(new Error('Provider unavailable'));
      await operation;
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledExactlyOnceWith('Provider unavailable')
      );
      expect(view.get().selected).toBe('a1');
      expect(view.requests.filter((r) => r.path === 'session.createAndStartSession')).toHaveLength(
        1
      );
      expect(view.cache('a')).toEqual([
        { id: 'a1', name: 'Chat 2' },
        { id: 'a2', name: 'Chat 7' },
      ]);
    }
  );

  it('keeps the surface-specific pending selection fallback while the roster is delayed', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const view = renderSurface(surface);
    await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    view.get().newChat();
    await vi.waitFor(() => expect(view.pending).toHaveLength(1));
    view.pending[0]?.resolve({ id: 'created-a' });
    await vi.waitFor(() => expect(view.get().selected).toBe('created-a'));
    clock.mockReturnValue(7000);
    view.render('a');
    await vi.waitFor(() =>
      expect(view.get().selected).toBe(surface === 'full' ? 'a1' : 'created-a')
    );
    if (surface === 'quick') {
      view.setRoster('a', [{ id: 'created-a', name: 'Chat 8' }]);
      await vi.waitFor(() =>
        expect(view.cache('a')).toEqual([{ id: 'created-a', name: 'Chat 8' }])
      );
      view.render('a');
      // Once confirmed by the roster, the pending exception no longer applies.
      view.setRoster('a', [{ id: 'a1', name: 'Chat 2' }]);
      await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    }
  });

  it('issues one request per rapid command while the roster stays stale', async () => {
    const view = renderSurface(surface);
    await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    view.get().newChat();
    view.get().newChat();
    await vi.waitFor(() => expect(view.pending).toHaveLength(2));
    view.pending[0]?.resolve({ id: 'first' });
    view.pending[1]?.resolve({ id: 'second' });
    await vi.waitFor(() => expect(view.get().selected).toBe('second'));
    expect(view.requests.filter((r) => r.path === 'session.createAndStartSession')).toHaveLength(2);
  });

  it('keeps selection when another tab closes and ignores unknown tabs', async () => {
    const view = renderSurface(surface);
    await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    view.get().close('unknown');
    view.get().close('a2');
    await vi.waitFor(() => expect(view.pending).toHaveLength(1));
    expect(view.get().selected).toBe('a1');
    view.rosters.set('a', [{ id: 'a1', name: 'Chat 2' }]);
    view.pending[0]?.resolve({ success: true });
    await vi.waitFor(() => expect(view.queryClient.isMutating()).toBe(0));
    await vi.waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    expect(
      view.requests.filter(
        (request) =>
          request.path === 'session.listSessions' && readWorkspaceId(request.input) === 'a'
      )
    ).toHaveLength(2);
    await vi.waitFor(() => expect(view.cache('a')).toEqual([{ id: 'a1', name: 'Chat 2' }]));
    view.render('a');
    view.get().close('a1');
    await vi.waitFor(() => expect(view.get().selected).toBeNull());
    expect(view.requests.filter((r) => r.path === 'session.deleteSession')).toHaveLength(2);
  });

  it('selects the previous tab when the selected last tab closes', async () => {
    const view = renderSurface(surface);
    await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    flushSync(() => view.get().select('a2'));
    view.get().close('a2');
    await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    await vi.waitFor(() => expect(view.pending).toHaveLength(1));
    expect(view.requests.filter((request) => request.path === 'session.deleteSession')).toEqual([
      { path: 'session.deleteSession', input: { id: 'a2' } },
    ]);
  });

  it('rolls back a failed delete in the originating cache after navigation', async () => {
    const view = renderSurface(surface);
    await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
    view.get().close('a1');
    await vi.waitFor(() => expect(view.cache('a')).toEqual([{ id: 'a2', name: 'Chat 7' }]));
    expect(view.get().selected).toBe('a2');
    view.render('b');
    await vi.waitFor(() => expect(view.get().selected).toBe('b1'));
    view.pending[0]?.reject(new Error('Delete failed'));
    await vi.waitFor(() =>
      expect(view.cache('a')).toEqual([
        { id: 'a1', name: 'Chat 2' },
        { id: 'a2', name: 'Chat 7' },
      ])
    );
    await vi.waitFor(() =>
      expect(
        view.queryClient.getQueryState(
          getQueryKey(trpc.session.listSessions, { workspaceId: 'a' }, 'query')
        )?.isInvalidated
      ).toBe(true)
    );
    expect(
      view.queryClient.getQueryState(
        getQueryKey(trpc.session.listSessions, { workspaceId: 'b' }, 'query')
      )?.isInvalidated
    ).toBe(false);
    expect(view.cache('b')).toEqual([{ id: 'b1', name: 'Other' }]);
    expect(view.get().selected).toBe('b1');
    expect(view.requests.filter((r) => r.path === 'session.deleteSession')).toEqual([
      { path: 'session.deleteSession', input: { id: 'a1' } },
    ]);
  });
});

it('uses Codex model defaults for both full-chat commands', async () => {
  const view = renderSurface('full', 'CODEX');
  await vi.waitFor(() => expect(view.get().selected).toBe('a1'));
  view.get().newChat();
  const action = view.get().quickAction();
  await vi.waitFor(() => expect(view.pending).toHaveLength(2));
  expect(view.requests.filter((r) => r.path === 'session.createAndStartSession')).toEqual([
    {
      path: 'session.createAndStartSession',
      input: {
        workspaceId: 'a',
        workflow: 'followup',
        name: 'Chat 8',
        provider: 'CODEX',
        model: undefined,
        initialPrompt: '',
      },
    },
    {
      path: 'session.createAndStartSession',
      input: {
        workspaceId: 'a',
        workflow: 'followup',
        name: 'Review',
        provider: 'CODEX',
        model: undefined,
        initialPrompt: '',
        initialMessage: 'Review prompt',
      },
    },
  ]);
  view.pending[0]?.resolve({ id: 'first' });
  view.pending[1]?.resolve({ id: 'second' });
  await action;
});

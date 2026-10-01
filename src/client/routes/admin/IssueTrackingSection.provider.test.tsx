// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core/enums';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Keep the real mutation/query lifecycle; native selects allow same-tick racing choices.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) =>
    createElement(
      'select',
      {
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
      },
      children
    ),
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) =>
    createElement('option', { value }, children),
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let serverProvider: IssueProvider;
let deferLists: boolean;
let failLists: boolean;
let listReads: number;
const saves: Array<{ input: unknown; succeed: () => void; fail: () => void }> = [];
const lists: Array<() => void> = [];

function Card() {
  const { data } = trpc.project.list.useQuery();
  if (!data) {
    return null;
  }
  return createElement(ProjectIssueTrackingCard, {
    projectId: 'project-1',
    projectName: 'Alpha',
    currentProvider: data[0]!.issueProvider,
    issueTrackerConfig: {
      linear: {
        hasApiKey: true,
        teamId: 'mock-team',
        teamName: 'Mock team',
        viewerName: 'Mock viewer',
      },
    },
  });
}

async function mount(initial: IssueProvider) {
  serverProvider = initial;
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'project.list') {
              listReads += 1;
              const provider = serverProvider;
              const finish = () => {
                if (failLists) {
                  observer.error(new TRPCClientError('Mock refetch failed'));
                  return;
                }
                observer.next({ result: { data: [{ id: 'project-1', issueProvider: provider }] } });
                observer.complete();
              };
              if (deferLists) {
                lists.push(finish);
              } else {
                finish();
              }
            } else if (op.path === 'project.update') {
              saves.push({
                input: op.input,
                succeed: () => {
                  observer.next({
                    result: { data: { id: 'project-1', issueProvider: serverProvider } },
                  });
                  observer.complete();
                },
                fail: () => observer.error(new TRPCClientError('Mock save failed')),
              });
            } else {
              observer.error(new TRPCClientError(`Unexpected operation: ${op.path}`));
            }
          }),
    ],
  });
  act(() => {
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Card />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await tick();
}

async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function choose(provider: IssueProvider) {
  const select = container.querySelector('select');
  expect(select).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
      select,
      provider
    );
    select?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function expectProvider(provider: IssueProvider) {
  expect(container.querySelector('select')?.value).toBe(provider);
  expect(container.querySelector('input[type="password"]') !== null).toBe(
    provider === IssueProvider.LINEAR
  );
  expect(container.querySelector('[data-slot="badge"]')?.textContent).toBe(
    provider === IssueProvider.LINEAR ? 'Linear' : 'GitHub'
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saves.length = 0;
  lists.length = 0;
  deferLists = false;
  failLists = false;
  listReads = 0;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('issue provider selection', () => {
  it.each([IssueProvider.GITHUB, IssueProvider.LINEAR])(
    'rolls back a failed save from %s and refetches',
    async (initial) => {
      await mount(initial);
      const next = initial === IssueProvider.GITHUB ? IssueProvider.LINEAR : IssueProvider.GITHUB;
      choose(next);
      expectProvider(next);
      await tick();
      expect(saves[0]?.input).toEqual({ id: 'project-1', issueProvider: next });
      await act(async () => saves[0]!.fail());
      await tick();
      expectProvider(initial);
      expect(listReads).toBe(2);
      expect(toast.error).toHaveBeenCalledWith('Failed to save: Mock save failed');
    }
  );

  it('resyncs an idle selector when the same project refetch changes its provider', async () => {
    await mount(IssueProvider.GITHUB);
    serverProvider = IssueProvider.LINEAR;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await tick();
    expectProvider(IssueProvider.LINEAR);
  });

  it('retains the confirmed saved provider if reconciliation fails, then follows a later refetch', async () => {
    await mount(IssueProvider.GITHUB);
    choose(IssueProvider.LINEAR);
    await tick();
    serverProvider = IssueProvider.LINEAR;
    failLists = true;
    await act(async () => saves[0]!.succeed());
    await tick();
    expectProvider(IssueProvider.LINEAR);
    expect(listReads).toBe(2);
    failLists = false;
    serverProvider = IssueProvider.GITHUB;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await tick();
    expectProvider(IssueProvider.GITHUB);
  });

  it('rolls a newer failed save back to an earlier confirmed save', async () => {
    await mount(IssueProvider.GITHUB);
    choose(IssueProvider.LINEAR);
    choose(IssueProvider.GITHUB);
    await tick();
    serverProvider = IssueProvider.LINEAR;
    await act(async () => saves[0]!.succeed());
    await tick();
    expectProvider(IssueProvider.GITHUB);
    failLists = true;
    await act(async () => saves[1]!.fail());
    await tick();
    expectProvider(IssueProvider.LINEAR);
  });

  it('uses the latest server provider when rolling back during a save', async () => {
    await mount(IssueProvider.GITHUB);
    choose(IssueProvider.LINEAR);
    await tick();
    serverProvider = IssueProvider.LINEAR;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await tick();
    await act(async () => saves[0]!.fail());
    await tick();
    expectProvider(IssueProvider.LINEAR);
  });

  it.each(['failure', 'success'])(
    'does not let an older %s overwrite a later pending choice',
    async (outcome) => {
      await mount(IssueProvider.GITHUB);
      choose(IssueProvider.LINEAR);
      choose(IssueProvider.GITHUB);
      await tick();
      if (outcome === 'success') {
        serverProvider = IssueProvider.LINEAR;
      }
      await act(async () => (outcome === 'success' ? saves[0]!.succeed() : saves[0]!.fail()));
      await tick();
      expectProvider(IssueProvider.GITHUB);
      serverProvider = IssueProvider.GITHUB;
      await act(async () => saves[1]!.succeed());
      await tick();
      expectProvider(IssueProvider.GITHUB);
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it('refetches after all racing saves settle even when the older request finishes last', async () => {
    await mount(IssueProvider.GITHUB);
    choose(IssueProvider.LINEAR);
    choose(IssueProvider.GITHUB);
    await tick();
    await act(async () => saves[1]!.succeed());
    await tick();
    expectProvider(IssueProvider.GITHUB);
    serverProvider = IssueProvider.LINEAR;
    await act(async () => saves[0]!.succeed());
    await tick();
    expectProvider(IssueProvider.LINEAR);
  });

  it('keeps a newer choice while an older save refetch completes', async () => {
    await mount(IssueProvider.GITHUB);
    choose(IssueProvider.LINEAR);
    await tick();
    serverProvider = IssueProvider.LINEAR;
    deferLists = true;
    await act(async () => saves[0]!.succeed());
    await tick();
    expectProvider(IssueProvider.LINEAR);
    choose(IssueProvider.GITHUB);
    await tick();
    await act(async () => lists[0]!());
    await tick();
    expectProvider(IssueProvider.GITHUB);
    deferLists = false;
    serverProvider = IssueProvider.GITHUB;
    await act(async () => saves[1]!.succeed());
    await tick();
    expectProvider(IssueProvider.GITHUB);
  });
});

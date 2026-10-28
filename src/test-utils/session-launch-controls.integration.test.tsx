// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useSessionCollectionCommands } from '@/client/features/chat';
import { InlineWorkspaceForm } from '@/client/features/kanban/inline-workspace-form';
import { SessionLaunchControls } from '@/client/features/session-selection';
import { useSessionLaunchSelection } from '@/client/features/session-selection';
import { trpc } from '@/client/lib/trpc';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ChatProvider } from '@/shared/chat-capabilities';
import type { SessionLaunchOptions } from '@/shared/session-launch';

const inputSchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  model: z.string().optional(),
});
const roots: Root[] = [];
const clients: QueryClient[] = [];
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(() => root.unmount());
  }
  clients.splice(0).forEach((client) => client.clear());
  document.body.innerHTML = '';
});
function NativeLaunchHarness() {
  const selection = useSessionLaunchSelection('workspace');
  const commands = useSessionCollectionCommands({
    workspaceId: 'workspace',
    sessions: [],
    creationDefaults: selection.creationDefaults,
    canCreate: selection.ready,
    unavailableReason: selection.unavailableReason,
    onCreated: selection.reset,
  });
  return (
    <>
      <SessionLaunchControls {...selection.controlsProps} />
      <button
        type="button"
        disabled={!selection.ready}
        title={selection.unavailableReason}
        onClick={commands.createChat}
      >
        Create chat
      </button>
      <button
        type="button"
        disabled={!selection.ready}
        onClick={() => commands.createQuickAction('Review', 'Review this')}
      >
        Quick action
      </button>
    </>
  );
}
function fixture(provider: ChatProvider, model: string): SessionLaunchOptions {
  const levels =
    provider === 'CLAUDE'
      ? ['default', 'high', 'max']
      : model === 'luna'
        ? ['low', 'high']
        : ['low', 'high', 'ultra'];
  return {
    provider,
    model: `confirmed-${model}`,
    reasoning: {
      options: levels.map((value) => ({
        value,
        label: value.slice(0, 1).toUpperCase() + value.slice(1),
      })),
      selected: provider === 'CLAUDE' ? 'default' : 'high',
      defaultValue: provider === 'CLAUDE' ? 'default' : 'low',
    },
    planMode: { supported: true, selected: false },
  };
}
interface ProbeFixtures {
  failed: Set<string>;
  deferred: Set<string>;
  pending: Map<string, (value: SessionLaunchOptions) => void>;
  settings: {
    defaultCodexReasoningEffort: string | null;
    defaultClaudeReasoningEffort: string | null;
  };
}
function respondToProbe(
  raw: unknown,
  state: ProbeFixtures,
  respond: (data: unknown) => void,
  reject: (error: Error) => void
) {
  const input = inputSchema.parse(raw);
  const key = `${input.provider}:${input.model}`;
  if (state.failed.has(key)) {
    reject(new Error('Native discovery failed'));
    return;
  }
  if (state.deferred.has(key)) {
    state.pending.set(key, respond);
    return;
  }
  const value = fixture(input.provider, input.model ?? 'default');
  const saved =
    input.provider === 'CODEX'
      ? state.settings.defaultCodexReasoningEffort
      : state.settings.defaultClaudeReasoningEffort;
  if (saved && value.reasoning.options.some((option) => option.value === saved)) {
    value.reasoning.selected = saved;
  }
  respond(value);
}

function renderLaunch(inline = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  const requests: Array<{ path: string; input: unknown }> = [];
  const pending = new Map<string, (value: SessionLaunchOptions) => void>();
  const deferred = new Set<string>();
  const failed = new Set<string>();
  const settings = {
    defaultSessionProvider: 'CODEX',
    defaultCodexModel: 'sol',
    defaultClaudeModel: 'sonnet',
    defaultCodexReasoningEffort: 'high' as string | null,
    defaultClaudeReasoningEffort: null,
    ratchetEnabled: false,
  };
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
            if (op.path === 'session.getLaunchOptions') {
              respondToProbe(op.input, { failed, deferred, pending, settings }, respond, (error) =>
                observer.error(TRPCClientError.from(error))
              );
              return;
            }
            const responses: Record<string, unknown> = {
              'userSettings.get': settings,
              'userSettings.getProviderOptions': {
                CODEX: {
                  models: [
                    { value: 'sol', label: '6 Sol' },
                    { value: 'luna', label: '6 Luna' },
                    { value: 'slow', label: 'Slow model' },
                  ],
                },
                CLAUDE: { models: [{ value: 'sonnet', label: 'Sonnet' }] },
              },
              'session.createAndStartSession': { id: 'created' },
              'project.listSlashCommands': { commands: [] },
              'project.listAllFiles': { files: [] },
              'workspace.listForProject': { workspaces: [], reviewCount: 0 },
              'workspace.create': {
                id: 'created-workspace',
                projectId: 'project',
                name: 'Created',
                status: 'NEW',
                createdAt: new Date(),
                mode: 'STANDARD',
                ratchetEnabled: false,
              },
            };
            respond(responses[op.path] ?? {});
          }),
    ],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const child: ReactNode = inline ? (
    <InlineWorkspaceForm
      projectId="project"
      existingNames={[]}
      onCreated={vi.fn()}
      onCancel={vi.fn()}
    />
  ) : (
    <NativeLaunchHarness />
  );
  const render = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <trpc.Provider client={client} queryClient={queryClient}>
            <TooltipProvider>{child}</TooltipProvider>
          </trpc.Provider>
        </QueryClientProvider>
      )
    );
  return { container, requests, pending, deferred, failed, queryClient, settings, render };
}
function button(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label
  );
}
async function open(label: string) {
  const trigger = button(label);
  expect(trigger).toBeDefined();
  await act(() =>
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
  );
}
async function choose(label: string) {
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent === label
  );
  expect(item).toBeDefined();
  await act(() => {
    item?.focus();
    item?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });
}
async function ready() {
  await vi.waitFor(() => expect(button('Create chat')?.disabled).toBe(false));
}

describe('real launch controls and tRPC payloads', () => {
  it.each([
    { provider: 'CODEX', effort: 'Ultra', raw: 'ultra' },
    { provider: 'CLAUDE', effort: 'Max', raw: 'max' },
  ] as const)(
    'submits selected thinking and Plan for $provider new chats and quick actions',
    async ({ provider, effort, raw }) => {
      const view = renderLaunch();
      await view.render();
      await ready();
      if (provider === 'CLAUDE') {
        await open('New conversation provider and model: Codex · 6 Sol');
        await choose('Claude');
        await ready();
      }
      await open(provider === 'CLAUDE' ? 'Thinking level: Default' : 'Thinking level: High');
      await choose(effort);
      await act(() => button('Plan mode')?.click());
      await act(() => button('Quick action')?.click());
      await vi.waitFor(() =>
        expect(
          view.requests.some((request) => request.path === 'session.createAndStartSession')
        ).toBe(true)
      );
      expect(
        view.requests
          .filter((request) => request.path === 'session.createAndStartSession')
          .map((request) => request.input)
      ).toEqual([
        expect.objectContaining({
          provider,
          model: provider === 'CLAUDE' ? 'sonnet' : 'sol',
          reasoningEffort: raw,
          planModeEnabled: true,
        }),
      ]);
      await ready();
      expect(button('Thinking level: High')).toBeDefined();
      await act(() => button('Create chat')?.click());
      await vi.waitFor(() =>
        expect(
          view.requests.filter((request) => request.path === 'session.createAndStartSession')
        ).toHaveLength(2)
      );
      expect(
        view.requests.filter((request) => request.path === 'session.createAndStartSession')[1]
          ?.input
      ).toMatchObject({
        provider: 'CODEX',
        model: 'sol',
        reasoningEffort: 'high',
        planModeEnabled: false,
      });
    }
  );
  it('keeps the visible inherited level stable through saved-default and native-query refetches', async () => {
    const view = renderLaunch();
    await view.render();
    await ready();
    await act(() => {
      view.settings.defaultCodexReasoningEffort = 'low';
      view.queryClient.setQueryData(getQueryKey(trpc.userSettings.get, undefined, 'query'), {
        ...view.settings,
      });
    });
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: getQueryKey(
          trpc.session.getLaunchOptions,
          { provider: 'CODEX', model: 'sol' },
          'query'
        ),
      });
    });
    expect(button('Thinking level: High')).toBeDefined();
    await act(() => button('Create chat')?.click());
    await vi.waitFor(() =>
      expect(
        view.requests.some((request) => request.path === 'session.createAndStartSession')
      ).toBe(true)
    );
    expect(
      view.requests.find((request) => request.path === 'session.createAndStartSession')?.input
    ).toMatchObject({ reasoningEffort: 'high', planModeEnabled: false });
  });
  it('submits saved Default as null rather than pinning the concrete native default', async () => {
    const view = renderLaunch();
    view.settings.defaultCodexReasoningEffort = null;
    await view.render();
    await ready();
    expect(button('Thinking level: Default')).toBeDefined();
    await act(() => button('Create chat')?.click());
    await vi.waitFor(() =>
      expect(
        view.requests.some((request) => request.path === 'session.createAndStartSession')
      ).toBe(true)
    );
    expect(
      view.requests.find((request) => request.path === 'session.createAndStartSession')?.input
    ).toMatchObject({ provider: 'CODEX', reasoningEffort: null, planModeEnabled: false });
  });
  it('keeps Ultra visible but blocks an incompatible model until Default is selected', async () => {
    const view = renderLaunch();
    await view.render();
    await ready();
    await open('Thinking level: High');
    await choose('Ultra');
    await open('New conversation provider and model: Codex · 6 Sol');
    await choose('6 Luna');
    await vi.waitFor(() =>
      expect(button('Thinking level: ultra')?.getAttribute('aria-invalid')).toBe('true')
    );
    expect(button('Create chat')?.disabled).toBe(true);
    expect(button('Create chat')?.title).toContain('Choose a supported thinking');
    await open('New conversation provider and model: Codex · 6 Luna');
    await choose('Claude');
    await ready();
    await open('New conversation provider and model: Claude · Sonnet');
    await choose('Codex');
    await vi.waitFor(() =>
      expect(button('Thinking level: ultra')?.getAttribute('aria-invalid')).toBe('true')
    );
    await open('Thinking level: ultra');
    await choose('Default');
    await ready();
    await act(() => button('Create chat')?.click());
    await vi.waitFor(() =>
      expect(
        view.requests.some((request) => request.path === 'session.createAndStartSession')
      ).toBe(true)
    );
    expect(
      view.requests.find((request) => request.path === 'session.createAndStartSession')?.input
    ).toMatchObject({
      provider: 'CODEX',
      model: 'luna',
      reasoningEffort: null,
      planModeEnabled: false,
    });
  });
  it('ignores a delayed previous-model discovery after switching providers', async () => {
    const view = renderLaunch();
    view.deferred.add('CODEX:slow');
    await view.render();
    await ready();
    await open('New conversation provider and model: Codex · 6 Sol');
    await choose('Slow model');
    await vi.waitFor(() => expect(view.pending.has('CODEX:slow')).toBe(true));
    expect(button('Create chat')?.disabled).toBe(true);
    await open('New conversation provider and model: Codex · Slow model');
    await choose('Claude');
    await ready();
    await act(() => view.pending.get('CODEX:slow')?.(fixture('CODEX', 'slow')));
    expect(button('New conversation provider and model: Claude · Sonnet')).toBeDefined();
    expect(button('Thinking level: Default')).toBeDefined();
  });
  it('retries failed native discovery without freezing provider/model selection', async () => {
    const view = renderLaunch();
    view.failed.add('CODEX:luna');
    await view.render();
    await ready();
    await open('New conversation provider and model: Codex · 6 Sol');
    await choose('6 Luna');
    await vi.waitFor(() => expect(button('Thinking level: Unavailable')).toBeDefined());
    expect(button('Create chat')?.disabled).toBe(true);
    expect(button('New conversation provider and model: Codex · 6 Luna')?.disabled).toBe(false);
    await open('Thinking level: Unavailable');
    const retry = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Retry thinking options'
    );
    view.failed.delete('CODEX:luna');
    await act(() => retry?.click());
    await ready();
    expect(
      view.requests.filter(
        (request) =>
          request.path === 'session.getLaunchOptions' &&
          JSON.stringify(request.input).includes('luna')
      )
    ).toHaveLength(2);
  });
  it('sends the selected thinking and Plan from the actual inline workspace composer', async () => {
    const view = renderLaunch(true);
    await view.render();
    await vi.waitFor(() => expect(button('Launch')?.disabled).toBe(false));
    await open('Thinking level: High');
    await choose('Ultra');
    await act(() => button('Plan mode')?.click());
    await act(() => button('Launch')?.click());
    await vi.waitFor(() =>
      expect(view.requests.some((request) => request.path === 'workspace.create')).toBe(true)
    );
    expect(
      view.requests.find((request) => request.path === 'workspace.create')?.input
    ).toMatchObject({
      type: 'MANUAL',
      provider: 'CODEX',
      model: 'sol',
      reasoningEffort: 'ultra',
      planModeEnabled: true,
    });
  });
});

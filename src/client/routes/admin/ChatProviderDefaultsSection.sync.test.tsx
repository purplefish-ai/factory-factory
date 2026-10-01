// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, Children, type ComponentProps, createElement, isValidElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { ChatProviderDefaultsSection } from './ChatProviderDefaultsSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/components/provider-cli-warning', () => ({ ProviderCliWarning: () => null }));

const selectionHandlers = vi.hoisted(() => new Map<string, (value: string) => void>());
vi.mock('@/components/ui/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>();
  return {
    ...actual,
    Select: (props: ComponentProps<typeof actual.Select>) => {
      for (const child of Children.toArray(props.children)) {
        if (isValidElement<{ id?: string }>(child) && child.props.id && props.onValueChange) {
          selectionHandlers.set(child.props.id, props.onValueChange);
        }
      }
      return createElement(actual.Select, props);
    },
  };
});

const initialSettings = {
  defaultSessionProvider: 'CLAUDE',
  defaultClaudeModel: 'sonnet',
  defaultCodexModel: 'default',
  defaultClaudeReasoningEffort: null,
  defaultCodexReasoningEffort: null,
  defaultWorkspacePermissions: 'STRICT',
};
type Settings = typeof initialSettings;
type Request = {
  input: unknown;
  resolve: (settings: Settings) => void;
  reject: () => void;
};
let root: Root;
let queryClient: QueryClient;
let container: HTMLDivElement;
let reads: Request[];
let saves: Request[];
let invalidate: () => Promise<void>;

async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    check();
  });
}

async function select(id: string, label: string) {
  const trigger = container.querySelector<HTMLElement>(`#${id}`);
  await act(async () => trigger?.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (element) => element.textContent === label
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());
}

function label(id: string) {
  return container.querySelector(`#${id}`)?.textContent;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  selectionHandlers.clear();
  reads = [];
  saves = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'userSettings.getProviderOptions') {
              observer.next({
                result: {
                  data: {
                    CLAUDE: {
                      models: [
                        { value: 'sonnet', label: 'Sonnet' },
                        { value: 'opus', label: 'Opus' },
                        { value: 'fable', label: 'Fable' },
                      ],
                    },
                    CODEX: {
                      models: [
                        { value: 'default', label: 'Default' },
                        { value: 'gpt-a', label: 'Codex A' },
                        { value: 'gpt-b', label: 'Codex B' },
                      ],
                    },
                  },
                },
              });
              observer.complete();
              return;
            }
            const request: Request = {
              input: op.input,
              resolve: (settings) => {
                observer.next({ result: { data: settings } });
                observer.complete();
              },
              reject: () => observer.error(new TRPCClientError('Save rejected')),
            };
            (op.type === 'mutation' ? saves : reads).push(request);
          }),
    ],
  });
  function Settings() {
    const utils = trpc.useUtils();
    invalidate = () => utils.userSettings.get.invalidate();
    return createElement(ChatProviderDefaultsSection);
  }
  await act(() => {
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Settings />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await act(async () => reads[0]?.resolve(initialSettings));
  await waitFor(() => expect(label('default-claude-model')).toBe('Sonnet'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
});

describe('chat model synchronization', () => {
  it.each([
    { id: 'default-claude-model', field: 'defaultClaudeModel', value: 'opus', selected: 'Opus' },
    { id: 'default-codex-model', field: 'defaultCodexModel', value: 'gpt-a', selected: 'Codex A' },
  ])(
    'keeps $id pending until its save refetch finishes',
    async ({ id, field, value, selected }) => {
      await select(id, selected);
      await waitFor(() => expect(saves).toHaveLength(1));
      await act(async () => saves[0]?.resolve({ ...initialSettings, [field]: value }));
      await waitFor(() => expect(reads).toHaveLength(2));
      expect(container.querySelector(`#${id}`)?.hasAttribute('disabled')).toBe(true);
      expect(label(id)).toBe(selected);
      await act(async () => reads[1]?.resolve({ ...initialSettings, [field]: value }));
      await waitFor(() =>
        expect(container.querySelector(`#${id}`)?.hasAttribute('disabled')).toBe(false)
      );
    }
  );

  it('ignores a delayed older refetch while a newer model is saving', async () => {
    // A background read starts before the user makes a newer choice.
    let refresh: Promise<void>;
    await act(() => {
      refresh = invalidate();
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    await select('default-claude-model', 'Fable');
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => {
      reads[1]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' });
      await refresh;
    });
    await waitFor(() => expect(label('default-claude-model')).toBe('Fable'));
    await act(async () => saves[0]?.resolve({ ...initialSettings, defaultClaudeModel: 'fable' }));
    await waitFor(() => expect(reads).toHaveLength(3));
    await act(async () => reads[2]?.resolve({ ...initialSettings, defaultClaudeModel: 'fable' }));
    await waitFor(() =>
      expect(container.querySelector('#default-claude-model')?.hasAttribute('disabled')).toBe(false)
    );
    // Later external changes still synchronize after the local operation ends.
    await act(() => {
      refresh = invalidate();
    });
    await waitFor(() => expect(reads).toHaveLength(4));
    await act(async () => {
      reads[3]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' });
      await refresh;
    });
    await waitFor(() => expect(label('default-claude-model')).toBe('Opus'));
  });

  it('orders queued saves and protects a repeated newer choice from an older failure', async () => {
    // Exercise already queued change handlers even while the rendered inputs are disabled.
    for (const value of ['opus', 'fable', 'opus']) {
      await act(async () => selectionHandlers.get('default-claude-model')?.(value));
    }
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]?.input).toEqual({ defaultClaudeModel: 'opus' });
    await act(async () => saves[0]?.reject());
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(label('default-claude-model')).toBe('Opus');
    expect(saves[1]?.input).toEqual({ defaultClaudeModel: 'fable' });
    await act(async () => saves[1]?.resolve({ ...initialSettings, defaultClaudeModel: 'fable' }));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(saves).toHaveLength(2);
    await act(async () => reads[1]?.resolve({ ...initialSettings, defaultClaudeModel: 'fable' }));
    await waitFor(() => expect(saves).toHaveLength(3));
    expect(label('default-claude-model')).toBe('Opus');
    expect(saves[2]?.input).toEqual({ defaultClaudeModel: 'opus' });
    await act(async () => saves[2]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' }));
    await waitFor(() => expect(reads).toHaveLength(3));
    await act(async () => reads[2]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' }));
    await waitFor(() =>
      expect(container.querySelector('#default-claude-model')?.hasAttribute('disabled')).toBe(false)
    );
    expect(label('default-claude-model')).toBe('Opus');
  });

  it('saves a queued return to the previous server value and rolls back the latest failure', async () => {
    await act(() => {
      const change = selectionHandlers.get('default-claude-model');
      change?.('opus');
      change?.('sonnet');
    });
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => saves[0]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' }));
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[1]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]?.input).toEqual({ defaultClaudeModel: 'sonnet' });
    expect(label('default-claude-model')).toBe('Sonnet');
    await act(async () => saves[1]?.reject());
    await waitFor(() => expect(label('default-claude-model')).toBe('Opus'));
  });

  it('rolls back to the successful save when a newer choice cancels its delayed refetch', async () => {
    await select('default-claude-model', 'Opus');
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => saves[0]?.resolve({ ...initialSettings, defaultClaudeModel: 'opus' }));
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => selectionHandlers.get('default-claude-model')?.('fable'));
    await waitFor(() => expect(saves).toHaveLength(2));
    await act(async () => saves[1]?.reject());
    await waitFor(() => expect(label('default-claude-model')).toBe('Opus'));
    await act(async () => reads[1]?.resolve(initialSettings));
    expect(label('default-claude-model')).toBe('Opus');
  });

  it('rolls back a rejected save and accepts later external updates', async () => {
    await select('default-codex-model', 'Codex A');
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => saves[0]?.reject());
    await waitFor(() => expect(label('default-codex-model')).toBe('Default'));
    let refresh: Promise<void>;
    await act(() => {
      refresh = invalidate();
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => {
      reads[1]?.resolve({ ...initialSettings, defaultCodexModel: 'gpt-b' });
      await refresh;
    });
    await waitFor(() => expect(label('default-codex-model')).toBe('Codex B'));
  });
});

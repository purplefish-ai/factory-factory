// @vitest-environment jsdom
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { ModelCatalogWarning } from './model-catalog-warning';

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let models: { value: string; label: string }[];
let catalogReads: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  focusManager.setFocused(true);
  models = [{ value: 'sonnet', label: 'Sonnet' }];
  catalogReads = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  client.clear();
  container.remove();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  const transport = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'userSettings.get') {
              observer.next({
                result: {
                  data: { defaultClaudeModel: 'saved-model', defaultCodexModel: 'default' },
                },
              });
            } else if (op.path === 'userSettings.getProviderOptions') {
              catalogReads += 1;
              observer.next({
                result: {
                  data: {
                    CLAUDE: { source: 'cli', models, efforts: [] },
                    CODEX: { source: 'cli', models: [], efforts: [] },
                  },
                },
              });
            } else {
              observer.error(new TRPCClientError(`Unexpected request: ${op.path}`));
              return;
            }
            observer.complete();
          }),
    ],
  });
  await act(() => {
    root.render(
      <trpc.Provider client={transport} queryClient={client}>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ModelCatalogWarning />
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await advance(1);
}

async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

describe('model catalog warning refresh', () => {
  it('refreshes a visible warning and stops polling when the saved model returns', async () => {
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    models = [{ value: 'saved-model', label: 'Restored model' }];
    await advance(60_001);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(catalogReads).toBe(2);
    await advance(60_001);
    expect(catalogReads).toBe(2);
  });

  it('refreshes a stale healthy catalog on focus despite the app-wide default', async () => {
    models = [{ value: 'saved-model', label: 'Saved model' }];
    await render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    focusManager.setFocused(false);
    models = [];
    await advance(60_001);
    expect(catalogReads).toBe(1);
    await act(() => focusManager.setFocused(true));
    await advance(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('saved-model');
    expect(catalogReads).toBe(2);
  });
});

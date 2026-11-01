// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFreshSubagentControls } from './use-fresh-subagent-controls';

const key = ['fresh-control-contract'];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let client: QueryClient;
let request: ReturnType<typeof vi.fn<() => Promise<string>>>;
let refetch: () => Promise<unknown>;
const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function Probe() {
  const query = useQuery({ queryKey: key, queryFn: request, enabled: false, retry: false });
  refetch = query.refetch;
  const control = useFreshSubagentControls({
    sessionId: 'parent',
    controlSessionId: 'parent',
    controlRuntimeId: 'runtime',
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    error: query.error,
  });
  return <output>{control ?? 'hidden'}</output>;
}
async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  request = vi.fn();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  client.clear();
});
async function mount() {
  await act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
}

it('rejects a superseded real QueryObserver refetch that resolves with unchanged cached success', async () => {
  client.setQueryData(key, 'old cached capability', { updatedAt: 10 });
  const cancelled = deferred();
  request.mockReturnValueOnce(cancelled.promise);
  await mount();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    await client.cancelQueries({ queryKey: key });
  });
  await flush();
  expect(container.textContent).toBe('hidden');
  const fresh = deferred();
  request.mockReturnValueOnce(fresh.promise);
  await act(() => {
    void refetch();
  });
  await act(() => fresh.resolve('current capability'));
  await flush();
  expect(container.textContent).toBe('parent');
});

it('drains a fetch started before the new scope and requires a subsequent network read', async () => {
  const old = deferred();
  const fresh = deferred();
  request.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  void client.fetchQuery({ queryKey: key, queryFn: request }).catch(() => undefined);
  await mount();
  await act(() => old.resolve('pre-scope capability'));
  await flush();
  expect(container.textContent).toBe('hidden');
  expect(request).toHaveBeenCalledTimes(2);
  await act(() => fresh.resolve('current capability'));
  await flush();
  expect(container.textContent).toBe('parent');
});

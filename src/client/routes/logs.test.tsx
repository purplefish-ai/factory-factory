// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LogsPage from './logs';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { admin: { getLogs: { useQuery: (input: unknown) => mocks.query(input) } } },
}));
vi.mock('@/client/components/app-header-context', () => ({ useAppHeader: vi.fn() }));
vi.mock('@/client/hooks/use-download-server-log', () => ({
  useDownloadServerLog: () => ({ download: vi.fn(), isDownloading: false }),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:34:15.001Z'));
  mocks.query.mockReturnValue({
    data: { entries: [], total: 0, totalIsExact: true, hasMore: false },
    isLoading: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  void act(() => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.clearAllMocks();
});
it.each(['5', '15', '60', '360', '1440'])(
  'keeps relative %s-minute query keys stable between renders within a minute',
  (range) => {
    void act(() =>
      root.render(
        <MemoryRouter initialEntries={['/admin/logs']}>
          <LogsPage />
        </MemoryRouter>
      )
    );
    const select = container.querySelectorAll('select')[1];
    void act(() => {
      if (select) {
        select.value = range;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const initial = mocks.query.mock.lastCall?.[0];
    expect(initial.since).toBeDefined();
    vi.setSystemTime(new Date('2026-10-27T12:34:16.123Z'));
    void act(() =>
      root.render(
        <MemoryRouter initialEntries={['/admin/logs']}>
          <LogsPage />
        </MemoryRouter>
      )
    );
    expect(mocks.query.mock.lastCall?.[0]).toEqual(initial);

    vi.setSystemTime(new Date('2026-10-27T12:35:00.001Z'));
    void act(() => vi.advanceTimersByTime(10_000));
    expect(mocks.query.mock.lastCall?.[0].since).not.toBe(initial.since);
  }
);

it.each(['all', 'custom'])('stops the relative clock when switching to %s', (range) => {
  void act(() =>
    root.render(
      <MemoryRouter initialEntries={['/admin/logs']}>
        <LogsPage />
      </MemoryRouter>
    )
  );
  const select = container.querySelectorAll('select')[1];
  void act(() => {
    if (select) {
      select.value = '5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(vi.getTimerCount()).toBe(2);
  void act(() => {
    if (select) {
      select.value = range;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(vi.getTimerCount()).toBe(1);
});
it('clears the relative clock on unmount', () => {
  void act(() =>
    root.render(
      <MemoryRouter initialEntries={['/admin/logs']}>
        <LogsPage />
      </MemoryRouter>
    )
  );
  const select = container.querySelectorAll('select')[1];
  void act(() => {
    if (select) {
      select.value = '5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(vi.getTimerCount()).toBe(2);
  void act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('keeps settings navigation available while loading=%s', (isLoading) => {
  if (isLoading) {
    mocks.query.mockReturnValue({ data: undefined, isLoading: true });
  }
  void act(() =>
    root.render(
      <MemoryRouter initialEntries={['/admin/logs']}>
        <LogsPage />
      </MemoryRouter>
    )
  );
  const navigation = container.querySelector('nav[aria-label="Settings sections"]');
  expect(navigation).not.toBeNull();
  expect(navigation?.querySelector('a[aria-current="page"]')?.textContent).toBe('Server logs');
  expect(navigation?.querySelector('a[href="/admin/appearance"]')).not.toBeNull();
});

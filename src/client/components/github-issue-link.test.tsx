// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown';

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({ trpc: { github: { getIssuePreview: { useQuery } } } }));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
});
afterEach(async () => {
  if (root) {
    await act(() => root.unmount());
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(content: string) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<MarkdownRenderer content={content} />));
  return container.querySelector('a')!;
}

it('loads issue metadata only when focused and keeps normal link navigation', async () => {
  useQuery.mockReturnValue({
    data: {
      title: 'Show issue previews',
      state: 'OPEN',
      author: { login: 'martin' },
      createdAt: '2026-10-28T12:00:00Z',
    },
    isError: false,
  });
  const link = await render('[#42](https://github.com/Owner/Repo/issues/42#discussion)');
  expect(useQuery).not.toHaveBeenCalled();
  expect(link.target).toBe('_blank');
  expect(link.href).toBe('https://github.com/Owner/Repo/issues/42#discussion');
  await act(() => link.focus());
  expect(document.body.textContent).toContain('Show issue previews');
  expect(document.body.textContent).toContain('Owner/Repo #42');
  expect(document.body.textContent).toContain('martin');
  expect(document.body.textContent).toContain('Open');
  expect(useQuery).toHaveBeenCalledWith(
    { repo: 'owner/repo', number: 42 },
    expect.objectContaining({ staleTime: 60_000, retry: false })
  );
  await act(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
});

it.each([
  { data: undefined, isError: false, text: 'Loading issue' },
  { data: undefined, isError: true, text: 'Preview unavailable' },
  {
    data: {
      title: 'Done',
      state: 'CLOSED',
      author: null,
      createdAt: '2026-10-28T12:00:00Z',
    },
    isError: false,
    text: 'Closed',
  },
])('renders loading, failure, and terminal states: $text', async ({ text, ...result }) => {
  useQuery.mockReturnValue(result);
  const link = await render('[Issue](https://github.com/o/r/issues/42)');
  await act(() => link.focus());
  expect(document.body.textContent).toContain(text);
  if (result.data?.author === null) {
    expect(document.body.textContent).toContain('Deleted user');
  }
});

it('leaves other links without previews', async () => {
  const link = await render('[Other](https://example.com/o/r/issues/42)');
  await act(() => link.focus());
  expect(useQuery).not.toHaveBeenCalled();
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
});

it('opens the preview after hovering with a mouse', async () => {
  useQuery.mockReturnValue({ data: undefined, isError: false });
  const link = await render('[Issue](https://github.com/o/r/issues/42)');
  await act(() => {
    link.dispatchEvent(
      Object.assign(new MouseEvent('pointermove', { bubbles: true }), {
        pointerType: 'mouse',
      })
    );
  });
  expect(useQuery).not.toHaveBeenCalled();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  expect(document.body.textContent).toContain('Loading issue');
  expect(document.querySelector('[data-slot="tooltip-content"] svg')).toBeNull();
});

it.each([
  { ageMs: -5000, expected: 'now' },
  { ageMs: 0, expected: 'now' },
  { ageMs: 4999, expected: 'now' },
  { ageMs: 5000, expected: 'now' },
  { ageMs: 5001, expected: '5 seconds ago' },
  { ageMs: 60_000, expected: '1 minute ago' },
])('formats an issue created $ageMs milliseconds ago as $expected', async ({ ageMs, expected }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = new Date('2026-10-28T12:00:00Z').getTime();
  vi.setSystemTime(now);
  useQuery.mockReturnValue({
    data: {
      title: 'New Issue',
      state: 'OPEN',
      author: { login: 'martin' },
      createdAt: new Date(now - ageMs).toISOString(),
    },
    isError: false,
  });
  const link = await render('[Issue](https://github.com/o/r/issues/42)');
  await act(() => link.focus());
  expect(document.querySelector('time')?.textContent).toBe(expected);
});

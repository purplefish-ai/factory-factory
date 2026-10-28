// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown';

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({ trpc: { github: { getPRPreview: { useQuery } } } }));

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
  vi.unstubAllGlobals();
});

async function render(content: string) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<MarkdownRenderer content={content} />));
  return container.querySelector('a')!;
}

it('loads PR metadata only when focused and keeps normal link navigation', async () => {
  useQuery.mockReturnValue({
    data: {
      title: 'Show PR previews',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'martin' },
      createdAt: '2026-10-28T12:00:00Z',
      additions: 24,
      deletions: 3,
      changedFiles: 2,
    },
    isError: false,
  });
  const link = await render('[#42](https://github.com/owner/repo/pull/42#discussion)');
  expect(useQuery).not.toHaveBeenCalled();
  expect(link.target).toBe('_blank');
  expect(link.href).toBe('https://github.com/owner/repo/pull/42#discussion');
  await act(() => link.focus());
  expect(document.body.textContent).toContain('Show PR previews');
  expect(document.body.textContent).toContain('martin');
  expect(document.body.textContent).toContain('+24');
  expect(document.body.textContent).toContain('−3');
  expect(document.body.textContent).toContain('2 files');
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
  { data: undefined, isError: false, text: 'Loading pull request' },
  { data: undefined, isError: true, text: 'Preview unavailable' },
  {
    data: {
      title: 'Done',
      state: 'MERGED',
      isDraft: true,
      author: null,
      createdAt: '2026-10-28T12:00:00Z',
      additions: 0,
      deletions: 0,
      changedFiles: 1,
    },
    isError: false,
    text: 'Merged',
  },
])('renders loading, failure, and terminal states: $text', async ({ text, ...result }) => {
  useQuery.mockReturnValue(result);
  const link = await render('[PR](https://github.com/o/r/pull/42)');
  await act(() => link.focus());
  expect(document.body.textContent).toContain(text);
});

it('leaves other links without previews', async () => {
  const link = await render('[Issue](https://github.com/o/r/issues/42)');
  await act(() => link.focus());
  expect(useQuery).not.toHaveBeenCalled();
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
});

it('opens the preview after hovering with a mouse', async () => {
  useQuery.mockReturnValue({ data: undefined, isError: false });
  const link = await render('[PR](https://github.com/o/r/pull/42)');
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
  expect(document.body.textContent).toContain('Loading pull request');
  expect(document.querySelector('[data-slot="tooltip-content"] svg')).toBeNull();
});

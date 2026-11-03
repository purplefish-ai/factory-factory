// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatImageWorkspaceContext } from './chat-image-context';
import { MarkdownRenderer } from './markdown';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/client/lib/trpc', () => ({
  trpc: { workspace: { readChatImage: { useQuery: query } } },
}));
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.mockReturnValue({
    data: { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    isPending: false,
    isError: false,
  });
});
afterEach(async () => {
  if (root) {
    await act(() => root.unmount());
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(content: string, workspaceId: string | undefined = 'w1') {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <ChatImageWorkspaceContext value={workspaceId}>
        <MarkdownRenderer content={content} />
      </ChatImageWorkspaceContext>
    )
  );
  return container;
}

it.each([
  '/private/tmp/mockup.png',
  'design/mockup.png',
  'file:///private/tmp/mockup.png',
  'C:/temp/mockup.png',
  'file:///C:/temp/mockup.png',
])('loads the local Markdown reference %s through the backend', async (source) => {
  const container = await render(`![Mockup](${source})`);
  expect(query).toHaveBeenCalledWith(
    {
      workspaceId: 'w1',
      path:
        source === 'file:///C:/temp/mockup.png'
          ? 'C:/temp/mockup.png'
          : source.replace('file://', ''),
    },
    expect.objectContaining({ retry: false })
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'data:image/png;base64,iVBORw0KGgo='
  );
  await act(() => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
    'data:image/png;base64,iVBORw0KGgo='
  );
});

it('shows the selectable source when loading fails', async () => {
  query.mockReturnValue({ isError: true, isPending: false });
  const container = await render('![Missing](/private/tmp/missing.png)');
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('Image unavailable');
  expect(container.querySelector('code')?.textContent).toBe('/private/tmp/missing.png');
});

it('shows a path fallback outside workspace chat without attempting a browser filesystem request', async () => {
  const container = await render('![Mockup](/private/tmp/mockup.png)', '');
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('/private/tmp/mockup.png');
});

it('retains remote images and shows a fallback after a decode or network error', async () => {
  const container = await render('![Remote](https://example.com/mockup.png)');
  expect(query).not.toHaveBeenCalled();
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'https://example.com/mockup.png'
  );
  await act(() => container.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(container.textContent).toContain('Image unavailable');
  expect(container.textContent).toContain('https://example.com/mockup.png');
});

it.each(['javascript:alert(1)', 'data:text/html;base64,YQ==', 'data:image/svg+xml;base64,YQ=='])(
  'does not load unsafe image source %s',
  async (source) => {
    const container = await render(`![Unsafe](<${source}>)`);
    expect(container.querySelector('img')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  }
);

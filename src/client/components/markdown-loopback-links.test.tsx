// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown';

const portSharing = vi.hoisted(() => vi.fn<() => boolean | undefined>(() => true));
vi.mock('@/client/hooks/use-port-sharing', () => ({ usePortSharing: portSharing }));
vi.mock('@/client/lib/trpc', () => ({ trpc: {} }));
vi.mock('./github-pr-link', () => ({
  GitHubPRLink: ({ link }: { link: React.ReactElement }) => link,
}));

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  portSharing.mockReturnValue(true);
});
afterEach(async () => {
  if (root) {
    await act(() => root?.unmount());
    root = undefined;
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderLink(content: string): Promise<HTMLAnchorElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(<MarkdownRenderer content={content} />));
  const anchor = container.querySelector('a');
  if (!anchor) {
    throw new Error('Expected a link');
  }
  return anchor;
}

it('opens host loopback links through a shared Tailscale port, keeping their text', async () => {
  const url = 'http://127.0.0.1:6173/?path=/story/chat-streaming-markdown-comparison--prose';
  const anchor = await renderLink(url);
  expect(anchor.getAttribute('href')).toBe(
    '/proxy/6173/?path=/story/chat-streaming-markdown-comparison--prose'
  );
  expect(anchor.textContent).toContain(url);
  expect(anchor.title).toContain('port 6173');
  expect(anchor.target).toBe('_blank');
});

it('keeps loopback links unchanged when port sharing is unavailable', async () => {
  portSharing.mockReturnValue(false);
  const anchor = await renderLink('[storybook](http://localhost:6006/)');
  expect(anchor.getAttribute('href')).toBe('http://localhost:6006/');
});

it('withholds loopback links until port sharing status loads', async () => {
  portSharing.mockReturnValue(undefined);
  const anchor = await renderLink('[storybook](http://localhost:6006/)');
  expect(anchor.hasAttribute('href')).toBe(false);
  expect(anchor.getAttribute('aria-disabled')).toBe('true');
  expect(anchor.textContent).toContain('storybook');
});

it('does not rewrite other external links', async () => {
  const anchor = await renderLink('[docs](https://example.com:8080/a)');
  expect(anchor.getAttribute('href')).toBe('https://example.com:8080/a');
});

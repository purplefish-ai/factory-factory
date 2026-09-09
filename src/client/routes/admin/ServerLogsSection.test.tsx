// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ServerLogsSection } from './ServerLogsSection';

vi.mock('@/client/hooks/use-download-server-log', () => ({
  useDownloadServerLog: () => ({ download: vi.fn(), isDownloading: false }),
}));

it('renders the logs action as one link without nested interactive controls', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  flushSync(() => root.render(createElement(MemoryRouter, null, createElement(ServerLogsSection))));
  const link = container.querySelector('a[href="/logs"]');
  expect(link?.textContent).toBe('View Logs');
  expect(link?.querySelector('button')).toBeNull();
  root.unmount();
});

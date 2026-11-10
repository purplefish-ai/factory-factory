// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupLogsPanel } from './setup-logs-panel';

const initStatus = vi.hoisted(() => ({
  current: undefined as undefined | { status: string; initOutput: string | null },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      getInitStatus: { useQuery: () => ({ data: initStatus.current }) },
    },
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  initStatus.current = undefined;
});

function render(status: string, initOutput: string | null) {
  initStatus.current = { status, initOutput };
  act(() => root.render(createElement(SetupLogsPanel, { workspaceId: 'ws-1' })));
  return container.textContent ?? '';
}

it('explains that archived workspaces do not keep their setup log', () => {
  const text = render('ARCHIVED', null);

  expect(text).toContain('Setup logs are not kept for archived workspaces.');
  expect(text).not.toContain('No setup logs yet.');
});

it('labels the kept tail of a failed setup log on an archived workspace', () => {
  const text = render('ARCHIVED', '[...truncated...]\nnpm ERR! exit 1\n');

  expect(text).toContain('Archived workspaces keep only the end of a failed setup log.');
  expect(text).toContain('npm ERR! exit 1');
});

it('keeps the live empty state and shows no archive note before archive', () => {
  expect(render('READY', null)).toBe('No setup logs yet.');
  expect(render('READY', 'installed\n')).not.toContain('Archived workspaces');
});

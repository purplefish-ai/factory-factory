// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { waitForReact } from '@/test-utils/react-act';
import { ClosedSessionsDropdown } from './closed-sessions-dropdown';

const query = vi.hoisted(() => ({
  data: undefined as unknown[] | undefined,
  error: null as { message: string } | null,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { closedSessions: { list: { useQuery: () => query } } },
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.data = undefined;
  query.error = null;
  query.refetch.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function render() {
  await act(() =>
    root.render(
      <TooltipProvider>
        <ClosedSessionsDropdown workspaceId="workspace-1" onSelectClosedSession={vi.fn()} />
      </TooltipProvider>
    )
  );
}

async function openMenu() {
  await act(() =>
    container
      .querySelector('button')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  await waitForReact(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
}

it('hides the button once the list loads empty', async () => {
  query.data = [];
  await render();
  expect(container.querySelector('button')).toBeNull();
});

it('keeps a failed list reachable and offers Retry instead of hiding the button', async () => {
  query.error = { message: 'Database is locked' };
  await render();
  expect(container.querySelector('button')?.textContent).toContain('Closed');
  await openMenu();
  const alert = document.querySelector('[role="menu"] [role="alert"]');
  expect(alert?.textContent).toContain("Couldn't load closed sessions");
  expect(alert?.textContent).toContain('Database is locked');
  await act(() => alert?.querySelector('button')?.click());
  expect(query.refetch).toHaveBeenCalledOnce();
});

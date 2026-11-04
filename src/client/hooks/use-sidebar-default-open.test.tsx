// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { useRouteSidebarState } from './use-sidebar-default-open';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
const container = document.createElement('div');
let root: ReturnType<typeof createRoot>;
function Controls() {
  const { open, setOpen } = useSidebar();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>{String(open)}</output>
      <span data-testid="pathname">{pathname}</span>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      <button
        onClick={() => {
          void navigate('/projects/a/workspaces');
        }}
      >
        Board
      </button>
      <button
        onClick={() => {
          void navigate('/projects/a/workspaces/ws-1');
        }}
      >
        Workspace
      </button>
    </>
  );
}
function Harness() {
  const [open, setOpen] = useRouteSidebarState();
  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <Controls />
    </SidebarProvider>
  );
}
function mount(path: string) {
  root = createRoot(container);
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Harness />
      </MemoryRouter>
    )
  );
}
function click(label: string) {
  act(() =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label)!.click()
  );
}
afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});
it('keeps the sidebar open when navigating to Board and back', () => {
  mount('/projects/a/workspaces/ws-1');
  click('Board');
  expect(container.querySelector('[data-testid=pathname]')?.textContent).toBe(
    '/projects/a/workspaces'
  );
  expect(container.querySelector('output')?.textContent).toBe('true');
  click('Workspace');
  expect(container.querySelector('[data-testid=pathname]')?.textContent).toBe(
    '/projects/a/workspaces/ws-1'
  );
  expect(container.querySelector('output')?.textContent).toBe('true');
});
it('keeps an explicit collapse across navigation and reload', () => {
  mount('/projects/a/workspaces/ws-1');
  click('Toggle');
  click('Board');
  expect(container.querySelector('[data-testid=pathname]')?.textContent).toBe(
    '/projects/a/workspaces'
  );
  click('Workspace');
  expect(container.querySelector('[data-testid=pathname]')?.textContent).toBe(
    '/projects/a/workspaces/ws-1'
  );
  expect(container.querySelector('output')?.textContent).toBe('false');
  act(() => root.unmount());
  mount('/projects/a/workspaces');
  expect(container.querySelector('output')?.textContent).toBe('false');
});
it('opens the board by default instead of resetting it collapsed', () => {
  mount('/projects/a/workspaces');
  expect(container.querySelector('output')?.textContent).toBe('true');
});

it('persists a desktop toggle only once through SidebarProvider', () => {
  mount('/projects/a/workspaces');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  click('Toggle');
  expect(write).toHaveBeenCalledExactlyOnceWith('sidebar_state', 'false');
  write.mockRestore();
});

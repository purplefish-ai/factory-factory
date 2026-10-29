// @vitest-environment jsdom
import { createContext, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { AppHeader } from './app-header';
import {
  AppHeaderProvider,
  HeaderLeftExtraSlot,
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from './app-header-context';

vi.mock('@/client/features/search', () => ({ GlobalSearch: () => <button>Search</button> }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/ui/sidebar', () => ({ useSidebar: () => ({ toggleSidebar: vi.fn() }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: () => null,
}));
const NestedContext = createContext('outside');
function ContextAction({ onAction }: { onAction: (context: string) => void }) {
  const context = useContext(NestedContext);
  return <button onClick={() => onAction(context)}>Workspace action</button>;
}
function Page({
  workspace,
  onAction,
}: {
  workspace: boolean;
  onAction: (context: string) => void;
}) {
  useAppHeader({ title: workspace ? '' : 'Global settings' });
  return workspace ? (
    <NestedContext.Provider value="workspace">
      <HeaderLeftStartSlot>
        <span>Project / Workspace</span>
      </HeaderLeftStartSlot>
      <HeaderLeftExtraSlot>
        <span>Merged</span>
      </HeaderLeftExtraSlot>
      <HeaderRightSlot>
        <ContextAction onAction={onAction} />
      </HeaderRightSlot>
    </NestedContext.Provider>
  ) : null;
}
afterEach(() => document.body.replaceChildren());
it('preserves context and interaction across all portal slots and restores a generic page title', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onAction = vi.fn();
  const render = (workspace: boolean) =>
    actFlushSync(() =>
      root.render(
        <AppHeaderProvider>
          <AppHeader />
          <Page workspace={workspace} onAction={onAction} />
        </AppHeaderProvider>
      )
    );
  try {
    render(true);
    const header = container.querySelector('header');
    expect(header?.textContent).toContain('Project / Workspace');
    expect(header?.textContent).toContain('Merged');
    const action = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Workspace action'
    );
    actFlushSync(() => action?.click());
    expect(onAction).toHaveBeenCalledWith('workspace');
    render(false);
    expect(header?.textContent).toContain('Global settings');
    expect(header?.textContent).not.toContain('Project / Workspace');
    expect(header?.textContent).not.toContain('Merged');
    expect(header?.textContent).not.toContain('Workspace action');
    expect(header?.textContent).toContain('Search');
  } finally {
    actFlushSync(() => root.unmount());
  }
});

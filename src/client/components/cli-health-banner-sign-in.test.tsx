// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CLIHealthBanner } from './cli-health-banner';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/client/hooks/use-cli-health-refresh', () => ({
  useCLIHealthRefresh: () => ({ refresh }),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      checkCLIHealth: {
        useQuery: () => ({
          data: {
            claude: { isInstalled: true, isAuthenticated: false },
            codex: { isInstalled: true },
            github: { isInstalled: true, isAuthenticated: true },
          },
          isLoading: false,
          isRefetching: false,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));
vi.mock('@/client/features/project', () => ({
  SetupTerminalModal: ({
    open,
    initialProvider,
    onClose,
  }: {
    open: boolean;
    initialProvider: string;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog">
        {initialProvider}
        <button onClick={onClose}>Close terminal</button>
      </div>
    ) : null,
}));

it('opens managed Claude login from the banner and refreshes health when it closes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() => root.render(<CLIHealthBanner />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const signIn = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Sign in to Claude'
    );
    expect(signIn).toBeDefined();
    await act(async () => {
      signIn?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('CLAUDE');
    await act(() => container.querySelector<HTMLButtonElement>('[role="dialog"] button')?.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

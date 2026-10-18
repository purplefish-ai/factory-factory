import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderCliWarning } from './provider-cli-warning';

const state = vi.hoisted(() => ({
  health: {
    claude: { isInstalled: true, isOutdated: false },
    codex: { isInstalled: true, isAuthenticated: true, isOutdated: true },
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ admin: { checkCLIHealth: { invalidate: vi.fn(), setData: vi.fn() } } }),
    admin: {
      upgradeProviderCLI: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      checkCLIHealth: { useQuery: () => ({ data: state.health, isRefetching: false }) },
    },
  },
}));

describe('ProviderCliWarning', () => {
  beforeEach(() => {
    state.health.claude = { isInstalled: true, isOutdated: false };
    state.health.codex = { isInstalled: true, isAuthenticated: true, isOutdated: true };
  });

  it('ignores stale npm upgrade state for the managed Codex runtime', () => {
    // Catches offering a global upgrade that cannot change the bundled runtime.
    expect(renderToStaticMarkup(<ProviderCliWarning provider="CODEX" />)).toBe('');
  });

  it('offers the bundled login command when Codex is unauthenticated', () => {
    state.health.codex.isAuthenticated = false;
    const markup = renderToStaticMarkup(<ProviderCliWarning provider="CODEX" />);
    expect(markup).toContain('ff codex login');
    expect(markup).not.toContain('Upgrade');
  });

  it('explains app repair when the bundled runtime is missing', () => {
    state.health.codex.isInstalled = false;
    const markup = renderToStaticMarkup(<ProviderCliWarning provider="CODEX" />);
    expect(markup).toContain('Update or reinstall Factory Factory');
    expect(markup).not.toContain('href=');
  });

  it('retains the Claude upgrade action', () => {
    state.health.claude.isOutdated = true;
    expect(renderToStaticMarkup(<ProviderCliWarning provider="CLAUDE" />)).toContain('Upgrade');
  });
});

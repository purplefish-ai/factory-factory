import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderCliWarning } from './provider-cli-warning';

const state = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; enabled: boolean; authenticated: boolean }>,
  health: {
    claude: { isInstalled: true, isOutdated: false },
    codex: { isInstalled: true, isAuthenticated: true, isOutdated: true },
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ admin: { checkCLIHealth: { invalidate: vi.fn(), setData: vi.fn() } } }),
    codexAccounts: { list: { useQuery: () => ({ data: state.accounts }) } },
    admin: {
      upgradeProviderCLI: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      checkCLIHealth: { useQuery: () => ({ data: state.health, isRefetching: false }) },
    },
  },
}));

beforeEach(() => {
  state.accounts = [];
  state.health.claude = { isInstalled: true, isOutdated: false };
  state.health.codex = { isInstalled: true, isAuthenticated: true, isOutdated: true };
});

describe('ProviderCliWarning', () => {
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
    const markup = renderToStaticMarkup(<ProviderCliWarning provider="CLAUDE" />);
    const buttons = Array.from(
      markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g),
      (match) => match[1]
    );
    expect(buttons).toContainEqual(expect.stringContaining('Upgrade'));
  });
});

it('does not ask for native login when Auto can use an authenticated managed account', () => {
  state.health.codex.isAuthenticated = false;
  state.accounts = [
    { id: 'native', enabled: true, authenticated: false },
    { id: 'work', enabled: true, authenticated: true },
  ];
  expect(renderToStaticMarkup(<ProviderCliWarning provider="CODEX" />)).toBe('');
});
it('does not suppress the native login warning when every account is signed out or excluded from Auto', () => {
  state.health.codex.isAuthenticated = false;
  state.accounts = [
    { id: 'native', enabled: true, authenticated: false },
    { id: 'work', enabled: false, authenticated: true },
  ];
  expect(renderToStaticMarkup(<ProviderCliWarning provider="CODEX" />)).toContain('ff codex login');
});
it('keeps the missing-runtime warning even with a usable managed account', () => {
  state.health.codex.isInstalled = false;
  state.accounts = [{ id: 'work', enabled: true, authenticated: true }];
  expect(renderToStaticMarkup(<ProviderCliWarning provider="CODEX" />)).toContain(
    'Update or reinstall Factory Factory'
  );
});

it('allows a manually selected authenticated account that is disabled for Auto', () => {
  state.health.codex.isAuthenticated = false;
  state.accounts = [{ id: 'work', enabled: false, authenticated: true }];
  expect(renderToStaticMarkup(<ProviderCliWarning provider="CODEX" codexAccountId="work" />)).toBe(
    ''
  );
});
it('does not use another account to clear the warning for an unauthenticated manual selection', () => {
  state.health.codex.isAuthenticated = false;
  state.accounts = [
    { id: 'work', enabled: false, authenticated: false },
    { id: 'personal', enabled: true, authenticated: true },
  ];
  expect(
    renderToStaticMarkup(<ProviderCliWarning provider="CODEX" codexAccountId="work" />)
  ).toContain('ff codex login');
});

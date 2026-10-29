// @vitest-environment jsdom
import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAccountSummary, CodexLoginState } from '@/shared/codex-accounts';
import { CodexAccountLoginDialog } from './codex-account-login-dialog';
import { CodexAccountsSettings, CodexAccountsView } from './codex-accounts-settings';

const api = vi.hoisted(() => ({
  status: undefined as CodexLoginState | undefined,
  query: vi.fn(),
  create: vi.fn(async (_input: unknown) => ({ id: 'new-account' })),
  start: vi.fn(async (_input: unknown): Promise<CodexLoginState> => ({
    accountId: 'new-account',
    status: 'pending',
    authorizationUrl: 'https://auth.openai.com/example',
  })),
  cancel: vi.fn(async (_input: unknown): Promise<CodexLoginState> => ({
    accountId: 'new-account',
    status: 'cancelled',
  })),
  invalidate: vi.fn(async () => undefined),
  cancelQuery: vi.fn(async () => undefined),
}));
const utils = {
  codexAccounts: {
    list: { invalidate: api.invalidate },
    loginStatus: {
      cancel: api.cancelQuery,
      setData: (_input: unknown, state: CodexLoginState) => {
        api.status = state;
      },
    },
  },
};
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => utils,
    codexAccounts: {
      list: { useQuery: () => ({ data: [], isLoading: false }) },
      create: { useMutation: () => ({ mutateAsync: api.create, isPending: false }) },
      startLogin: { useMutation: () => ({ mutateAsync: api.start, isPending: false }) },
      cancelLogin: { useMutation: () => ({ mutateAsync: api.cancel, isPending: false }) },
      update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      loginStatus: {
        useQuery: (input: unknown, options: unknown) => {
          api.query(input, options);
          return { data: api.status };
        },
      },
    },
  },
}));
const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  document.body.innerHTML = '';
});
function render(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(element));
}
const account = (id: string): CodexAccountSummary => ({
  id,
  label: `Account ${id}`,
  kind: 'MANAGED',
  enabled: true,
  authenticated: true,
  email: null,
  planType: null,
  usage: {
    provider: 'CODEX',
    status: 'unavailable',
    updatedAt: '2026-10-29T12:00:00Z',
    windows: [],
    message: 'Usage unknown',
  },
});
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label
  );
  if (!found) {
    throw new Error(`Missing ${label}`);
  }
  return found;
}
describe('Codex account management', () => {
  it('shows many accounts, unknown usage and explicit Auto enable toggles', () => {
    const onUpdate = vi.fn();
    render(
      createElement(CodexAccountsView, {
        accounts: Array.from({ length: 8 }, (_, i) => account(String(i))),
        onAdd: vi.fn(),
        onLogin: vi.fn(),
        onUpdate,
      })
    );
    expect(document.body.textContent).toContain('Account 7');
    expect(document.body.textContent).toContain('Usage unknown');
    flushSync(() => button('Use Account 0 for Auto').click());
    expect(onUpdate).toHaveBeenCalledWith('0', false);
  });
  it('collects a name before starting native browser login', () => {
    const onSubmit = vi.fn();
    render(
      createElement(CodexAccountLoginDialog, {
        open: true,
        onClose: vi.fn(),
        onCancel: vi.fn(),
        onSubmit,
      })
    );
    const input = document.querySelector('input');
    flushSync(() => {
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          'Work'
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    flushSync(() => button('Continue to login').click());
    expect(onSubmit).toHaveBeenCalledWith('Work');
  });
  it('shows native authorization link and cancels explicitly while pending', () => {
    const onCancel = vi.fn();
    render(
      createElement(CodexAccountLoginDialog, {
        open: true,
        onClose: vi.fn(),
        onCancel,
        onSubmit: vi.fn(),
        login: {
          accountId: 'a',
          status: 'pending',
          authorizationUrl: 'https://auth.openai.com/example',
        },
      })
    );
    expect(document.querySelector('a')?.href).toBe('https://auth.openai.com/example');
    expect(document.body.textContent).toContain('Waiting for browser login');
    flushSync(() => button('Cancel login').click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)('shows %s login result', (status) => {
    render(
      createElement(CodexAccountLoginDialog, {
        open: true,
        onClose: vi.fn(),
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        login: {
          accountId: 'a',
          status,
          message: status === 'failed' ? 'Sign-in expired' : undefined,
        },
      })
    );
    expect(document.body.textContent).toContain(
      status === 'completed'
        ? 'Account connected'
        : status === 'failed'
          ? 'Sign-in expired'
          : 'Login cancelled'
    );
    expect(document.querySelector('a')).toBeNull();
  });
});

it('polls only a pending native login and stops after completion', async () => {
  api.status = undefined;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(createElement(CodexAccountsSettings)));
  expect(api.query).toHaveBeenLastCalledWith(
    { id: '' },
    expect.objectContaining({ enabled: false, refetchInterval: false })
  );
  flushSync(() => button('Add Codex account').click());
  const input = document.querySelector('input');
  flushSync(() => {
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Work'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () => button('Continue to login').click());
  expect(api.create).toHaveBeenLastCalledWith({ label: 'Work' });
  expect(api.query).toHaveBeenLastCalledWith(
    { id: 'new-account' },
    expect.objectContaining({ enabled: true, refetchInterval: 1000 })
  );
  api.status = { accountId: 'new-account', status: 'completed' };
  await act(async () => root.render(createElement(CodexAccountsSettings)));
  expect(document.body.textContent).toContain('Account connected');
  expect(api.query).toHaveBeenLastCalledWith(
    { id: 'new-account' },
    expect.objectContaining({ enabled: false, refetchInterval: false })
  );
});

it('starts a fresh login even when the same account has a cached completed login', async () => {
  api.status = { accountId: 'new-account', status: 'completed' };
  render(createElement(CodexAccountsSettings));
  flushSync(() => button('Add Codex account').click());
  const input = document.querySelector('input');
  flushSync(() => {
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Work'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () => button('Continue to login').click());
  expect(document.body.textContent).toContain('Waiting for browser login');
  expect(api.cancelQuery).toHaveBeenCalledWith({ id: 'new-account' });
});

it('instructs native-default users to reconnect in the terminal instead of starting managed login', () => {
  const onLogin = vi.fn();
  render(
    createElement(CodexAccountsView, {
      accounts: [{ ...account('native'), kind: 'NATIVE_DEFAULT', authenticated: false }],
      onAdd: vi.fn(),
      onLogin,
      onUpdate: vi.fn(),
    })
  );
  expect(document.body.textContent).toContain('ff codex login');
  expect(
    [...document.querySelectorAll('button')].some((button) => button.textContent === 'Sign in')
  ).toBe(false);
  expect(onLogin).not.toHaveBeenCalled();
});

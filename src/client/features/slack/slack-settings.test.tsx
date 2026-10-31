// @vitest-environment jsdom
import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SlackSettings } from './slack-settings';

const api = vi.hoisted(() => ({
  connections: [] as {
    id: string;
    name: string;
    workspaceId: string;
    hasCredentials: boolean;
    isEnabled: boolean;
  }[],
  connect: vi.fn(),
  test: vi.fn(),
  disconnect: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    slack: {
      list: { useQuery: () => ({ data: api.connections, isLoading: false, refetch: api.refetch }) },
      connect: {
        useMutation: () => ({ mutateAsync: api.connect, reset: vi.fn(), isPending: false }),
      },
      test: { useMutation: () => ({ mutateAsync: api.test, isPending: false }) },
      disconnect: { useMutation: () => ({ mutateAsync: api.disconnect, isPending: false }) },
    },
  },
}));
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.connections = [];
  api.connect.mockReset().mockResolvedValue({ name: 'Purplefish' });
  api.refetch.mockReset().mockResolvedValue({});
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  document.body.innerHTML = '';
});
function mount() {
  flushSync(() => root.render(createElement(SlackSettings)));
}
function tokenInput() {
  return document.querySelector('input') as HTMLInputElement;
}
function enterToken() {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      tokenInput(),
      'xoxb-test-token'
    );
    tokenInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
it('masks a new token and clears it after saving', async () => {
  mount();
  enterToken();
  expect(tokenInput().type).toBe('password');
  await submit();
  expect(tokenInput().value).toBe('');
  expect(document.body.textContent).toContain('Connected to Purplefish');
});
it('preserves the draft and shows a connection error on failed save', async () => {
  api.connect.mockRejectedValue(new Error('Slack rejected this bot token.'));
  mount();
  enterToken();
  await submit();
  expect(tokenInput().value).toBe('xoxb-test-token');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Slack rejected');
});
it('shows saved connection status without prefilling a token and confirms disconnect', () => {
  api.connections = [
    {
      id: 'slack-1',
      name: 'Purplefish',
      workspaceId: 'T-company',
      hasCredentials: true,
      isEnabled: true,
    },
  ];
  mount();
  expect(tokenInput().value).toBe('');
  expect(document.body.textContent).toContain('Purplefish');
  const disconnect = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Disconnect'
  );
  act(() => disconnect?.click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Remove the saved bot token'
  );
});

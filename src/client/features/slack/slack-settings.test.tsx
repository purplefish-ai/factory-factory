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
  api.test.mockReset().mockResolvedValue({ valid: true, workspaceName: 'Purplefish' });
  api.disconnect.mockReset().mockResolvedValue({ disconnected: true });
  api.refetch.mockReset().mockResolvedValue({});
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
function mount() {
  flushSync(() => root.render(createElement(SlackSettings)));
}
function tokenInput() {
  return document.querySelector('input') as HTMLInputElement;
}
function enterToken(value = 'xoxb-test-token') {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      tokenInput(),
      value
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
function savedConnection() {
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
}
function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === text
  );
  if (!found) {
    throw new Error(`Missing button: ${text}`);
  }
  return found;
}

it('shows saved status without prefilling a token and waits for confirmed disconnect', async () => {
  let finish: () => void = () => undefined;
  api.disconnect.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  savedConnection();
  expect(tokenInput().value).toBe('');
  expect(document.body.textContent).toContain('Purplefish');
  act(() => button('Disconnect').click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Remove the saved bot token'
  );
  act(() => button('Disconnect Slack').click());
  expect(api.disconnect).toHaveBeenCalledWith({ id: 'slack-1' });
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(
    [...document.querySelectorAll('[role="alertdialog"] button')].every(
      (button) => (button as HTMLButtonElement).disabled
    )
  ).toBe(true);
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.body.textContent).toContain('Slack credentials removed');
});

it('tests a saved connection and displays the result', async () => {
  savedConnection();
  await act(async () => {
    button('Test connection').click();
    await Promise.resolve();
  });
  expect(api.test).toHaveBeenCalledWith({ id: 'slack-1' });
  expect(document.body.textContent).toContain('Connected to Purplefish');
});

it('refreshes stale connections after a failed operation', async () => {
  api.test.mockRejectedValue(new Error('Connection was removed'));
  api.refetch.mockImplementation(() => {
    api.connections = [];
    return Promise.resolve({});
  });
  savedConnection();
  await act(async () => {
    button('Test connection').click();
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain('Connection was removed');
  expect(document.body.textContent).not.toContain('Purplefish');
});

it('allows rotated bot token submission', () => {
  mount();
  enterToken('xoxe.xoxb-1-test-token');
  expect(button('Connect Slack').disabled).toBe(false);
});

it('keeps a failed disconnect open with its error', async () => {
  api.disconnect.mockRejectedValue(new Error('Could not disconnect'));
  savedConnection();
  act(() => button('Disconnect').click());
  await act(async () => {
    button('Disconnect Slack').click();
    await Promise.resolve();
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Could not disconnect'
  );
  expect(button('Disconnect Slack').disabled).toBe(false);
});

it('does not show an unrelated test error in a new disconnect dialog', async () => {
  api.test.mockRejectedValue(new Error('Saved token validation failed'));
  savedConnection();
  await act(async () => {
    button('Test connection').click();
    await Promise.resolve();
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Saved token validation failed'
  );
  act(() => button('Disconnect').click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).not.toContain(
    'Saved token validation failed'
  );
});

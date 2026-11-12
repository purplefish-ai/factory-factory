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
    hasAppToken: boolean;
    appId: string | null;
  }[],
  connect: vi.fn(),
  test: vi.fn(),
  disconnect: vi.fn(),
  setAppToken: vi.fn(),
  clearAppToken: vi.fn(),
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
      setAppToken: {
        useMutation: () => ({ mutateAsync: api.setAppToken, reset: vi.fn(), isPending: false }),
      },
      clearAppToken: { useMutation: () => ({ mutateAsync: api.clearAppToken, isPending: false }) },
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
  api.setAppToken.mockReset().mockResolvedValue({ name: 'Purplefish' });
  api.clearAppToken.mockReset().mockResolvedValue({ name: 'Purplefish' });
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
function savedConnection(app: { hasAppToken: boolean; appId: string | null } = noApp) {
  api.connections = [
    {
      id: 'slack-1',
      name: 'Purplefish',
      workspaceId: 'T-company',
      hasCredentials: true,
      isEnabled: true,
      ...app,
    },
  ];
  mount();
}
const noApp = { hasAppToken: false, appId: null };
function confirmButton(): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
  ].find((button) => button.textContent === 'Disconnect');
  if (!found) {
    throw new Error('Missing Disconnect confirmation');
  }
  return found;
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
  act(() => confirmButton().click());
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

it('shows the spinner only on the connection being tested', async () => {
  let finish: (value: { valid: boolean; workspaceName: string }) => void = () => undefined;
  api.test.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  api.connections = [
    { id: 'slack-1', name: 'One', workspaceId: 'T-1', hasCredentials: true, isEnabled: true },
    { id: 'slack-2', name: 'Two', workspaceId: 'T-2', hasCredentials: true, isEnabled: true },
  ].map((connection) => ({ ...connection, ...noApp }));
  mount();
  // Each row now also has app-token buttons, so find the second row's Test button by label.
  const second = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (candidate) => candidate.textContent === 'Test connection'
  )[1];
  expect(second?.textContent).toBe('Test connection');
  act(() => second?.click());
  expect(api.test).toHaveBeenCalledWith({ id: 'slack-2' });
  expect(second?.textContent).toBe('Testing…');
  expect(second?.getAttribute('aria-busy')).toBe('true');
  expect(button('Test connection').disabled).toBe(true);
  expect(button('Test connection').hasAttribute('aria-busy')).toBe(false);
  expect(button('Connect Slack').hasAttribute('aria-busy')).toBe(false);
  await act(async () => {
    finish({ valid: true, workspaceName: 'Two' });
    await Promise.resolve();
  });
  expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
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
    confirmButton().click();
    await Promise.resolve();
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Could not disconnect'
  );
  // Reported once, in the dialog, not also in the page alert behind it.
  expect(document.querySelector('[role="alert"]')?.textContent ?? '').not.toContain(
    'Could not disconnect'
  );
  expect(confirmButton().disabled).toBe(false);
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

function appTokenInput() {
  return document.querySelector<HTMLInputElement>('#slack-app-token-slack-1');
}
function enterAppToken(value: string) {
  const input = appTokenInput();
  if (!input) {
    throw new Error('Missing app token input');
  }
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('shows app-token presence without rendering an entry field until asked', () => {
  savedConnection();
  expect(document.body.textContent).toContain('No app-level token');
  expect(appTokenInput()).toBeNull();
  savedConnection({ hasAppToken: true, appId: 'A-app' });
  expect(document.body.textContent).toContain('App-level token saved');
  expect(document.body.textContent).toContain('A-app');
  expect(document.body.textContent).not.toContain('xapp-');
});

it('masks a new app token, never prefills it, and clears it after saving', async () => {
  savedConnection({ hasAppToken: true, appId: 'A-app' });
  act(() => button('Replace app token').click());
  expect(appTokenInput()?.type).toBe('password');
  expect(appTokenInput()?.value).toBe('');
  expect(appTokenInput()?.autocomplete).toBe('off');
  expect(button('Save app token').disabled).toBe(true);
  enterAppToken('xoxb-not-an-app-token');
  expect(button('Save app token').disabled).toBe(true);
  enterAppToken(' xapp-1-A0APP-123-secret ');
  expect(button('Save app token').disabled).toBe(false);
  await act(async () => {
    button('Save app token').click();
    await Promise.resolve();
  });
  expect(api.setAppToken).toHaveBeenCalledWith({
    connectionId: 'slack-1',
    appToken: 'xapp-1-A0APP-123-secret',
  });
  expect(appTokenInput()).toBeNull();
  expect(document.body.textContent).toContain('Saved the app-level token for Purplefish');
  act(() => button('Replace app token').click());
  expect(appTokenInput()?.value).toBe('');
});

it('keeps the app-token draft and shows the error when saving fails', async () => {
  api.setAppToken.mockRejectedValue(
    new Error('This app-level token belongs to a different Slack app than the bot token.')
  );
  savedConnection();
  act(() => button('Add app token').click());
  enterAppToken('xapp-1-secret');
  await act(async () => {
    button('Save app token').click();
    await Promise.resolve();
  });
  expect(appTokenInput()?.value).toBe('xapp-1-secret');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('different Slack app');
});

it('cancels app-token entry and discards the draft', () => {
  savedConnection();
  act(() => button('Add app token').click());
  enterAppToken('xapp-1-secret');
  act(() => button('Cancel').click());
  expect(appTokenInput()).toBeNull();
  act(() => button('Add app token').click());
  expect(appTokenInput()?.value).toBe('');
});

it('removes a saved app token only after confirmation', async () => {
  savedConnection({ hasAppToken: true, appId: 'A-app' });
  act(() => button('Remove app token').click());
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain('bot token stays connected');
  expect(api.clearAppToken).not.toHaveBeenCalled();
  const confirm = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
  ].find((candidate) => candidate.textContent === 'Remove');
  await act(async () => {
    confirm?.click();
    await Promise.resolve();
  });
  expect(api.clearAppToken).toHaveBeenCalledWith({ connectionId: 'slack-1' });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.body.textContent).toContain('App-level token removed');
});

it('warns that disconnect also removes the app token', () => {
  savedConnection({ hasAppToken: true, appId: 'A-app' });
  act(() => button('Disconnect').click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('app-level token');
});

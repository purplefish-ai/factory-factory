// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BROWSER_NOTIFICATIONS_KEY,
  writeBrowserNotificationsEnabled,
} from '@/client/lib/browser-notifications';
import { NotificationSettingsSection } from './NotificationSettingsSection';

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    userSettings: {
      get: { useQuery: () => ({ data: { playSoundOnComplete: true }, isLoading: false }) },
      update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ userSettings: { get: { invalidate: vi.fn() } } }),
  },
}));
let root: Root;
let container: HTMLDivElement;
const requestPermission = vi.fn();
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  requestPermission.mockResolvedValue('granted');
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render() {
  act(() => root.render(<NotificationSettingsSection />));
}
function toggle() {
  const button = container.querySelector<HTMLButtonElement>('#desktop-notifications-toggle');
  expect(button).not.toBeNull();
  return button!;
}
it('requests permission synchronously from the enable gesture and saves only after grant', async () => {
  let grant!: (permission: NotificationPermission) => void;
  requestPermission.mockImplementation(
    () =>
      new Promise<NotificationPermission>((resolve) => {
        grant = resolve;
      })
  );
  render();
  expect(requestPermission).not.toHaveBeenCalled();
  act(() => {
    toggle().click();
    expect(requestPermission).toHaveBeenCalledOnce();
  });
  expect(localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBeNull();
  expect(toggle().disabled).toBe(true);
  await act(async () => grant('granted'));
  expect(localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBe('true');
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  act(() => toggle().click());
  expect(localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBe('false');
  expect(requestPermission).toHaveBeenCalledOnce();
});
it('explains blocked permissions and unsupported browsers without prompting', () => {
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission });
  render();
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain('browser settings');
  vi.stubGlobal('Notification', undefined);
  render();
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(container.textContent).toContain("This browser doesn't support desktop notifications");
  expect(toggle().disabled).toBe(true);
  expect(requestPermission).not.toHaveBeenCalled();
});
it('keeps notifications off and offers an error after a rejected permission request', async () => {
  requestPermission.mockRejectedValue(new Error('Permission API failed'));
  render();
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't enable notifications"
  );
});
it('synchronizes same-window and other-tab changes and rejects malformed preferences', () => {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, '"true"');
  render();
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  act(() => writeBrowserNotificationsEnabled(true));
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, 'false');
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_NOTIFICATIONS_KEY }));
  });
  expect(toggle().getAttribute('aria-checked')).toBe('false');
});

it('reports storage failures without pretending the opt-in was saved', async () => {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage denied');
  });
  render();
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't enable notifications"
  );
});
it('keeps the switch off when permission is dismissed or denied', async () => {
  requestPermission.mockResolvedValue('default');
  render();
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(container.textContent).toContain("Notifications weren't enabled");
  requestPermission.mockResolvedValue('denied');
  await act(async () => toggle().click());
  expect(toggle().disabled).toBe(true);
  expect(localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBeNull();
});

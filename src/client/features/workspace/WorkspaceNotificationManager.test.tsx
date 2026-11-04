// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceNotificationManager } from './WorkspaceNotificationManager';

const mocks = vi.hoisted(() => ({
  sound: vi.fn(),
  navigate: vi.fn(),
  fetch: vi.fn(),
  project: vi.fn(),
  settings: { data: { playSoundOnComplete: true }, isSuccess: true },
}));
vi.mock('@/client/lib/sound', () => ({ playSound: mocks.sound }));
vi.mock('react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    userSettings: { get: { useQuery: () => mocks.settings } },
    useUtils: () => ({
      workspace: { get: { fetch: mocks.fetch } },
      project: { getById: { fetch: mocks.project } },
    }),
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const notices: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn().mockResolvedValue('granted');
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions
  ) {
    notices.push(this);
  }
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(window, 'focus').mockImplementation(() => undefined);
  localStorage.clear();
  notices.length = 0;
  vi.clearAllMocks();
  FakeNotification.permission = 'granted';
  mocks.settings = { data: { playSoundOnComplete: true }, isSuccess: true };
  mocks.fetch.mockResolvedValue({ id: 'ws-1', projectId: 'project-1' });
  mocks.project.mockResolvedValue({ slug: 'real project' });
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(<WorkspaceNotificationManager />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function emit(
  detail: unknown = {
    workspaceId: 'ws-1',
    workspaceName: 'Same name',
    sessionCount: 1,
    finishedAt: '2026-11-04T00:00:00Z',
  }
) {
  act(() => {
    window.dispatchEvent(new CustomEvent('workspace-notification-request', { detail }));
  });
}
it('defaults browser notifications off even when browser permission is granted', () => {
  emit();
  expect(mocks.sound).toHaveBeenCalledOnce();
  expect(notices).toHaveLength(0);
});
it('never asks for permission in response to a background completion', () => {
  FakeNotification.permission = 'default';
  emit();
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
});
it('ignores malformed events and deduplicates workspace completion sounds', () => {
  emit(null);
  emit({ workspaceId: 'ws-1' });
  expect(mocks.sound).not.toHaveBeenCalled();
  emit();
  emit();
  expect(mocks.sound).toHaveBeenCalledOnce();
});
it('uses workspace identity for tags and resolves its real owner on click', async () => {
  localStorage.setItem('factoryfactory_browser_notifications_enabled', 'true');
  emit();
  const notice = notices[0]!;
  expect(notice.options.tag).toBe('workspace-complete-ws-1');
  await act(async () => {
    notice.onclick?.();
    await Promise.resolve();
  });
  expect(notice.close).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  expect(mocks.fetch).toHaveBeenCalledWith({ id: 'ws-1' });
  expect(mocks.navigate).toHaveBeenCalledWith('/projects/real%20project/workspaces/ws-1');
});
it('keeps voice suppression and server sound preferences independent of desktop notifications', () => {
  window.dispatchEvent(new CustomEvent('voice-mode-changed', { detail: { active: true } }));
  emit();
  expect(mocks.sound).not.toHaveBeenCalled();
});

it('remembers completion identities even when an older completion is replayed later', () => {
  emit();
  emit({
    workspaceId: 'ws-1',
    workspaceName: 'Same name',
    sessionCount: 1,
    finishedAt: '2026-11-05T00:00:00Z',
  });
  emit();
  expect(mocks.sound).toHaveBeenCalledTimes(2);
});
it('distinguishes workspaces that share a name and closes/focuses before awaiting network work', async () => {
  localStorage.setItem('factoryfactory_browser_notifications_enabled', 'true');
  emit();
  emit({
    workspaceId: 'ws-2',
    workspaceName: 'Same name',
    sessionCount: 1,
    finishedAt: '2026-11-04T00:00:00Z',
  });
  expect(notices.map((notice) => notice.options.tag)).toEqual([
    'workspace-complete-ws-1',
    'workspace-complete-ws-2',
  ]);
  mocks.fetch.mockRejectedValue(new Error('Workspace deleted'));
  await act(async () => {
    notices[0]?.onclick?.();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(notices[0]?.close).toHaveBeenCalledOnce();
    await Promise.resolve();
  });
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("Couldn't open the workspace.", expect.any(Object));
});
it.each([false, true])(
  'does not chime when sound is disabled or settings are still loading: %s',
  (loaded) => {
    mocks.settings = { data: { playSoundOnComplete: false }, isSuccess: loaded };
    act(() => root.render(<WorkspaceNotificationManager />));
    emit();
    expect(mocks.sound).not.toHaveBeenCalled();
  }
);

it('invokes the desktop focus bridge before resolving notification navigation', async () => {
  const focusWindow = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { isElectron: true, focusWindow });
  localStorage.setItem('factoryfactory_browser_notifications_enabled', 'true');
  emit();
  await act(async () => {
    notices[0]?.onclick?.();
    expect(focusWindow).toHaveBeenCalledOnce();
    await Promise.resolve();
  });
  expect(mocks.navigate).toHaveBeenCalledOnce();
});

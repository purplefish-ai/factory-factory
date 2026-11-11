// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { CHUNK_LOAD_ERROR_TOAST_ID, installChunkLoadRecovery } from './chunk-load-recovery';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  toastError.mockReset();
});

function dispatchPreloadError() {
  const event = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

it('offers one persistent reload toast for failed chunks and lets the import reject', () => {
  uninstall = installChunkLoadRecovery();

  const first = dispatchPreloadError();
  dispatchPreloadError();

  // Not cancelled, so Vite rethrows and the nearest boundary shows the failure.
  expect(first.defaultPrevented).toBe(false);
  expect(toastError).toHaveBeenCalledTimes(2);
  expect(toastError).toHaveBeenLastCalledWith("Couldn't load part of the app.", {
    id: CHUNK_LOAD_ERROR_TOAST_ID,
    description: 'Factory Factory may have been updated. Reload to get the latest version.',
    duration: Number.POSITIVE_INFINITY,
    action: { label: 'Reload', onClick: expect.any(Function) },
  });
});

it('reloads the window from the toast action', () => {
  const reload = vi.fn();
  const target = Object.assign(new EventTarget(), { location: { reload } });
  uninstall = installChunkLoadRecovery(target as unknown as Window);
  target.dispatchEvent(new Event('vite:preloadError'));

  const options = toastError.mock.calls[0]?.[1] as { action: { onClick: () => void } };
  options.action.onClick();
  expect(reload).toHaveBeenCalledOnce();
});

it('stops listening when uninstalled', () => {
  installChunkLoadRecovery()();
  dispatchPreloadError();
  expect(toastError).not.toHaveBeenCalled();
});

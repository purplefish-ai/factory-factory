import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_TOAST_DURATION_MS,
  installErrorToastDefaults,
  withErrorToastDefaults,
} from './sonner';

describe('error toast defaults', () => {
  it('adds a longer duration and a close button', () => {
    expect(withErrorToastDefaults({ description: 'detail' })).toEqual({
      description: 'detail',
      duration: ERROR_TOAST_DURATION_MS,
      closeButton: true,
    });
    expect(ERROR_TOAST_DURATION_MS).toBeGreaterThan(4000);
  });

  it('keeps explicit duration and closeButton options', () => {
    expect(
      withErrorToastDefaults({ duration: Number.POSITIVE_INFINITY, closeButton: false })
    ).toEqual({ duration: Number.POSITIVE_INFINITY, closeButton: false });
  });

  it('wraps toast.error once and leaves other toast types alone', () => {
    const error = vi.fn<typeof toast.error>(() => 1);
    const success = vi.fn<(message: string) => void>();
    const api = { error, success };

    installErrorToastDefaults(api);
    installErrorToastDefaults(api);
    api.error('Something failed', { description: 'Server detail' });
    api.success('Saved');

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Something failed', {
      description: 'Server detail',
      duration: ERROR_TOAST_DURATION_MS,
      closeButton: true,
    });
    expect(success).toHaveBeenCalledWith('Saved');
  });

  it('installs the defaults on the shared sonner toast when imported', () => {
    const id = toast.error('Patched');
    const shown = toast.getToasts().find((item) => item.id === id);
    expect(shown).toMatchObject({
      type: 'error',
      duration: ERROR_TOAST_DURATION_MS,
      closeButton: true,
    });
    const successId = toast.success('Done');
    const success = toast.getToasts().find((item) => item.id === successId);
    expect(success).toMatchObject({ type: 'success' });
    expect(success).not.toHaveProperty('duration', ERROR_TOAST_DURATION_MS);
    expect(success).not.toHaveProperty('closeButton', true);
    toast.dismiss();
  });
});

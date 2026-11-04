import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_TOAST_DURATION_MS } from '@/components/ui/sonner';
import { createAppQueryClient, DEFAULT_MUTATION_ERROR_TITLE } from './query-client';

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
  Toaster: () => null,
}));

let client: QueryClient;

beforeEach(() => {
  client = createAppQueryClient();
});

afterEach(() => {
  client.clear();
  mocks.toastError.mockReset();
});

function failingObserver(
  options: ConstructorParameters<typeof MutationObserver<unknown, Error, void>>[1] = {}
) {
  return new MutationObserver<unknown, Error, void>(client, {
    mutationFn: () => Promise.reject(new Error('Server said no')),
    ...options,
  });
}

describe('app QueryClient fallback mutation error toast', () => {
  it('toasts once with a generic title for a mutation without onError', async () => {
    await expect(failingObserver().mutate()).rejects.toThrow('Server said no');

    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith(DEFAULT_MUTATION_ERROR_TITLE, {
      description: 'Server said no',
      duration: ERROR_TOAST_DURATION_MS,
      closeButton: true,
    });
  });

  it('uses meta.errorToast as the toast title', async () => {
    const observer = failingObserver({ meta: { errorToast: "Couldn't start dev server" } });
    await expect(observer.mutate()).rejects.toThrow();

    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't start dev server",
      expect.objectContaining({ description: 'Server said no' })
    );
  });

  it('stays quiet when the mutation has an options-level onError', async () => {
    const onError = vi.fn();
    await expect(failingObserver({ onError }).mutate()).rejects.toThrow();

    expect(onError).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('stays quiet when the mutation opts out with meta.errorToast = false', async () => {
    const observer = failingObserver({ meta: { errorToast: false } });
    await expect(observer.mutate()).rejects.toThrow();

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('cannot see per-call onError, which is why such call sites must opt out', async () => {
    const perCallOnError = vi.fn();
    const observer = failingObserver();
    // Per-call callbacks only run while a component is subscribed.
    const unsubscribe = observer.subscribe(() => undefined);
    await expect(observer.mutate(undefined, { onError: perCallOnError })).rejects.toThrow();
    unsubscribe();

    expect(perCallOnError).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledOnce();
  });

  it('does not toast on success', async () => {
    const observer = new MutationObserver(client, { mutationFn: () => Promise.resolve('ok') });
    await expect(observer.mutate()).resolves.toBe('ok');

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('omits the description when the error has no message', async () => {
    const observer = new MutationObserver<unknown, unknown, void>(client, {
      mutationFn: () => Promise.reject({ code: 'UNKNOWN' }),
    });
    await expect(observer.mutate()).rejects.toEqual({ code: 'UNKNOWN' });

    expect(mocks.toastError).toHaveBeenCalledWith(DEFAULT_MUTATION_ERROR_TITLE, {
      duration: ERROR_TOAST_DURATION_MS,
      closeButton: true,
    });
  });

  it('types meta.errorToast as a string or false', () => {
    failingObserver({
      // @ts-expect-error errorToast only accepts a title string or false.
      meta: { errorToast: true },
    });
  });
});

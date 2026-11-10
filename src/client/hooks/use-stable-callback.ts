import { type RefObject, useCallback, useInsertionEffect, useRef } from 'react';

/**
 * Returns a ref whose `current` is the latest committed `value`, for effects,
 * subscriptions and handlers that must read it without re-running. Do not
 * read it during render. A handler may write the value it is about to commit
 * so a second call in the same event builds on it. The write holds until this
 * component re-renders, which replaces it with the rendered value.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  // Insertion effects run before any layout effect, so a child's layout
  // effect in the same commit already sees the latest value.
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Returns a function with a permanent identity that always calls the latest
 * `callback`. Use it for event handlers passed to memoized children when the
 * handler closes over values that change every render, such as React Query
 * mutation results. Do not call the returned function during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useLatestRef(callback);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

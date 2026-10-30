import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * Returns a function with a permanent identity that always calls the latest
 * `callback`. Use it for event handlers passed to memoized children when the
 * handler closes over values that change every render, such as React Query
 * mutation results. Do not call the returned function during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  // Insertion effects run before any layout effect, so handlers called from a
  // child's layout effect in the same commit already see the latest callback.
  useInsertionEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

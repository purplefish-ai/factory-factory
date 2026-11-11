import { useEffect, useState } from 'react';

/**
 * Returns `value` once it has stopped changing for `delayMs`. Values are
 * primitives, compared by identity, so an inline object cannot loop. While
 * `immediate` is true the current value is returned at once, for example to
 * clear a search when its dialog closes.
 */
export function useDebouncedValue<T extends string | number | boolean | null | undefined>(
  value: T,
  delayMs: number,
  { immediate = false }: { immediate?: boolean } = {}
): T {
  const [debounced, setDebounced] = useState(value);
  if (immediate && !Object.is(debounced, value)) {
    setDebounced(value);
  }
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return immediate ? value : debounced;
}

import { useEffect } from 'react';

interface UseTextareaResizeOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onHeightChange?: () => void;
  debounceMs?: number;
}

/**
 * Watches textarea height changes (from field-sizing: content) and notifies parent.
 * Debounces to avoid excessive scroll calculations during rapid typing.
 */
export function useTextareaResize({
  textareaRef,
  onHeightChange,
  debounceMs = 50,
}: UseTextareaResizeOptions): void {
  useEffect(() => {
    const textarea = textareaRef?.current;
    if (!(textarea && onHeightChange)) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      // Debounce to reduce scroll thrashing during rapid typing
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        onHeightChange();
      }, debounceMs);
    });

    observer.observe(textarea);

    return () => {
      observer.disconnect();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [textareaRef, onHeightChange, debounceMs]);
}

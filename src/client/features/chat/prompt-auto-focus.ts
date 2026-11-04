import { type RefObject, useEffect } from 'react';

/** Delay so the prompt's controls are rendered and focusable. */
export const PROMPT_AUTO_FOCUS_DELAY_MS = 100;

/**
 * True when no meaningful element owns focus, so an incoming prompt may take
 * it. Moving focus away from the composer (or any other control) would let a
 * Space or Enter the user was already typing activate the prompt's default
 * action, such as approving a tool call.
 */
export function isFocusUnclaimed(doc: Document = document): boolean {
  const activeElement = doc.activeElement;
  return (
    activeElement === null || activeElement === doc.body || activeElement === doc.documentElement
  );
}

/**
 * Focuses a prompt control shortly after a new request arrives, but only when
 * nothing else is focused at that moment. Mirrors the plan-approval composer
 * guard in the workspace chat content. With `selector`, focuses the first
 * matching descendant of `targetRef` instead of the element itself.
 */
export function usePromptAutoFocus(
  requestId: string | null | undefined,
  targetRef: RefObject<HTMLElement | null>,
  selector?: string
) {
  useEffect(() => {
    if (!requestId) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (!isFocusUnclaimed()) {
        return;
      }
      const target = targetRef.current;
      const focusTarget = selector ? target?.querySelector<HTMLElement>(selector) : target;
      focusTarget?.focus();
    }, PROMPT_AUTO_FOCUS_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [requestId, targetRef, selector]);
}

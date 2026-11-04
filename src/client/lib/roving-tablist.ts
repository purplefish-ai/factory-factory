import type { KeyboardEvent } from 'react';

const TAB_SELECTOR = '[role="tab"]:not([aria-disabled="true"])';

/**
 * Arrow-key navigation for a `role="tablist"` (WAI-ARIA tabs pattern with
 * manual activation): ←/→ move focus between tabs, wrapping at the ends, and
 * Home/End jump to the first and last tab. Enter or Space on a tab selects it.
 * Pair it with a roving tabindex: only the selected tab has `tabIndex={0}`, so
 * the tablist is a single Tab stop.
 */
export function handleTablistKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>(TAB_SELECTOR)];
  const current = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
  const index = tabs.findIndex((tab) => tab === current);
  if (index < 0 || tabs.length === 0) {
    return;
  }
  const targetIndex = getTargetIndex(event.key, index, tabs.length);
  if (targetIndex === null) {
    return;
  }
  event.preventDefault();
  const target = tabs[targetIndex];
  target?.focus();
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function getTargetIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

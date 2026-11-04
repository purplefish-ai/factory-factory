import { useLayoutEffect, useRef } from 'react';
import { matchesShortcut } from '@/client/lib/keyboard-shortcuts';

const TABS = '[role="tab"]:not([aria-disabled="true"])';

/** Preserve roving focus and recover an adjacent tab after a keyboard close. */
export function useTablistFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) {
      return;
    }
    let tabs = [...root.querySelectorAll<HTMLElement>(TABS)];
    let focused: HTMLElement | null = null;
    let closing: HTMLElement | null = null;
    let restoreTimer: number | undefined;
    const rove = (tab: HTMLElement) => {
      const group = tab.closest('[role="tablist"]');
      for (const item of group?.querySelectorAll<HTMLElement>(TABS) ?? []) {
        const index = item === tab ? 0 : -1;
        if (item.tabIndex !== index) {
          item.tabIndex = index;
        }
      }
    };
    const focus = (event: FocusEvent) => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLElement>(TABS) : null;
      if (!(tab && root.contains(tab))) {
        if (!closing) {
          focused = null;
        }
        return;
      }
      focused = tab;
      closing = null;
      rove(tab);
    };
    const blur = (event: FocusEvent) => {
      if (closing) {
        return;
      }
      const destination = event.relatedTarget;
      if (
        (destination instanceof Node && !root.contains(destination)) ||
        (!destination && focused?.isConnected)
      ) {
        focused = null;
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element && matchesShortcut(event, 'tabs.close'))) {
        return;
      }
      const tab = event.target.closest<HTMLElement>(TABS);
      if (tab?.hasAttribute('aria-keyshortcuts')) {
        closing = tab;
      }
    };
    const observer = new MutationObserver(() => {
      const nextTabs = [...root.querySelectorAll<HTMLElement>(TABS)];
      if (focused && !root.contains(focused)) {
        const index = tabs.indexOf(focused);
        const target = nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)];
        // Dialog close autofocus can settle after the tab is removed. Wait one
        // task, and never take focus from another control or a newer dialog.
        restoreTimer = window.setTimeout(() => {
          if (root.isConnected && target?.isConnected && document.activeElement === document.body) {
            target.focus();
          }
        }, 0);
        focused = null;
        closing = null;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active) && active.matches(TABS)) {
        rove(active);
      }
      tabs = nextTabs;
    });
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', blur);
    root.addEventListener('keydown', key, true);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['tabindex', 'aria-disabled'],
    });
    return () => {
      observer.disconnect();
      window.clearTimeout(restoreTimer);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', blur);
      root.removeEventListener('keydown', key, true);
    };
  }, []);
  return ref;
}

import type { RefObject, UIEvent } from 'react';
import { useCallback, useEffect } from 'react';

import type { ScrollMode } from './scroll-state';
import { useWorkspacePanel } from './workspace-panel-context';

interface UsePersistentScrollOptions {
  tabId: string | null;
  mode: ScrollMode;
  viewportRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  restoreDeps?: unknown[];
  autoStickToBottom?: boolean;
  stickToBottomThreshold?: number;
  onRestore?: () => void;
}

export function usePersistentScroll({
  tabId,
  mode,
  viewportRef,
  enabled = true,
  restoreDeps = [],
  autoStickToBottom = false,
  stickToBottomThreshold = 150,
  onRestore,
}: UsePersistentScrollOptions) {
  const { getScrollState, setScrollState } = useWorkspacePanel();

  const buildScrollState = useCallback(
    (viewport: HTMLDivElement) => {
      if (!autoStickToBottom) {
        return { top: viewport.scrollTop, left: viewport.scrollLeft };
      }

      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const stickToBottom = distanceFromBottom < stickToBottomThreshold;

      return { top: viewport.scrollTop, left: viewport.scrollLeft, stickToBottom };
    },
    [autoStickToBottom, stickToBottomThreshold]
  );

  const persistCurrent = useCallback(
    (overrideTabId?: string) => {
      const resolvedTabId = overrideTabId ?? tabId;
      const shouldPersist = overrideTabId ? true : enabled;
      if (!(shouldPersist && resolvedTabId)) {
        return;
      }
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }
      setScrollState(resolvedTabId, mode, buildScrollState(viewport));
    },
    [buildScrollState, enabled, mode, setScrollState, tabId, viewportRef]
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!(enabled && tabId)) {
        return;
      }
      const viewport = event.currentTarget;
      setScrollState(tabId, mode, buildScrollState(viewport));
    },
    [buildScrollState, enabled, mode, setScrollState, tabId]
  );

  useEffect(() => {
    if (!(enabled && tabId)) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const saved = getScrollState(tabId, mode);
    const handle = requestAnimationFrame(() => {
      const currentViewport = viewportRef.current;
      if (!currentViewport) {
        return;
      }
      if (autoStickToBottom && (!saved || saved.stickToBottom)) {
        currentViewport.scrollTop = currentViewport.scrollHeight;
        if (!saved) {
          setScrollState(tabId, mode, {
            top: currentViewport.scrollTop,
            left: currentViewport.scrollLeft,
            stickToBottom: true,
          });
        }
        onRestore?.();
        return;
      }
      if (!saved) {
        onRestore?.();
        return;
      }
      const maxTop = Math.max(0, currentViewport.scrollHeight - currentViewport.clientHeight);
      const maxLeft = Math.max(0, currentViewport.scrollWidth - currentViewport.clientWidth);
      currentViewport.scrollTop = Math.min(Math.max(0, saved.top), maxTop);
      currentViewport.scrollLeft = Math.min(Math.max(0, saved.left), maxLeft);
      onRestore?.();
    });
    return () => cancelAnimationFrame(handle);
  }, [
    autoStickToBottom,
    enabled,
    getScrollState,
    mode,
    onRestore,
    setScrollState,
    tabId,
    viewportRef,
    ...restoreDeps,
  ]);

  return { handleScroll, persistCurrent };
}

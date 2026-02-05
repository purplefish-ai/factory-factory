import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';

/**
 * Hook for managing auto-scroll behavior with RAF throttling.
 * Optimized for virtualized lists - doesn't require contentRef.
 */
export function useAutoScroll(viewportRef: RefObject<HTMLDivElement | null>) {
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  // Track if we're currently animating a scroll-to-bottom to prevent flicker
  const isScrollingToBottomRef = useRef(false);
  // RAF throttle flag
  const rafPendingRef = useRef(false);

  // Throttled scroll handler using requestAnimationFrame
  const onScroll = useCallback(() => {
    // Don't update state while animating scroll-to-bottom (prevents flicker)
    if (isScrollingToBottomRef.current) {
      return;
    }

    // Skip if we already have a pending RAF
    if (rafPendingRef.current) {
      return;
    }

    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;

      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      // Increased threshold for better UX - don't hide scroll button too early
      const scrollThreshold = 150;
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nearBottom = distanceFromBottom < scrollThreshold;

      // Only update state if it changed
      if (nearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = nearBottom;
        setIsNearBottom(nearBottom);
      }
    });
  }, [viewportRef]);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // Set flag to prevent onScroll from causing flicker during animation
    isScrollingToBottomRef.current = true;
    setIsNearBottom(true);
    isNearBottomRef.current = true;

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: 'smooth',
    });

    // Clear the flag after animation completes (smooth scroll typically ~300-500ms)
    setTimeout(() => {
      isScrollingToBottomRef.current = false;
    }, 500);
  }, [viewportRef]);

  return { onScroll, isNearBottom, scrollToBottom };
}

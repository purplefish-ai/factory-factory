import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';

const NEAR_BOTTOM_ENTER_THRESHOLD = 24;
const NEAR_BOTTOM_EXIT_THRESHOLD = 48;

function isWithinFollowThreshold(distanceFromBottom: number, wasNearBottom: boolean): boolean {
  const threshold = wasNearBottom ? NEAR_BOTTOM_EXIT_THRESHOLD : NEAR_BOTTOM_ENTER_THRESHOLD;
  return distanceFromBottom <= threshold;
}

/**
 * Hook for managing auto-scroll behavior with RAF throttling.
 * Optimized for virtualized lists - doesn't require contentRef.
 */
export function useAutoScroll(viewportRef: RefObject<HTMLDivElement | null>) {
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  // RAF throttle flag
  const rafPendingRef = useRef(false);

  // Throttled scroll handler using requestAnimationFrame
  const onScroll = useCallback(() => {
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

      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nearBottom = isWithinFollowThreshold(distanceFromBottom, isNearBottomRef.current);

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

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: 'auto',
    });

    // Keep follow mode active and hide the CTA after manual jump.
    setIsNearBottom(true);
    isNearBottomRef.current = true;
  }, [viewportRef]);

  return { onScroll, isNearBottom, scrollToBottom };
}

import { useEffect, useState } from 'react';

/** Distance from the end, in pixels, that still counts as being at the end. */
const FOLLOW_THRESHOLD_PX = 8;

function isAtEnd(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= FOLLOW_THRESHOLD_PX;
}

/**
 * Keeps a scrolling log at its end while its content changes, but only while
 * the user is at the end: scrolling up stops following and scrolling back to
 * the end resumes it. The view starts at the end. Attach the returned
 * callback ref to the scrolling element.
 *
 * Scrolls follow the element's CSS `scroll-behavior` (`scroll-smooth`).
 *
 * Plain logs only need this rule. The chat transcript keeps its own scroll
 * controller because it also restores saved positions in a virtualized list.
 */
export function useFollowOutput() {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!viewport) {
      return;
    }
    let following = true;
    let lastTop = viewport.scrollTop;
    const scrollToEnd = () => {
      if (!isAtEnd(viewport)) {
        viewport.scrollTop = viewport.scrollHeight;
        lastTop = viewport.scrollTop;
      }
    };
    const updateFollowing = () => {
      const top = viewport.scrollTop;
      // A smooth scroll toward the end moves down without reaching it on
      // every event, so only upward movement stops following.
      if (isAtEnd(viewport)) {
        following = true;
      } else if (top < lastTop) {
        following = false;
      }
      lastTop = top;
    };
    // Mutation callbacks run after React commits and before the next paint. A
    // scroll up can land before its scroll event, so check the position first.
    const observer = new MutationObserver(() => {
      updateFollowing();
      if (following) {
        scrollToEnd();
      }
    });
    scrollToEnd();
    viewport.addEventListener('scroll', updateFollowing, { passive: true });
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    return () => {
      viewport.removeEventListener('scroll', updateFollowing);
      observer.disconnect();
    };
  }, [viewport]);

  return setViewport;
}

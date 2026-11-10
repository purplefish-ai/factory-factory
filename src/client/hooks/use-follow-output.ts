import { useEffect, useState } from 'react';

/** Distance from the end, in pixels, that still counts as being at the end. */
const FOLLOW_THRESHOLD_PX = 8;

function isAtEnd(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= FOLLOW_THRESHOLD_PX;
}

function unobserveRemoved(observer: ResizeObserver, records: MutationRecord[]) {
  for (const record of records) {
    for (const node of record.removedNodes) {
      if (node instanceof Element) {
        observer.unobserve(node);
      }
    }
  }
}

/**
 * Keeps a scrolling log at its end while its content changes, but only while
 * the user is at the end: scrolling up stops following and scrolling back to
 * the end resumes it. The view starts at the end. Attach the returned
 * callback ref to the scrolling element.
 *
 * Content changes are DOM mutations and size changes: a narrower view rewraps
 * long lines without touching the DOM, so the element and its children are
 * also watched with `ResizeObserver` where the browser provides it.
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
    const follow = () => {
      updateFollowing();
      if (following) {
        scrollToEnd();
      }
    };
    // jsdom has no ResizeObserver; mutations still drive following there.
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    // Observing an element twice is a no-op, so re-observe children as they
    // arrive, and drop removed ones so a trimmed log does not keep them alive.
    const observeSizes = () => {
      resizeObserver?.observe(viewport);
      for (const child of viewport.children) {
        resizeObserver?.observe(child);
      }
    };
    const observer = new MutationObserver((records) => {
      if (resizeObserver) {
        unobserveRemoved(resizeObserver, records);
      }
      observeSizes();
      follow();
    });
    scrollToEnd();
    viewport.addEventListener('scroll', updateFollowing, { passive: true });
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    observeSizes();
    return () => {
      viewport.removeEventListener('scroll', updateFollowing);
      observer.disconnect();
      resizeObserver?.disconnect();
    };
  }, [viewport]);

  return setViewport;
}

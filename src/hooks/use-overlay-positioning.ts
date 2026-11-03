import { useSyncExternalStore } from 'react';

type CollisionPadding = number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>;

interface WindowControlsOverlay extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

function getOverlay() {
  return typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
        .windowControlsOverlay;
}

function subscribe(onChange: () => void) {
  const overlay = getOverlay();
  overlay?.addEventListener('geometrychange', onChange);
  return () => overlay?.removeEventListener('geometrychange', onChange);
}

function getTitlebarBottom() {
  const overlay = getOverlay();
  if (!overlay?.visible) {
    return 0;
  }
  const rect = overlay.getTitlebarAreaRect();
  return rect.y + rect.height;
}

export function useTitlebarBottom() {
  return useSyncExternalStore(subscribe, getTitlebarBottom, () => 0);
}

// Radix otherwise allows portalled popups into the browser-owned title bar.
export function useOverlayPositioning(
  padding: CollisionPadding = 0,
  sticky: 'partial' | 'always' = 'partial'
) {
  const top = useTitlebarBottom();
  if (top === 0) {
    return { collisionPadding: padding, sticky };
  }
  const sides =
    typeof padding === 'number'
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : padding;
  return {
    collisionPadding: { ...sides, top: top + (sides.top ?? 0) },
    // A title-bar trigger lies outside the safe area. Partial stickiness would
    // tether its tooltip to that trigger and pull it back into native controls.
    sticky: 'always' as const,
  };
}

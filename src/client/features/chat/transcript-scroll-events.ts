import type { TranscriptScrollController } from './transcript-scroll-controller';

type Controller = Pick<
  TranscriptScrollController,
  'beginInteraction' | 'endInteraction' | 'userScrolled'
>;

/**
 * Pinned virtual-core 3.19.9: commands/reconciliation specify behavior, while
 * hold flushes and clamp retries omit it (and may also omit adjustments).
 * Keep the engine characterization tests when upgrading this dependency.
 */
export function isNativeCompensation(options: { behavior?: ScrollBehavior; adjustments?: number }) {
  return options.adjustments !== undefined || options.behavior === undefined;
}

/** Observe real movement and synchronously journal every native write/read-back. */
export function observeTranscriptScroll(viewport: HTMLDivElement, controller: Controller) {
  const snapshot = () => ({
    top: Math.max(0, viewport.scrollTop),
    max: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    left: viewport.scrollLeft,
  });
  let observed = snapshot();
  let inputEpoch = 0;
  let lastWrite: { top: number; left: number; epoch: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedInteraction = false;
  let touchMomentum = false;
  const held = new Set<'touch' | 'pointer'>();
  const touchContacts = new Set<number>();
  const finish = () => {
    clearTimeout(timer);
    timedInteraction = false;
    touchMomentum = false;
    if (held.size === 0) {
      controller.endInteraction();
    }
  };
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(finish, 150);
  };
  const begin = (direction: 'up' | 'down' | 'unknown', timed: boolean) => {
    inputEpoch++;
    if (timed) {
      timedInteraction = true;
    }
    controller.beginInteraction(direction);
    if (timed) {
      refresh();
    }
  };
  const observe = () => {
    const next = snapshot();
    const delta = next.top - observed.top;
    const ownWrite =
      lastWrite?.epoch === inputEpoch &&
      Math.abs(lastWrite.top - next.top) <= 1 &&
      lastWrite.left === next.left;
    const clamped =
      next.max !== observed.max && Math.abs(next.top - Math.min(observed.top, next.max)) <= 1;
    observed = next;
    // Tiny momentum steps still prove that the user's timed episode is active.
    // Keep the jitter threshold below for intent changes, not for ownership.
    if (delta !== 0 && !ownWrite && !clamped && timedInteraction) {
      refresh();
    }
    // Scroll events also report resize clamps, browser anchoring and virtual
    // row corrections. Only movement during user input can change intent.
    if (Math.abs(delta) <= 1 || ownWrite || clamped || (!timedInteraction && held.size === 0)) {
      return false;
    }
    controller.userScrolled(delta < 0 ? 'up' : 'down', Math.max(0, next.max - next.top));
    return true;
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY !== 0 && !event.ctrlKey) {
      begin(event.deltaY < 0 ? 'up' : 'down', true);
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest('input,textarea,select,[contenteditable="true"]')
    ) {
      return;
    }
    const up =
      ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
    const down = ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
    if (up || down) {
      begin(up ? 'up' : 'down', true);
    }
  };
  const touch = (event: TouchEvent) => {
    for (const contact of Array.from(event.changedTouches ?? [])) {
      touchContacts.add(contact.identifier);
    }
    held.add('touch');
    begin('unknown', false);
  };
  const releaseTouch = (event: TouchEvent) => {
    for (const contact of Array.from(event.changedTouches ?? [])) {
      touchContacts.delete(contact.identifier);
    }
    if (touchContacts.size > 0) {
      return;
    }
    held.delete('touch');
    if (held.size === 0) {
      // Touch scrolling can continue after release. Keep ownership through
      // momentum, refreshing the idle timeout on each actual movement.
      timedInteraction = true;
      touchMomentum = true;
      refresh();
    }
  };
  const releasePointer = () => {
    held.delete('pointer');
    if (!timedInteraction && held.size === 0) {
      controller.endInteraction();
    }
  };
  const scrollEnd = () => {
    // scrollend carries no gesture identity: an older command's event can
    // arrive after touch release. Only idle time can end touch momentum.
    if (timedInteraction && !touchMomentum) {
      finish();
    }
  };
  const pointer = (event: PointerEvent) => {
    const rect = viewport.getBoundingClientRect();
    if (event.target === viewport && event.clientX >= rect.right - 16) {
      held.add('pointer');
      begin('unknown', false);
    }
  };
  viewport.addEventListener('scroll', observe, { passive: true, capture: true });
  viewport.addEventListener('wheel', wheel, { passive: true, capture: true });
  viewport.addEventListener('keydown', key, true);
  viewport.addEventListener('touchstart', touch, { passive: true });
  viewport.addEventListener('touchend', releaseTouch, { passive: true });
  viewport.addEventListener('touchcancel', releaseTouch, { passive: true });
  viewport.addEventListener('pointerdown', pointer, { passive: true });
  viewport.addEventListener('scrollend', scrollEnd, { passive: true });
  window.addEventListener('pointerup', releasePointer, { passive: true });
  window.addEventListener('pointercancel', releasePointer, { passive: true });
  return {
    write(write: () => void, compensation = false) {
      const moved = observe();
      if (moved && !compensation) {
        return;
      }
      write();
      observed = snapshot();
      lastWrite = { ...observed, epoch: inputEpoch };
    },
    dispose() {
      clearTimeout(timer);
      viewport.removeEventListener('scroll', observe, true);
      viewport.removeEventListener('wheel', wheel, true);
      viewport.removeEventListener('keydown', key, true);
      viewport.removeEventListener('touchstart', touch);
      viewport.removeEventListener('touchend', releaseTouch);
      viewport.removeEventListener('touchcancel', releaseTouch);
      viewport.removeEventListener('pointerdown', pointer);
      viewport.removeEventListener('scrollend', scrollEnd);
      window.removeEventListener('pointerup', releasePointer);
      window.removeEventListener('pointercancel', releasePointer);
    },
  };
}

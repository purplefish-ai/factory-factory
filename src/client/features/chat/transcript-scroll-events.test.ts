// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { isNativeCompensation, observeTranscriptScroll } from './transcript-scroll-events';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
function harness() {
  vi.useFakeTimers();
  const viewport = document.createElement('div');
  document.body.append(viewport);
  Object.defineProperties(viewport, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 1000, configurable: true },
  });
  viewport.scrollTop = 500;
  const controller = { beginInteraction: vi.fn(), endInteraction: vi.fn(), userScrolled: vi.fn() };
  const observer = observeTranscriptScroll(viewport, controller);
  return { viewport, controller, observer };
}
it('recognizes delayed and coalesced native write readbacks', () => {
  const h = harness();
  h.observer.write(() => {
    h.viewport.scrollTop = 200;
  });
  h.observer.write(() => {
    h.viewport.scrollTop = 300;
  });
  h.viewport.dispatchEvent(new Event('scroll'));
  h.viewport.dispatchEvent(new Event('scroll'));
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  h.observer.dispose();
});
it('takes over for movement before a queued absolute write, but allows native compensation', () => {
  const h = harness();
  const write = vi.fn();
  h.viewport.scrollTop = 100;
  h.observer.write(write);
  expect(h.controller.userScrolled).toHaveBeenCalledWith('up', 400);
  expect(write).not.toHaveBeenCalled();
  h.observer.write(write, true);
  expect(write).toHaveBeenCalledOnce();
  h.observer.dispose();
});
it('expires boundary wheel input even when no scroll event occurs', () => {
  const h = harness();
  h.viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
  expect(h.controller.beginInteraction).toHaveBeenCalledWith('down');
  vi.advanceTimersByTime(150);
  expect(h.controller.endInteraction).toHaveBeenCalledOnce();
  h.observer.dispose();
});
it('stationary touch only interrupts and resumes, while actual upward movement reads', () => {
  const h = harness();
  h.viewport.dispatchEvent(new Event('touchstart'));
  expect(h.controller.beginInteraction).toHaveBeenCalledWith('unknown');
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  h.viewport.scrollTop = 400;
  h.viewport.dispatchEvent(new Event('scroll'));
  expect(h.controller.userScrolled).toHaveBeenCalledWith('up', 100);
  h.viewport.dispatchEvent(new Event('touchend'));
  expect(h.controller.endInteraction).toHaveBeenCalledOnce();
  h.observer.dispose();
});

it('a queued scrollend cannot release a held touch interaction', () => {
  const h = harness();
  h.viewport.dispatchEvent(new Event('touchstart'));
  h.viewport.dispatchEvent(new Event('scrollend'));
  vi.advanceTimersByTime(500);
  expect(h.controller.endInteraction).not.toHaveBeenCalled();
  h.viewport.dispatchEvent(new Event('touchend'));
  expect(h.controller.endInteraction).toHaveBeenCalledOnce();
  h.observer.dispose();
});

it('preserves native deferred/clamped compensation without adjustments after delayed user movement', () => {
  const h = harness();
  h.viewport.scrollTop = 100;
  h.observer.write(() => {
    h.viewport.scrollTop += 200;
  }, isNativeCompensation({}));
  expect(h.viewport.scrollTop).toBe(300);
  expect(h.controller.userScrolled).toHaveBeenCalledExactlyOnceWith('up', 400);
  h.viewport.dispatchEvent(new Event('scroll'));
  expect(h.controller.userScrolled).toHaveBeenCalledOnce();
  expect(isNativeCompensation({ behavior: 'instant' })).toBe(false);
  expect(isNativeCompensation({ behavior: 'auto' })).toBe(false);
  expect(isNativeCompensation({ adjustments: 20, behavior: 'instant' })).toBe(true);
  h.observer.dispose();
});
it('ignores native geometry clamping and composer keys', () => {
  const h = harness();
  Object.defineProperty(h.viewport, 'scrollHeight', { value: 700 });
  h.viewport.scrollTop = 200;
  h.viewport.dispatchEvent(new Event('scroll'));
  const input = document.createElement('textarea');
  h.viewport.append(input);
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  expect(h.controller.beginInteraction).not.toHaveBeenCalled();
  h.observer.dispose();
});
it('removes listeners and pending interaction timeout on cleanup', () => {
  const h = harness();
  h.viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  h.observer.dispose();
  h.viewport.scrollTop = 100;
  h.viewport.dispatchEvent(new Event('scroll'));
  vi.runAllTimers();
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  expect(h.controller.endInteraction).not.toHaveBeenCalled();
});

it.each([
  { key: 'ArrowUp', direction: 'up', shiftKey: false },
  { key: 'PageUp', direction: 'up', shiftKey: false },
  { key: 'Home', direction: 'up', shiftKey: false },
  { key: ' ', direction: 'up', shiftKey: true },
  { key: 'ArrowDown', direction: 'down', shiftKey: false },
  { key: 'PageDown', direction: 'down', shiftKey: false },
  { key: 'End', direction: 'down', shiftKey: false },
  { key: ' ', direction: 'down', shiftKey: false },
])('begins $direction interaction immediately for $key with shift=$shiftKey', (input) => {
  const h = harness();
  h.viewport.dispatchEvent(new KeyboardEvent('keydown', input));
  expect(h.controller.beginInteraction).toHaveBeenCalledExactlyOnceWith(input.direction);
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  vi.advanceTimersByTime(149);
  expect(h.controller.endInteraction).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.controller.endInteraction).toHaveBeenCalledOnce();
  h.observer.dispose();
});

it('leaves editable keys, shortcuts and unrelated keys to their targets', () => {
  const h = harness();
  for (const tag of ['input', 'textarea', 'select']) {
    const input = document.createElement(tag);
    h.viewport.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }));
  }
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  const text = document.createElement('span');
  editor.append(text);
  h.viewport.append(editor);
  text.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    h.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', [modifier]: true }));
  }
  h.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  vi.advanceTimersByTime(500);
  expect(h.controller.beginInteraction).not.toHaveBeenCalled();
  expect(h.controller.endInteraction).not.toHaveBeenCalled();
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  h.observer.dispose();
});

it.each([
  { finish: 'scrollend', release: 'pointerup' },
  { finish: 'scrollend', release: 'pointercancel' },
  { finish: 'timeout', release: 'pointerup' },
  { finish: 'timeout', release: 'pointercancel' },
])('holds a scrollbar through $finish until window $release', ({ finish, release }) => {
  const h = harness();
  vi.spyOn(h.viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  h.viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
  // MouseEvent supplies pointer coordinates without requiring jsdom PointerEvent support.
  h.viewport.dispatchEvent(new MouseEvent('pointerdown', { clientX: 495 }));
  expect(h.controller.beginInteraction).toHaveBeenLastCalledWith('unknown');
  if (finish === 'scrollend') {
    h.viewport.dispatchEvent(new Event('scrollend'));
  }
  vi.advanceTimersByTime(500);
  expect(h.controller.endInteraction).not.toHaveBeenCalled();
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  const queuedWrite = vi.fn();
  h.viewport.scrollTop = 300;
  h.observer.write(queuedWrite);
  expect(h.controller.userScrolled).toHaveBeenCalledExactlyOnceWith('up', 200);
  expect(queuedWrite).not.toHaveBeenCalled();
  window.dispatchEvent(new Event(release));
  expect(h.controller.endInteraction).toHaveBeenCalledOnce();
  h.observer.dispose();
});

it('does not begin interaction for ordinary viewport or child content clicks', () => {
  const h = harness();
  vi.spyOn(h.viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
  h.viewport.dispatchEvent(new MouseEvent('pointerdown', { clientX: 250 }));
  h.viewport.click();
  const button = document.createElement('button');
  h.viewport.append(button);
  button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 495 }));
  button.click();
  window.dispatchEvent(new Event('pointerup'));
  expect(h.controller.beginInteraction).not.toHaveBeenCalled();
  expect(h.controller.userScrolled).not.toHaveBeenCalled();
  h.observer.dispose();
});

import { describe, expect, it, vi } from 'vitest';
import { createTranscriptScrollController } from './transcript-scroll-controller';
import type { TranscriptPosition } from './transcript-scroll.types';

function harness(initialIntent: 'following' | 'reading' = 'following') {
  const frames = new Map<number, () => void>();
  let sequence = 0;
  const position: TranscriptPosition = {
    intent: initialIntent,
    top: 100,
    left: 0,
    anchor: { key: 'm1', offset: 7 },
  };
  const port = {
    cancelPositioning: vi.fn(),
    scrollToEnd: vi.fn(),
    capturePosition: vi.fn((intent: 'following' | 'reading') => ({ ...position, intent })),
    restorePosition: vi.fn(() => ({ measured: true, reached: true })),
    requestFrame: (callback: () => void) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelFrame: (handle: number) => {
      frames.delete(handle);
    },
  };
  const onChange = vi.fn();
  const onPositionChange = vi.fn();
  const controller = createTranscriptScrollController({
    initialIntent,
    port,
    onChange,
    onPositionChange,
  });
  const frame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  const ready = () => {
    controller.activate(null);
    frame();
    frame();
  };
  return { controller, port, onChange, onPositionChange, frames, frame, ready, position };
}

describe('transcript scroll intent', () => {
  it('coalesces burst growth without changing intent', () => {
    const h = harness();
    h.ready();
    for (let i = 0; i < 100; i++) {
      h.controller.layoutChanged();
    }
    expect(h.frames.size).toBe(1);
    h.frame();
    expect(h.port.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(h.onChange).toHaveBeenLastCalledWith({ intent: 'following', phase: 'ready' });
  });
  it('upward takeover cancels a queued pin even inside the return threshold', () => {
    const h = harness();
    h.ready();
    h.controller.layoutChanged();
    h.controller.beginInteraction('up');
    h.controller.userScrolled('up', 2);
    h.frame();
    expect(h.port.scrollToEnd).not.toHaveBeenCalled();
    expect(h.onChange).toHaveBeenLastCalledWith({ intent: 'reading', phase: 'ready' });
    h.controller.endInteraction();
    h.controller.layoutChanged();
    h.frame();
    expect(h.port.scrollToEnd).not.toHaveBeenCalled();
  });
  it('resumes only on downward user return within 24px or explicit jump', () => {
    const h = harness('reading');
    h.ready();
    h.controller.userScrolled('down', 25);
    h.frame();
    expect(h.port.scrollToEnd).not.toHaveBeenCalled();
    h.controller.userScrolled('down', 24);
    h.frame();
    expect(h.port.scrollToEnd).toHaveBeenCalledOnce();
    h.controller.userTakeover();
    h.controller.jumpToLatest();
    h.frame();
    h.frame();
    expect(h.onChange).toHaveBeenLastCalledWith({ intent: 'following', phase: 'ready' });
  });
  it('a stationary interaction cancels commands and blocks requeue without detaching', () => {
    const h = harness();
    h.ready();
    h.controller.layoutChanged();
    h.controller.beginInteraction('unknown');
    h.controller.layoutChanged();
    h.frame();
    expect(h.port.scrollToEnd).not.toHaveBeenCalled();
    expect(h.onChange).toHaveBeenLastCalledWith({ intent: 'following', phase: 'ready' });
    h.controller.endInteraction();
    h.frame();
    expect(h.port.scrollToEnd).toHaveBeenCalledOnce();
  });
  it('reading layout changes never implicitly reattach, including clamped bottom', () => {
    const h = harness('reading');
    h.ready();
    h.controller.layoutChanged();
    h.frame();
    expect(h.port.scrollToEnd).not.toHaveBeenCalled();
    expect(h.onChange).toHaveBeenLastCalledWith({ intent: 'reading', phase: 'ready' });
  });
});

describe('transcript restoration lifecycle', () => {
  it('starts a fresh restore attempt budget after a stationary interaction', () => {
    const h = harness('reading');
    h.port.restorePosition.mockReturnValue({ measured: false, reached: false });
    h.controller.activate(h.position);
    for (let i = 0; i < 11; i++) {
      h.frame();
    }
    h.controller.beginInteraction('unknown');
    h.controller.endInteraction();
    h.port.restorePosition.mockReturnValue({ measured: true, reached: true });
    h.frame();
    h.frame();
    expect(h.onPositionChange).toHaveBeenCalledOnce();
  });
  it('publishes only after two measured, reached frames, and deduplicates snapshots', () => {
    const h = harness();
    h.controller.activate(h.position);
    h.frame();
    expect(h.onPositionChange).not.toHaveBeenCalled();
    h.frame();
    expect(h.onPositionChange).toHaveBeenCalledOnce();
    h.controller.layoutChanged();
    h.frame();
    expect(h.onPositionChange).toHaveBeenCalledOnce();
  });
  it('stalls after 12 attempts, cancels native reconciliation, and wakes for measurement readiness', () => {
    const h = harness('reading');
    h.port.restorePosition.mockReturnValue({ measured: false, reached: false });
    h.controller.activate(h.position);
    for (let i = 0; i < 20; i++) {
      h.frame();
    }
    expect(h.port.restorePosition).toHaveBeenCalledTimes(12);
    expect(h.frames.size).toBe(0);
    expect(h.onPositionChange).not.toHaveBeenCalled();
    expect(h.port.cancelPositioning).toHaveBeenCalled();
    h.controller.layoutChanged();
    h.frame();
    expect(h.port.restorePosition).toHaveBeenCalledTimes(12);
    h.port.restorePosition.mockReturnValue({ measured: true, reached: true });
    h.controller.measurementReady();
    h.frame();
    h.frame();
    expect(h.onPositionChange).toHaveBeenCalledOnce();
  });
  it('retains a restore target across a stationary gesture, but yields to actual movement', () => {
    const h = harness('reading');
    h.controller.activate(h.position);
    h.controller.beginInteraction('unknown');
    h.frame();
    expect(h.port.restorePosition).not.toHaveBeenCalled();
    h.controller.endInteraction();
    h.frame();
    expect(h.port.restorePosition).toHaveBeenLastCalledWith(h.position);
    h.controller.userScrolled('up', 200);
    h.frame();
    expect(h.onChange).toHaveBeenLastCalledWith({ intent: 'reading', phase: 'ready' });
  });
  it('structural correction uses the committed live anchor, not the activation target', () => {
    const h = harness('reading');
    h.ready();
    const live = { ...h.position, anchor: { key: 'later-message', offset: 19 } };
    h.controller.structureChanged(live);
    h.frame();
    expect(h.port.restorePosition).toHaveBeenLastCalledWith(live);
    h.controller.userTakeover();
    h.frame();
    expect(h.frames.size).toBe(0);
  });
  it('suspension and disposal invalidate callbacks and prevent persistence', () => {
    const h = harness();
    h.controller.activate(null);
    const stale = [...h.frames.values()][0];
    h.controller.suspend();
    stale?.();
    expect(h.port.restorePosition).not.toHaveBeenCalled();
    expect(h.onPositionChange).not.toHaveBeenCalled();
    h.controller.activate(null);
    h.controller.dispose();
    h.frame();
    h.controller.layoutChanged();
    expect(h.frames.size).toBe(0);
    expect(h.onPositionChange).not.toHaveBeenCalled();
  });
});

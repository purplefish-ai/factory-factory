import type {
  TranscriptIntent,
  TranscriptPosition,
  TranscriptScrollPort,
  TranscriptScrollState,
} from './transcript-scroll.types';

interface Options {
  initialIntent: TranscriptIntent;
  port: TranscriptScrollPort;
  onChange: (state: TranscriptScrollState) => void;
  onPositionChange: (position: TranscriptPosition) => void;
}

/** Owns policy and cancellation; the port owns measured positioning. */
export function createTranscriptScrollController({
  initialIntent,
  port,
  onChange,
  onPositionChange,
}: Options) {
  let intent = initialIntent;
  let phase: TranscriptScrollState['phase'] = 'suspended';
  let frame: number | null = null;
  let generation = 0;
  let disposed = false;
  let interacting = false;
  let target: TranscriptPosition | null = null;
  let committed: TranscriptPosition | null = null;
  let attempts = 0;
  let stable = 0;
  let stalled = false;

  const notify = () => onChange({ intent, phase });
  const cancel = () => {
    generation++;
    if (frame !== null) {
      port.cancelFrame(frame);
    }
    frame = null;
    port.cancelPositioning();
  };
  const persist = () => {
    if (disposed || phase !== 'ready') {
      return;
    }
    const position = port.capturePosition(intent);
    if (JSON.stringify(position) === JSON.stringify(committed)) {
      return;
    }
    committed = position;
    onPositionChange(position);
  };
  const schedule = () => {
    if (disposed || phase === 'suspended' || interacting || frame !== null || stalled) {
      return;
    }
    const epoch = generation;
    frame = port.requestFrame(() => {
      if (epoch !== generation || disposed) {
        return;
      }
      frame = null;
      if (phase === 'restoring') {
        advanceRestore();
        return;
      }
      if (phase !== 'ready') {
        return;
      }
      if (intent === 'following') {
        port.scrollToEnd();
      }
      persist();
    });
  };
  const advanceRestore = () => {
    if (!target) {
      return;
    }
    const result = port.restorePosition(target);
    stable = result.measured && result.reached ? stable + 1 : 0;
    attempts++;
    if (stable >= 2) {
      target = null;
      phase = 'ready';
      notify();
      persist();
      return;
    }
    if (attempts >= 12) {
      stalled = true;
      port.cancelPositioning();
      return;
    }
    schedule();
  };
  const restore = (position: TranscriptPosition) => {
    cancel();
    target = position;
    attempts = 0;
    stable = 0;
    stalled = false;
    phase = 'restoring';
    notify();
    schedule();
  };
  const wake = () => {
    if (stalled) {
      stalled = false;
      attempts = 0;
      stable = 0;
    }
    schedule();
  };
  const userTakeover = () => {
    if (disposed || phase === 'suspended') {
      return;
    }
    cancel();
    target = null;
    stalled = false;
    intent = 'reading';
    phase = 'ready';
    notify();
    persist();
  };

  return {
    activate(position: TranscriptPosition | null) {
      if (disposed) {
        return;
      }
      const saved = committed ?? position;
      intent = saved?.intent ?? initialIntent;
      restore(saved ?? port.capturePosition(intent));
    },
    suspend() {
      if (disposed) {
        return;
      }
      cancel();
      interacting = false;
      phase = 'suspended';
      notify();
    },
    layoutChanged: schedule,
    measurementReady() {
      if (phase === 'restoring') {
        wake();
      }
    },
    structureChanged(anchor: TranscriptPosition) {
      if (!disposed && phase === 'ready' && intent === 'reading') {
        restore(anchor);
      }
    },
    beginInteraction(direction: 'up' | 'down' | 'unknown') {
      if (disposed || phase === 'suspended') {
        return;
      }
      interacting = true;
      cancel();
      stable = 0;
      attempts = 0;
      if (direction === 'up') {
        userTakeover();
      }
    },
    endInteraction() {
      if (disposed || !interacting) {
        return;
      }
      interacting = false;
      wake();
    },
    userTakeover,
    userScrolled(direction: 'up' | 'down', distanceFromEnd: number) {
      if (disposed || phase === 'suspended') {
        return;
      }
      if (direction === 'up' || phase === 'restoring') {
        userTakeover();
      }
      if (direction === 'down' && distanceFromEnd <= 24) {
        intent = 'following';
        notify();
        schedule();
      }
      persist();
    },
    jumpToLatest() {
      if (disposed || phase === 'suspended') {
        return;
      }
      interacting = false;
      intent = 'following';
      restore({ ...port.capturePosition(intent), intent });
    },
    dispose() {
      cancel();
      disposed = true;
    },
  };
}

export type TranscriptScrollController = ReturnType<typeof createTranscriptScrollController>;

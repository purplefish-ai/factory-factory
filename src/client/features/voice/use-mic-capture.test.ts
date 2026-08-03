import { describe, expect, it, vi } from 'vitest';
import { attachTranscriptHandler, matchesStopPhrase } from './use-mic-capture';

describe('matchesStopPhrase', () => {
  it('matches common stop phrases regardless of case', () => {
    expect(matchesStopPhrase('Please stop')).toBe(true);
    expect(matchesStopPhrase('STOP')).toBe(true);
    expect(matchesStopPhrase('hold on a second')).toBe(true);
    expect(matchesStopPhrase('wait')).toBe(true);
    expect(matchesStopPhrase('cancel that')).toBe(true);
  });

  it('matches a stop phrase embedded in a longer utterance', () => {
    expect(matchesStopPhrase("Actually, please stop and let's try something else")).toBe(true);
  });

  it('does not match unrelated speech', () => {
    expect(matchesStopPhrase('add a new function to the file')).toBe(false);
  });

  it('does not match words that merely contain a stop phrase as a substring', () => {
    expect(matchesStopPhrase('what does this stopwatch component do')).toBe(false);
    expect(matchesStopPhrase('please await the response')).toBe(false);
  });

  it('does not match an empty transcript', () => {
    expect(matchesStopPhrase('')).toBe(false);
    expect(matchesStopPhrase('   ')).toBe(false);
  });
});

function createFakeSocket() {
  return { onmessage: null } as unknown as WebSocket & {
    onmessage: ((event: MessageEvent) => void) | null;
  };
}

function sendResults(
  socket: ReturnType<typeof createFakeSocket>,
  transcript: string,
  isFinal: boolean
) {
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'Results',
      is_final: isFinal,
      channel: { alternatives: [{ transcript }] },
    }),
  } as MessageEvent);
}

function sendUtteranceEnd(socket: ReturnType<typeof createFakeSocket>) {
  socket.onmessage?.({ data: JSON.stringify({ type: 'UtteranceEnd' }) } as MessageEvent);
}

describe('attachTranscriptHandler', () => {
  function setup(running = false) {
    const socket = createFakeSocket();
    const onFinalTranscript = vi.fn();
    const onInterimTranscript = vi.fn();
    const onSoftStop = vi.fn();
    attachTranscriptHandler(socket, {
      runningRef: { current: running },
      onFinalTranscript,
      onInterimTranscript,
      onSoftStop,
    });
    return { socket, onFinalTranscript, onInterimTranscript, onSoftStop };
  }

  it('does not send on is_final alone — only once UtteranceEnd confirms the user is done', () => {
    const { socket, onFinalTranscript } = setup();

    sendResults(socket, 'Let me think about this for a second.', true);
    expect(onFinalTranscript).not.toHaveBeenCalled();

    sendUtteranceEnd(socket);
    expect(onFinalTranscript).toHaveBeenCalledWith('Let me think about this for a second.');
  });

  it('still accumulates and sends when onInterimTranscript is not provided (real production usage — VoiceModeToggle never passes it)', () => {
    const socket = createFakeSocket();
    const onFinalTranscript = vi.fn();
    attachTranscriptHandler(socket, {
      runningRef: { current: false },
      onFinalTranscript,
      // onInterimTranscript intentionally omitted.
    });

    sendResults(socket, 'Let me think about this for a second.', true);
    sendUtteranceEnd(socket);

    expect(onFinalTranscript).toHaveBeenCalledWith('Let me think about this for a second.');
  });

  it('joins multiple is_final chunks from separate pauses into one message', () => {
    const { socket, onFinalTranscript } = setup();

    sendResults(socket, 'First part of the thought.', true);
    sendResults(socket, 'Second part after a pause.', true);
    sendUtteranceEnd(socket);

    expect(onFinalTranscript).toHaveBeenCalledTimes(1);
    expect(onFinalTranscript).toHaveBeenCalledWith(
      'First part of the thought. Second part after a pause.'
    );
  });

  it('resets the buffer after each UtteranceEnd so utterances do not bleed together', () => {
    const { socket, onFinalTranscript } = setup();

    sendResults(socket, 'First utterance.', true);
    sendUtteranceEnd(socket);
    sendResults(socket, 'Second utterance.', true);
    sendUtteranceEnd(socket);

    expect(onFinalTranscript).toHaveBeenNthCalledWith(1, 'First utterance.');
    expect(onFinalTranscript).toHaveBeenNthCalledWith(2, 'Second utterance.');
  });

  it('does not send anything for an UtteranceEnd with no accumulated speech', () => {
    const { socket, onFinalTranscript } = setup();

    sendUtteranceEnd(socket);

    expect(onFinalTranscript).not.toHaveBeenCalled();
  });

  it('previews accumulated-plus-in-progress text via onInterimTranscript', () => {
    const { socket, onInterimTranscript } = setup();

    sendResults(socket, 'First part.', true);
    sendResults(socket, 'still speaking', false);

    expect(onInterimTranscript).toHaveBeenLastCalledWith('First part. still speaking');
  });

  it('reacts to a stop phrase immediately without waiting for UtteranceEnd', () => {
    const { socket, onFinalTranscript, onSoftStop } = setup(true);

    sendResults(socket, 'please stop', true);

    expect(onSoftStop).toHaveBeenCalledTimes(1);
    expect(onFinalTranscript).not.toHaveBeenCalled();

    // Still part of the same (interrupted) utterance — arriving before its
    // UtteranceEnd — so it must be discarded too, not enqueued as a new
    // chat request once that UtteranceEnd fires.
    sendResults(socket, 'add a new function', true);
    sendUtteranceEnd(socket);
    expect(onFinalTranscript).not.toHaveBeenCalled();

    // A genuinely new utterance, after the interrupted one's UtteranceEnd,
    // is unaffected.
    sendResults(socket, 'add a new function', true);
    sendUtteranceEnd(socket);
    expect(onFinalTranscript).toHaveBeenCalledWith('add a new function');
  });

  it('ignores stop phrases while the agent is not running', () => {
    const { socket, onFinalTranscript, onSoftStop } = setup(false);

    sendResults(socket, 'please stop', true);
    sendUtteranceEnd(socket);

    expect(onSoftStop).not.toHaveBeenCalled();
    expect(onFinalTranscript).toHaveBeenCalledWith('please stop');
  });
});

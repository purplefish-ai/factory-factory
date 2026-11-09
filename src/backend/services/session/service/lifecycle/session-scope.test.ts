import { describe, expect, it, vi } from 'vitest';
import { registerSessionRuntimeParticipants, SessionScope } from './session-scope';

describe('SessionScope', () => {
  it('runs each stage in registration order with the teardown trigger', () => {
    const scope = new SessionScope();
    const calls: string[] = [];
    scope.register('first', {
      beginTeardown: (id, trigger) => calls.push(`first:begin:${id}:${trigger}`),
      settle: (id, trigger) => calls.push(`first:settle:${id}:${trigger}`),
      forget: (id) => calls.push(`first:forget:${id}`),
    });
    scope.register('second', {
      beginTeardown: (id, trigger) => calls.push(`second:begin:${id}:${trigger}`),
      completeStop: (id) => calls.push(`second:complete:${id}`),
    });

    scope.beginTeardown('s', 'exit');
    scope.settle('s', 'stop');
    scope.completeStop('s');
    scope.quiesce('s');
    scope.forget('s');

    expect(calls).toEqual([
      'first:begin:s:exit',
      'second:begin:s:exit',
      'first:settle:s:stop',
      'second:complete:s',
      'first:forget:s',
    ]);
  });

  it('isolates a failing disposer from the rest of the stage', () => {
    const scope = new SessionScope();
    const later = vi.fn();
    scope.register('failing', {
      completeStop: () => {
        throw new Error('dispose failed');
      },
    });
    scope.register('later', { completeStop: later });

    expect(() => scope.completeStop('s')).not.toThrow();
    expect(later).toHaveBeenCalledWith('s', 'stop');
  });

  it('rejects duplicate participant names', () => {
    const scope = new SessionScope();
    scope.register('dispatch', {});
    expect(() => scope.register('dispatch', {})).toThrow(
      'Session scope participant already registered: dispatch'
    );
  });
});

describe('registerSessionRuntimeParticipants', () => {
  function runtimeScope() {
    const calls: string[] = [];
    const scope = new SessionScope();
    registerSessionRuntimeParticipants(scope, {
      promptTurnCompletion: { clearSession: () => calls.push('clear-prompt-turn') },
      queuedPrompts: { clearQueuedAcpPrompts: () => calls.push('clear-queued-prompts') },
      acpEvents: {
        clearStreamingState: () => calls.push('clear-streaming'),
        clearReplaySuppression: () => calls.push('clear-replay'),
        clearSessionState: () => calls.push('clear-acp-state'),
      },
      permissions: { cancelPendingRequests: () => calls.push('cancel-permissions') },
    });
    return { scope, calls };
  }

  it('keeps the explicit stop teardown order', () => {
    const { scope, calls } = runtimeScope();
    scope.beginTeardown('s', 'stop');
    scope.quiesce('s');
    scope.settle('s', 'stop');
    expect(calls).toEqual([
      'clear-prompt-turn',
      'clear-queued-prompts',
      'clear-streaming',
      'clear-replay',
      'cancel-permissions',
      'clear-acp-state',
    ]);
  });

  it('keeps the runtime-exit teardown order', () => {
    const { scope, calls } = runtimeScope();
    scope.beginTeardown('s', 'exit');
    scope.settle('s', 'exit');
    expect(calls).toEqual([
      'clear-prompt-turn',
      'clear-queued-prompts',
      'clear-acp-state',
      'cancel-permissions',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/acp-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { SessionLoadService, type SessionLoadDependencies } from './session-load.service';

const stopped: SessionRuntimeState = {
  phase: 'idle',
  processState: 'stopped',
  activity: 'IDLE',
  updatedAt: '2026-10-27T12:00:00.000Z',
};

function setup() {
  const calls: string[] = [];
  const deltas: SessionDeltaEvent[] = [];
  const queue: QueuedMessage[] = [];
  let initial: string | null = null;
  let transcript: ChatMessage[] = [];
  let runtime = stopped;
  let exists = true;
  let rejectEnqueue = false;
  const deps: SessionLoadDependencies = {
    findSession: async () =>
      exists
        ? {
            provider: 'CODEX',
            providerSessionId: null,
            providerMetadata: null,
            status: 'IDLE',
            workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
          }
        : null,
    hydrateProviderHistory: () => {
      calls.push('history');
      return Promise.resolve();
    },
    hydrateLifecycleEvents: () => {
      calls.push('lifecycle');
      return Promise.resolve();
    },
    getRuntimeSnapshot: () => runtime,
    domain: {
      finishLoad: () => {
        calls.push('runtime');
      },
      getTranscriptSnapshot: () => transcript,
      replaceTranscript: (_id, next) => {
        calls.push('recover');
        transcript = next;
      },
      prepareLoad: () => {
        calls.push('prepare');
        return { replayEvents: [], sessionRuntime: runtime };
      },
      consumeInitialMessage: () => {
        calls.push('consume');
        const text = initial;
        initial = null;
        return text;
      },
      enqueue: (_id, message) => {
        calls.push('enqueue');
        if (rejectEnqueue) {
          return { error: 'full' };
        }
        queue.push(message);
        return { position: queue.length - 1 };
      },
      emitDelta: (_id, event) => {
        calls.push(event.type);
        deltas.push(event);
      },
    },
    config: {
      getSessionConfigProjection: () => {
        calls.push('projection');
        return Promise.resolve({
          currentProjection: () => ({
            capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
            configOptions: [],
          }),
        });
      },
    },
    getCachedCommands: () => {
      calls.push('commands');
      return Promise.resolve([]);
    },
    tryDispatchNextMessage: () => {
      calls.push('dispatch');
      return Promise.resolve();
    },
  };
  return {
    service: new SessionLoadService(deps),
    deps,
    calls,
    queue,
    deltas,
    setInitial: (text: string) => {
      initial = text;
    },
    setTranscript: (next: ChatMessage[]) => {
      transcript = next;
    },
    getTranscript: () => transcript,
    setRuntime: (next: SessionRuntimeState) => {
      runtime = next;
    },
    removeSession: () => {
      exists = false;
    },
    rejectEnqueue: () => {
      rejectEnqueue = true;
    },
  };
}

describe('SessionLoadService', () => {
  it('returns a typed missing-session error without hydration or activation', async () => {
    const test = setup();
    test.removeSession();
    expect(
      await test.service.prepareLoad({ sessionId: 'missing', loadRequestId: 'load-1' })
    ).toEqual({
      status: 'error',
      outcome: { replies: [{ type: 'error', error: { kind: 'session_not_found' } }] },
    });
    expect(test.calls).toEqual([]);
  });

  it('hydrates history then lifecycle and returns replay data before configuration or activation', async () => {
    const test = setup();
    test.setInitial('Start work');
    const prepared = await test.service.prepareLoad({ sessionId: 's1', loadRequestId: 'load-1' });
    expect(prepared).toMatchObject({
      status: 'ready',
      sessionId: 's1',
      loadRequestId: 'load-1',
    });
    expect(test.calls).toEqual(['history', 'lifecycle']);
    expect(test.queue).toEqual([]);
    if (prepared.status !== 'ready') {
      throw new Error('Expected a ready session');
    }
    test.service.captureReplay(prepared);
    await test.service.completeLoad(prepared);
    expect(test.calls).toEqual([
      'history',
      'lifecycle',
      'prepare',
      'runtime',
      'projection',
      'chat_capabilities',
      'config_options_update',
      'commands',
      'slash_commands',
      'consume',
      'enqueue',
      'message_state_changed',
      'dispatch',
    ]);
    expect(test.queue).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^msg-/), text: 'Start work' }),
    ]);
    expect(test.deltas.at(-1)).toMatchObject({
      type: 'message_state_changed',
      id: test.queue[0]?.id,
      queuePosition: 0,
    });
  });

  it('recovers interrupted tools before replay preparation only when stopped', async () => {
    const test = setup();
    const interrupted: ChatMessage = {
      id: 'tool',
      source: 'agent',
      order: 0,
      timestamp: '2026-10-27T11:59:00.000Z',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'call-1',
            name: 'exec_command',
            input: { cmd: 'pwd' },
          },
        },
      },
    };
    test.setTranscript([interrupted]);
    const prepared = await test.service.prepareLoad({ sessionId: 's1' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    test.service.captureReplay(prepared);
    expect(test.calls).toEqual(['history', 'lifecycle', 'recover', 'prepare']);
    expect(test.getTranscript()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({
              content: [
                expect.objectContaining({
                  type: 'tool_result',
                  tool_use_id: 'call-1',
                  is_error: true,
                }),
              ],
            }),
          }),
        }),
      ])
    );
    test.calls.length = 0;
    test.setTranscript([interrupted]);
    test.setRuntime({ ...stopped, phase: 'running', processState: 'alive', activity: 'WORKING' });
    const running = await test.service.prepareLoad({ sessionId: 's1' });
    if (running.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    test.service.captureReplay(running);
    expect(test.calls).toEqual(['history', 'lifecycle', 'prepare']);
    expect(test.getTranscript()).toEqual([interrupted]);
  });

  it('consumes an initial message once across concurrent completions', async () => {
    const test = setup();
    test.setInitial('Start once');
    const prepared = await test.service.prepareLoad({ sessionId: 's1' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    await Promise.all([test.service.completeLoad(prepared), test.service.completeLoad(prepared)]);
    expect(test.queue.map((message) => message.text)).toEqual(['Start once']);
    expect(test.calls.filter((call) => call === 'dispatch')).toHaveLength(1);
    expect(test.calls.filter((call) => call === 'projection')).toHaveLength(2);
  });

  it('does not dispatch or report accepted state when initial enqueue rejects', async () => {
    const test = setup();
    test.setInitial('Start');
    test.rejectEnqueue();
    const prepared = await test.service.prepareLoad({ sessionId: 's1' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    await test.service.completeLoad(prepared);
    expect(test.calls).not.toContain('dispatch');
    expect(test.deltas.map((event) => event.type)).not.toContain('message_state_changed');
  });

  it('leaves activation untouched when projection lookup fails', async () => {
    const test = setup();
    test.setInitial('Start');
    test.deps.config.getSessionConfigProjection = () => Promise.reject(new Error('catalog failed'));
    const prepared = await test.service.prepareLoad({ sessionId: 's1' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    await expect(test.service.completeLoad(prepared)).rejects.toThrow('catalog failed');
    expect(test.calls).not.toContain('consume');
    expect(test.queue).toEqual([]);
  });
  it('publishes confirmed options between capabilities and commands before activating initial text', async () => {
    const test = setup();
    test.setInitial('Start');
    const emit = test.deps.domain.emitDelta;
    test.deps.domain.emitDelta = (id, event) => {
      emit(id, event);
      if (event.type === 'chat_capabilities') {
        queueMicrotask(() => test.calls.push('interleaved'));
      }
    };
    test.deps.config.getSessionConfigProjection = async () => ({
      currentProjection: () => ({
        capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'chosen',
            options: [{ value: 'chosen', name: 'Chosen' }],
          },
        ],
      }),
    });
    const prepared = await test.service.prepareLoad({ sessionId: 's1' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    await test.service.completeLoad(prepared);
    expect(test.deltas.map((event) => event.type)).toEqual([
      'chat_capabilities',
      'config_options_update',
      'slash_commands',
      'message_state_changed',
    ]);
    expect(test.calls.indexOf('config_options_update')).toBeLessThan(
      test.calls.indexOf('interleaved')
    );
    expect(test.deltas[1]).toEqual({
      type: 'config_options_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'chosen',
          options: [{ value: 'chosen', name: 'Chosen' }],
        },
      ],
    });
  });

  it('does not prepare replay or consume initial text when hydration fails', async () => {
    const test = setup();
    test.setInitial('Start');
    test.deps.hydrateLifecycleEvents = () => Promise.reject(new Error('lifecycle unavailable'));
    await expect(test.service.prepareLoad({ sessionId: 's1' })).rejects.toThrow(
      'lifecycle unavailable'
    );
    expect(test.calls).toEqual(['history']);
    expect(test.queue).toEqual([]);
  });
  it('captures current runtime after microtask updates during async preparation', async () => {
    const test = setup();
    const prepared = await test.service.prepareLoad({ sessionId: 's1' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready session');
    }
    const running = {
      ...stopped,
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
    } as const;
    await Promise.resolve().then(() => test.setRuntime(running));
    expect(test.service.captureReplay(prepared).sessionRuntime).toEqual(running);
    expect(test.calls).toEqual(['history', 'lifecycle', 'prepare']);
  });
});

it('publishes an empty native option list so clients can finish settings hydration', async () => {
  const test = setup();
  const prepared = await test.service.prepareLoad({ sessionId: 's1' });
  if (prepared.status !== 'ready') {
    throw new Error('Expected ready session');
  }
  await test.service.completeLoad(prepared);
  expect(test.deltas).toContainEqual({ type: 'config_options_update', configOptions: [] });
});

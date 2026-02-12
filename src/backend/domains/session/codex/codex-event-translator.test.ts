import { describe, expect, it } from 'vitest';
import { CodexEventTranslator } from './codex-event-translator';

describe('CodexEventTranslator', () => {
  it('maps text delta notifications to Claude-compatible assistant messages', () => {
    const translator = new CodexEventTranslator();

    const events = translator.translateNotification('item/delta', {
      threadId: 'thread-1',
      delta: 'hello from codex',
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent_message',
        data: expect.objectContaining({
          type: 'assistant',
        }),
      }),
    ]);
  });

  it('maps turn lifecycle notifications to canonical runtime updates', () => {
    const translator = new CodexEventTranslator();

    const running = translator.translateNotification('turn/started', {
      threadId: 'thread-1',
    });
    const completed = translator.translateNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    const cancelled = translator.translateNotification('turn/cancelled', {
      threadId: 'thread-1',
      turnId: 'turn-2',
    });
    const failed = translator.translateNotification('turn/failed', {
      threadId: 'thread-1',
      turnId: 'turn-3',
    });

    expect(running[0]).toMatchObject({
      type: 'session_runtime_updated',
      sessionRuntime: expect.objectContaining({ phase: 'running', activity: 'WORKING' }),
    });

    expect(completed[0]).toMatchObject({
      type: 'session_runtime_updated',
      sessionRuntime: expect.objectContaining({ phase: 'idle', activity: 'IDLE' }),
    });
    expect(completed[1]).toMatchObject({ type: 'agent_message' });

    expect(cancelled[0]).toMatchObject({
      type: 'session_runtime_updated',
      sessionRuntime: expect.objectContaining({ phase: 'idle', activity: 'IDLE' }),
    });

    expect(failed[0]).toMatchObject({
      type: 'session_runtime_updated',
      sessionRuntime: expect.objectContaining({ phase: 'idle', activity: 'IDLE' }),
    });
  });

  it('maps approval requests to permission_request events', () => {
    const translator = new CodexEventTranslator();

    const event = translator.translateServerRequest(
      'item/commandExecution/requestApproval',
      'approval-1',
      { command: 'npm publish' }
    );

    expect(event).toEqual(
      expect.objectContaining({
        type: 'permission_request',
        requestId: 'approval-1',
        toolName: 'CodexCommandApproval',
      })
    );
  });

  it('feature-flags user input requests and degrades to unsupported when disabled', () => {
    const disabledTranslator = new CodexEventTranslator({ userInputEnabled: false });
    const disabledEvent = disabledTranslator.translateServerRequest(
      'item/tool/requestUserInput',
      'question-1',
      { prompt: 'Need more details?' }
    );

    expect(disabledEvent).toMatchObject({
      type: 'error',
      data: {
        code: 'UNSUPPORTED_OPERATION',
        operation: 'question_response',
      },
    });

    const enabledTranslator = new CodexEventTranslator({ userInputEnabled: true });
    const enabledEvent = enabledTranslator.translateServerRequest(
      'item/tool/requestUserInput',
      'question-2',
      { prompt: 'Need more details?' }
    );

    expect(enabledEvent).toMatchObject({
      type: 'user_question',
      requestId: 'question-2',
    });
  });
});

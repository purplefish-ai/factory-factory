import { describe, expect, it } from 'vitest';
import { AcpEventTranslator } from './session-update-translator';

function createTranslator() {
  return new AcpEventTranslator({ warn: () => undefined });
}

function start(translator: AcpEventTranslator, sessionId = 's1') {
  return translator.translateSessionUpdate(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'bash-1',
      title: 'Terminal',
      _meta: { claudeCode: { toolName: 'Bash' } },
      rawInput: {},
      status: 'pending',
    },
    sessionId
  );
}

describe('ACP tool input refinement', () => {
  it('emits an enriched tool start before the result while preserving the actual tool name', () => {
    const translator = createTranslator();
    start(translator);
    const events = translator.translateSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bash-1',
        title: 'Print working directory',
        rawInput: { command: 'pwd', description: 'Print working directory' },
        status: 'completed',
        rawOutput: '/repo',
      },
      's1'
    );
    expect(events[0]).toMatchObject({
      type: 'agent_message',
      data: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'pwd', description: 'Print working directory' },
          },
        },
      },
    });
    expect(events.at(-1)).toMatchObject({
      data: {
        message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: '/repo' }] },
      },
    });
  });

  it('replaces partial input with each whole rawInput value, including an empty object', () => {
    const translator = createTranslator();
    start(translator);
    for (const rawInput of [{ command: 'pwd', extra: true }, { command: 'ls' }, {}]) {
      expect(
        translator.translateSessionUpdate(
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'bash-1',
            rawInput,
          },
          's1'
        )[0]
      ).toMatchObject({ data: { event: { content_block: { input: rawInput } } } });
    }
  });

  it('ignores omitted and invalid inputs without creating a second tool start', () => {
    const translator = createTranslator();
    start(translator);
    for (const rawInput of [undefined, null, 'partial json', [], 42]) {
      const events = translator.translateSessionUpdate(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bash-1',
          rawInput,
        },
        's1'
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('tool_progress');
    }
  });

  it('isolates tool identities by session and forgets them on completion or cleanup', () => {
    const translator = createTranslator();
    start(translator, 's1');
    start(translator, 's2');
    translator.clearTerminalOutput('s1');
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bash-1',
      rawInput: { command: 'pwd' },
    } as const;
    expect(translator.translateSessionUpdate(update, 's1')).toHaveLength(1);
    expect(translator.translateSessionUpdate(update, 's2')).toHaveLength(2);
    translator.translateSessionUpdate({ ...update, status: 'completed' }, 's2');
    expect(translator.translateSessionUpdate(update, 's2')).toHaveLength(1);
  });
});

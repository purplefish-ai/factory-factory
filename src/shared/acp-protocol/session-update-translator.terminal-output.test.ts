import { describe, expect, it, vi } from 'vitest';
import { AcpEventTranslator, type TranslatableSessionUpdate } from './session-update-translator';

type ToolUpdate = Extract<TranslatableSessionUpdate, { sessionUpdate: 'tool_call_update' }>;

function output(toolCallId: string, data: string, terminalId = toolCallId): ToolUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    _meta: { terminal_output_delta: { data, terminal_id: terminalId } },
  };
}

function complete(toolCallId: string): ToolUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    _meta: { terminal_exit: { terminal_id: toolCallId, exit_code: 0, signal: null } },
  };
}

function expectResult(events: unknown[], id: string, content: string) {
  expect(events.at(-1)).toMatchObject({
    type: 'agent_message',
    data: { message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } },
  });
}

describe('ACP terminal output stream', () => {
  it('returns streamed shell output on content-less completion and isolates interleaved tools', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      title: 'Terminal',
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'exec-1' }],
      _meta: { terminal_info: { terminal_id: 'exec-1', cwd: '/tmp/work' } },
    });
    translator.translateSessionUpdate(output('exec-1', 'first\n'));
    translator.translateSessionUpdate(output('exec-2', 'other\n'));
    translator.translateSessionUpdate(output('exec-1', 'second\n'));
    expectResult(
      translator.translateSessionUpdate(complete('exec-1')),
      'exec-1',
      'first\nsecond\n'
    );
    expectResult(translator.translateSessionUpdate(complete('exec-2')), 'exec-2', 'other\n');
    expectResult(translator.translateSessionUpdate(complete('exec-1')), 'exec-1', '');
  });

  it('separates identical native tool IDs across sessions and clears only the torn-down session', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    translator.translateSessionUpdate(output('exec', 'Session A'), 'session-a');
    translator.translateSessionUpdate(output('exec', 'Session B'), 'session-b');
    translator.clearTerminalOutput('session-a');
    expectResult(translator.translateSessionUpdate(complete('exec'), 'session-a'), 'exec', '');
    expectResult(
      translator.translateSessionUpdate(complete('exec'), 'session-b'),
      'exec',
      'Session B'
    );
  });

  it('ignores mismatched terminal IDs and invalid output metadata', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    translator.translateSessionUpdate(output('exec', 'Wrong tool', 'other'));
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec',
      _meta: { terminal_output_delta: { data: 123, terminal_id: 'exec' } },
    });
    expectResult(translator.translateSessionUpdate(complete('exec')), 'exec', '');
  });

  it('bounds a verbose tool to the latest 256 KiB of text and bounds abandoned tool IDs', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    translator.translateSessionUpdate(output('verbose', 'x'.repeat(300_000)));
    translator.translateSessionUpdate(output('verbose', 'tail'));
    expectResult(
      translator.translateSessionUpdate(complete('verbose')),
      'verbose',
      `${'x'.repeat(262_140)}tail`
    );
    for (let index = 0; index < 65; index += 1) {
      translator.translateSessionUpdate(
        output(`exec-${index}`, `Output ${index}`),
        `session-${index}`
      );
    }
    expectResult(translator.translateSessionUpdate(complete('exec-0'), 'session-0'), 'exec-0', '');
    expectResult(
      translator.translateSessionUpdate(complete('exec-64'), 'session-64'),
      'exec-64',
      'Output 64'
    );
  });

  it('supports terminal_output metadata and prefers canonical completion content without duplication', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec',
      _meta: { terminal_output: { data: 'Shell output', terminal_id: 'exec' } },
    });
    expectResult(translator.translateSessionUpdate(complete('exec')), 'exec', 'Shell output');
    translator.translateSessionUpdate(output('exec', 'Repeated output'));
    expectResult(
      translator.translateSessionUpdate({
        ...complete('exec'),
        content: [{ type: 'content', content: { type: 'text', text: 'Canonical output' } }],
      }),
      'exec',
      'Canonical output'
    );
  });

  it('replaces terminal_output snapshots while continuing to append subsequent deltas', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    for (const data of ['First\n', 'First\nSecond\n']) {
      translator.translateSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'exec',
        _meta: { terminal_output: { data, terminal_id: 'exec' } },
      });
    }
    translator.translateSessionUpdate(output('exec', 'Third\n'));
    expectResult(
      translator.translateSessionUpdate(complete('exec')),
      'exec',
      'First\nSecond\nThird\n'
    );
  });
});

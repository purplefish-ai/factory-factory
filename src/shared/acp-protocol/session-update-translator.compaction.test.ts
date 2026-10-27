import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { AcpEventTranslator } from './session-update-translator';

function createTranslator() {
  const logger = { warn: vi.fn() };
  return { translator: new AcpEventTranslator(logger), logger };
}

const update = (status: string, extra = {}): SessionUpdate => ({
  sessionUpdate: 'compaction_update',
  compactionId: 'compact-1',
  status,
  ...extra,
});

describe('native ACP compaction', () => {
  it('starts progress and emits a successful boundary only on completion', () => {
    const { translator } = createTranslator();
    expect(translator.translateSessionUpdate(update('in_progress'))).toEqual([
      { type: 'compacting_start' },
    ]);
    expect(translator.translateSessionUpdate(update('completed'))).toEqual([
      { type: 'compacting_end' },
      { type: 'compact_boundary' },
    ]);
  });

  it.each(['failed', 'cancelled'])(
    'ends %s progress with an understandable message and no boundary',
    (status) => {
      const { translator } = createTranslator();
      translator.translateSessionUpdate(update('in_progress'));
      const events = translator.translateSessionUpdate(update(status));
      expect(events[0]).toEqual({ type: 'compacting_end' });
      expect(events).not.toContainEqual({ type: 'compact_boundary' });
      expect(events[1]).toMatchObject({
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: expect.stringContaining(status) }] },
        },
      });
    }
  );

  it('retains provider failure details that Claude suppresses from local command output', () => {
    const { translator } = createTranslator();
    const events = translator.translateSessionUpdate(
      update('failed', { error: 'Conversation is too short to compact.' })
    );
    expect(JSON.stringify(events)).toContain('Conversation is too short to compact.');
    expect(events).not.toContainEqual({ type: 'compact_boundary' });
  });

  it.each([{ error: 42 }, { error: false }, { error: {} }, { error: [] }])(
    'handles malformed provider failure details: $error',
    ({ error }) => {
      const { translator } = createTranslator();
      translator.translateSessionUpdate(update('in_progress'));
      const events = translator.translateSessionUpdate(update('failed', { error }));
      expect(events[0]).toEqual({ type: 'compacting_end' });
      expect(events[1]).toMatchObject({
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Context compaction failed.' }] },
        },
      });
      expect(events).not.toContainEqual({ type: 'compact_boundary' });
    }
  );

  it('handles terminal-only replay and ignores duplicate terminal metadata patches', () => {
    const { translator } = createTranslator();
    expect(translator.translateSessionUpdate(update('completed'))).toEqual([
      { type: 'compacting_end' },
      { type: 'compact_boundary' },
    ]);
    expect(
      translator.translateSessionUpdate(
        update('completed', { summary: [{ type: 'text', text: 'Private retained context' }] })
      )
    ).toEqual([]);
    expect(translator.translateSessionUpdate(update('in_progress'))).toEqual([]);
  });

  it('starts progress on a first summary chunk without dumping retained model context', () => {
    const { translator, logger } = createTranslator();
    const chunk: SessionUpdate = {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'compact-1',
      content: { type: 'text', text: 'Long retained model context and continuation instructions' },
    };
    expect(translator.translateSessionUpdate(chunk)).toEqual([{ type: 'compacting_start' }]);
    expect(translator.translateSessionUpdate(chunk)).toEqual([]);
    const events = translator.translateSessionUpdate(
      update('completed', { summary: [chunk.content] })
    );
    expect(JSON.stringify(events)).not.toContain('Long retained model context');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('isolates provider compaction IDs by session and clears them on teardown', () => {
    const { translator } = createTranslator();
    translator.translateSessionUpdate(update('completed'), 'session-a');
    expect(translator.translateSessionUpdate(update('in_progress'), 'session-b')).toEqual([
      { type: 'compacting_start' },
    ]);
    translator.clearTerminalOutput('session-a');
    expect(translator.translateSessionUpdate(update('in_progress'), 'session-a')).toEqual([
      { type: 'compacting_start' },
    ]);
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'deduplicates old %s identities after more than 256 compactions until session teardown',
    (status) => {
      const { translator } = createTranslator();
      for (let index = 0; index < 257; index += 1) {
        translator.translateSessionUpdate(
          update(status, { compactionId: `compact-${index}` }),
          'session-a'
        );
      }
      const replay = { compactionId: 'compact-0' };
      expect(translator.translateSessionUpdate(update(status, replay), 'session-a')).toEqual([]);
      expect(translator.translateSessionUpdate(update('completed', replay), 'session-a')).toEqual(
        []
      );
      expect(translator.translateSessionUpdate(update('in_progress', replay), 'session-a')).toEqual(
        []
      );
      translator.clearTerminalOutput('session-a');
      expect(translator.translateSessionUpdate(update('in_progress', replay), 'session-a')).toEqual(
        [{ type: 'compacting_start' }]
      );
    }
  );

  it.each(['failed', 'cancelled'])(
    'never turns a terminal %s into successful compaction',
    (status) => {
      const { translator } = createTranslator();
      translator.translateSessionUpdate(update(status));
      expect(translator.translateSessionUpdate(update('completed'))).toEqual([]);
      expect(translator.translateSessionUpdate(update(status))).toEqual([]);
    }
  );

  it('preserves the lower post-compaction usage snapshot without accumulating it', () => {
    const { translator } = createTranslator();
    const before: SessionUpdate = { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 };
    const after: SessionUpdate = { sessionUpdate: 'usage_update', used: 1500, size: 200_000 };
    translator.translateSessionUpdate(before);
    translator.translateSessionUpdate(update('completed'));
    expect(translator.translateSessionUpdate(after)).toEqual([
      { type: 'agent_message', data: { type: 'result', result: after } },
    ]);
  });

  it('does not treat an unknown future status as successful completion', () => {
    const { translator } = createTranslator();
    expect(translator.translateSessionUpdate(update('_paused'))).toEqual([]);
  });
});

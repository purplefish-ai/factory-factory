import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { selectTranscriptPage } from '@/backend/services/session/service/store/session-transcript-page';
import type { ChatMessage } from '@/shared/acp-protocol';
import { SessionDeltaEventSchema } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import type { SessionUpdate } from '@/shared/acp-protocol/sdk-types';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { AcpEventProcessor, type AcpEventProcessorDependencies } from './acp-event-processor';

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

const sid = 'transcript';
function fixture() {
  const domain = new SessionDomainService();
  const emitted = vi.spyOn(domain, 'emitDelta');
  const processor = new AcpEventProcessor(
    unsafeCoerce<AcpEventProcessorDependencies>({
      sessionDomainService: domain,
      runtimeManager: { isSessionWorking: () => false, getClient: () => null },
      sessionPermissionService: { createPermissionBridge: () => ({}) },
      sessionConfigService: {},
      onToolCallTimeout: vi.fn(),
    })
  );
  const handler = processor.createRuntimeEventHandler(sid);
  const update = (value: SessionUpdate) =>
    handler.onAcpEvent?.(sid, { type: 'acp_session_update', update: value });
  const chunk = (
    sessionUpdate: 'agent_message_chunk' | 'user_message_chunk',
    text: string,
    messageId?: string
  ) => update({ sessionUpdate, content: { type: 'text', text }, messageId });
  return { domain, processor, update, chunk, emitted, handler };
}

function rowText(row: ChatMessage) {
  if (row.source === 'user') {
    return row.text;
  }
  const content = row.message?.message?.content;
  return Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : undefined;
}

afterEach(() => vi.restoreAllMocks());

describe('main-chat ACP transcript', () => {
  it('preserves identified message boundaries and whitespace in live and replay text', () => {
    const { chunk, domain, processor, emitted } = fixture();
    chunk('agent_message_chunk', ' first ', 'a');
    chunk('agent_message_chunk', 'second', 'b');
    chunk('user_message_chunk', '  one', 'a');
    chunk('user_message_chunk', '\n\n', 'a');
    chunk('user_message_chunk', 'two  ', 'a');
    chunk('user_message_chunk', 'next', 'b');
    processor.clearSessionState(sid);
    const rows = domain.getTranscriptSnapshot(sid);
    expect(rows.map(rowText)).toEqual([' first ', 'second', '  one\n\ntwo  ', 'next']);
    const liveText = emitted.mock.calls
      .map(([, delta]) => delta)
      .filter((delta) => delta.type === 'assistant_text_delta');
    expect(liveText.map(({ text, messageId }) => [text, messageId])).toEqual(
      rows.slice(0, 2).map((row) => [rowText(row), row.id])
    );
    const replay = domain.prepareLoad(sid, domain.getRuntimeSnapshot(sid));
    expect(
      replay?.replayEvents
        .filter((e) => e.type === 'message_state_changed' && e.userMessage)
        .map((e) => 'userMessage' in e && e.userMessage?.text)
    ).toEqual(['  one\n\ntwo  ', 'next']);
  });

  it('keeps identified text together across incidental provider usage updates', () => {
    const { chunk, domain, processor, update } = fixture();
    chunk('user_message_chunk', 'question ', 'user');
    update({ sessionUpdate: 'usage_update', used: 2, size: 1000 });
    chunk('user_message_chunk', 'continued', 'user');
    chunk('agent_message_chunk', 'answer ', 'agent');
    update({ sessionUpdate: 'usage_update', used: 3, size: 1000 });
    chunk('agent_message_chunk', 'continued', 'agent');
    processor.clearSessionState(sid);
    expect(domain.getTranscriptSnapshot(sid).map(rowText)).toEqual([
      'question continued',
      undefined,
      'answer continued',
      undefined,
    ]);
  });

  it('keeps separate unlabelled user prompts and coalesces adjacent unlabelled assistant chunks', () => {
    const { chunk, domain, processor } = fixture();
    chunk('user_message_chunk', '  first prompt ');
    chunk('user_message_chunk', 'second prompt');
    chunk('agent_message_chunk', ' answer');
    chunk('agent_message_chunk', ' to both ');
    processor.clearSessionState(sid);
    expect(domain.getTranscriptSnapshot(sid).map(rowText)).toEqual([
      '  first prompt ',
      'second prompt',
      ' answer to both ',
    ]);
  });

  it('resumes the same fenced Markdown row after an interleaved tool and separates later turns', () => {
    const { chunk, domain, processor, update, emitted } = fixture();
    const start = '```ts\n';
    const rest = '  run()\n```\n';
    chunk('agent_message_chunk', start, 'answer');
    update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
    chunk('agent_message_chunk', rest, 'answer');
    processor.finishPromptTurn(sid);
    chunk('agent_message_chunk', 'new turn', 'answer');
    processor.clearSessionState(sid);
    const rows = domain.getTranscriptSnapshot(sid);
    expect(rows.map(rowText)).toEqual([start + rest, undefined, undefined, 'new turn']);
    expect(
      emitted.mock.calls
        .map(([, delta]) => delta)
        .filter((delta) => delta.type === 'assistant_text_delta')
        .map(({ messageId, order, offset, text }) => [messageId, order, offset, text])
    ).toEqual([
      [rows[0]?.id, rows[0]?.order, 0, start],
      [rows[0]?.id, rows[0]?.order, start.length, rest],
      [rows[3]?.id, rows[3]?.order, 0, 'new turn'],
    ]);
  });

  it('publishes usable pagination cursors for fresh and enriched historical tool rows', () => {
    const { chunk, domain, processor, update, emitted, handler } = fixture();
    domain.replaceTranscript(sid, [
      {
        id: 'hydrated-uuid',
        order: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'agent',
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'old', name: 'Read', input: {} },
          },
        },
      },
    ]);
    processor.setReplaySuppression(sid, true);
    handler.consumeReplayEvent?.(sid, {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'old',
        title: 'Read',
      },
    });
    processor.clearReplaySuppression(sid);
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'old', rawInput: { file: 'first' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'new', title: 'Read' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'new', status: 'completed' });
    chunk('agent_message_chunk', 'done');
    processor.clearSessionState(sid);
    const rows = domain.getTranscriptSnapshot(sid);
    const live = emitted.mock.calls
      .map(([, delta]) => SessionDeltaEventSchema.parse(delta))
      .filter((delta) => delta.type === 'agent_message' || delta.type === 'assistant_text_delta');
    expect(live.map((delta) => delta.messageId)).toEqual(rows.map((row) => row.id));
    for (const [index, delta] of live.entries()) {
      expect(selectTranscriptPage(rows, delta.messageId ?? '').messages).toEqual(
        rows.slice(0, index)
      );
    }
  });
});

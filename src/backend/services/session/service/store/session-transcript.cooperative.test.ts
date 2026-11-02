import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { HistoryMessage } from '@/shared/acp-protocol';
import * as transcript from './session-transcript';

afterEach(() => vi.restoreAllMocks());
const history: HistoryMessage[] = [
  {
    type: 'user',
    content: 'original prompt',
    uuid: 'original-user',
    timestamp: '2026-10-18T12:00:00Z',
  },
  {
    type: 'tool_use',
    toolId: 'original-call',
    toolName: 'shell',
    toolInput: { cmd: 'pwd' },
    content: '',
    timestamp: '2026-10-18T12:00:01Z',
  },
  {
    type: 'tool_result',
    toolId: 'original-call',
    content: '👋'.repeat(100_000),
    timestamp: '2026-10-18T12:00:02Z',
  },
  ...Array.from({ length: 256 }, (_, index): HistoryMessage => ({
    type: 'assistant',
    content: `answer ${index}`,
    timestamp: '2026-10-18T12:00:03Z',
  })),
];

it('yields during projection and preserves full messages, identities, order and timestamps', async () => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
  const heartbeat = vi.fn();
  setImmediate(heartbeat);
  const projected = await transcript.buildTranscriptFromHistoryCooperatively(history, () => true);
  expect(heartbeat).toHaveBeenCalledOnce();
  expect(projected).toEqual(transcript.buildTranscriptFromHistory(history));
});

it('discards unfinished projection when its provider identity is replaced', async () => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
  let current = true;
  setImmediate(() => {
    current = false;
  });
  await expect(
    transcript.buildTranscriptFromHistoryCooperatively(history, () => current)
  ).resolves.toBeNull();
  await yieldToEventLoop();
});

it('yields after a single structured tool result when its projection budget expires', async () => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 20));
  const structured: HistoryMessage[] = [
    {
      type: 'tool_result',
      toolId: 'large-call',
      content: [{ type: 'text', text: 'large body'.repeat(10_000) }],
      timestamp: '2026-10-18T12:00:02Z',
    },
  ];
  const heartbeat = vi.fn();
  setImmediate(heartbeat);
  const projected = await transcript.buildTranscriptFromHistoryCooperatively(
    structured,
    () => true
  );
  expect(heartbeat).toHaveBeenCalledOnce();
  expect(projected).toEqual(transcript.buildTranscriptFromHistory(structured));
});

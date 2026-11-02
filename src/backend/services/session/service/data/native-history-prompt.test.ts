import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { codexSessionHistoryLoaderService } from './codex-session-history-loader.service';
import { claudeSessionHistoryLoaderService } from './session-history-loader.service';

let directory: string;
const timestamp = '2026-11-02T12:00:00.000Z';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } };
function writeHistory(path: string, entries: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'));
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ff-native-prompt-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', directory);
  vi.stubEnv('CODEX_HOME', directory);
  vi.stubEnv('CODEX_SESSIONS_DIR', undefined);
  configService.reload();
});
afterEach(() => {
  vi.unstubAllEnvs();
  configService.reload();
  rmSync(directory, { recursive: true, force: true });
});

it('preserves supported Claude prompt block order after tool results and unknown blocks', async () => {
  const supported = [image, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }];
  writeHistory(join(directory, 'projects', '-work', 'claude-native.jsonl'), [
    {
      type: 'user',
      sessionId: 'claude-native',
      timestamp,
      uuid: 'native-row',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool', content: 'result' },
          { type: 'future_native_metadata', value: 'not prompt content' },
          ...supported,
        ],
      },
    },
  ]);
  const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
    providerSessionId: 'claude-native',
    workingDir: '/work',
  });
  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') {
    throw new Error('Expected native history');
  }
  const users = result.history.filter((message) => message.type === 'user');
  expect(users.map((message) => message.providerPrompt)).toEqual([supported, null]);
  expect(result.history.some((message) => message.type === 'tool_result')).toBe(true);
  expect(users[0]?.attachments).toHaveLength(1);
});

it('takes Codex attachments independently from earlier multi-block prompt evidence', async () => {
  writeHistory(join(directory, 'sessions', '2026', '11', '02', 'rollout-codex-native.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-native', cwd: '/work' } },
    {
      type: 'event_msg',
      timestamp,
      payload: { type: 'user_message', message: 'first\nsecond', turn_id: 'turn' },
    },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        role: 'user',
        turn_id: 'turn',
        content: [
          { type: 'input_text', text: 'first' },
          { type: 'input_text', text: 'second' },
        ],
      },
    },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        role: 'user',
        turn_id: 'turn',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGk=' }],
      },
    },
  ]);
  const result = await codexSessionHistoryLoaderService.loadSessionHistory({
    providerSessionId: 'codex-native',
    workingDir: '/work',
  });
  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') {
    throw new Error('Expected native history');
  }
  const users = result.history.filter((message) => message.type === 'user');
  expect(users).toHaveLength(1);
  expect(users[0]?.providerPrompt).toEqual([
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
    image,
  ]);
  expect(users[0]?.attachments).toEqual([
    expect.objectContaining({ data: 'aGk=', type: 'image/png' }),
  ]);
});

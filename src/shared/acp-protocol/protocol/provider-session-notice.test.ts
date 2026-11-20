import { expect, it } from 'vitest';
import type { ChatMessage } from './messages';
import { projectLegacyProviderNotice } from './project-legacy-provider-notice';
import { readCodexReconnectTitle } from './provider-session-notice';

const base = { id: 'history-1', order: 2, timestamp: '2026-11-20T00:00:00.000Z' };

it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])(
  'projects the standalone Claude history marker %s',
  (text) => {
    const row: ChatMessage = { ...base, source: 'user', text };
    expect(projectLegacyProviderNotice(row, 'CLAUDE')).toMatchObject({
      ...base,
      source: 'agent',
      message: { type: 'session_notice', notice: { title: 'Request interrupted' } },
    });
    expect(projectLegacyProviderNotice(row, 'CODEX')).toBe(row);
  }
);

it('projects an old Codex retry without implying that it is still in progress', () => {
  const row: ChatMessage = {
    ...base,
    source: 'agent',
    message: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Warning: Reconnecting... 2/5\n\n' }],
      },
    },
  };
  expect(projectLegacyProviderNotice(row, 'CODEX')).toMatchObject({
    ...base,
    message: {
      type: 'session_notice',
      notice: { reconnect: 'ended', title: 'Reconnecting... 2/5' },
    },
  });
  expect(projectLegacyProviderNotice(row, 'CLAUDE')).toBe(row);
});

it.each([
  'Example: Reconnecting... 2/5',
  'Reconnecting... 2/5\n\nThe answer.',
  '[Reconnecting... 2/5](https://example.com)',
  'Reconnecting... 9/5',
])('keeps lookalike text as conversation content %s', (text) => {
  const row: ChatMessage = {
    ...base,
    source: 'agent',
    message: { type: 'assistant', message: { role: 'assistant', content: text } },
  };
  expect(projectLegacyProviderNotice(row, 'CODEX')).toBe(row);
});

it('reads progress only from a known retry title', () => {
  expect(readCodexReconnectTitle('Reconnecting… 2/5')).toEqual({ progress: 'Attempt 2 of 5' });
  expect(readCodexReconnectTitle('Reconnecting... waiting for network')).toEqual({});
});

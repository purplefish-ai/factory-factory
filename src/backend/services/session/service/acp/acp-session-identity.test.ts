import { expect, it } from 'vitest';
import { toAcpSessionId } from './acp-session-identity';

it('normalizes legacy Codex identities without changing Claude or native IDs', () => {
  expect(toAcpSessionId('CODEX', 'sess_thread-1')).toBe('thread-1');
  expect(toAcpSessionId('CODEX', 'thread-1')).toBe('thread-1');
  expect(toAcpSessionId('CLAUDE', 'sess_thread-1')).toBe('sess_thread-1');
});

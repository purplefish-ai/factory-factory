import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { ClaudeProcess } from './process';

type TestClaudeProcess = EventEmitter & {
  protocol: EventEmitter;
  monitor: { recordActivity: () => void };
  status: string;
  claudeSessionId: string | null;
  process: { pid: number };
  stderrBuffer: string[];
  isIntentionallyStopping: boolean;
  setupEventForwarding: () => void;
};

describe('ClaudeProcess', () => {
  it('records activity on keep_alive events', () => {
    const protocol = new EventEmitter();
    const recordActivity = vi.fn();

    const claudeProcess = unsafeCoerce<TestClaudeProcess>(new EventEmitter());
    Object.setPrototypeOf(claudeProcess, ClaudeProcess.prototype);

    claudeProcess.protocol = protocol;
    claudeProcess.monitor = { recordActivity };
    claudeProcess.status = 'ready';
    claudeProcess.claudeSessionId = null;
    claudeProcess.process = { pid: 12_345 };
    claudeProcess.stderrBuffer = [];
    claudeProcess.isIntentionallyStopping = false;

    claudeProcess.setupEventForwarding();

    protocol.emit('keep_alive', { type: 'keep_alive' });

    expect(recordActivity).toHaveBeenCalledTimes(1);
  });
});

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { createTestEventLog } from '@/test-utils/test-event-log';

export class MockWebSocket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  bufferedAmount = 0;
  readonly sent = createTestEventLog<string>();
  send = vi.fn((payload: string, callback?: (error?: Error) => void) => {
    this.sent.record(payload);
    if (callback) {
      queueMicrotask(callback);
    }
  });
  close = vi.fn<(code?: number, reason?: string) => void>();
  terminate = vi.fn<() => void>();
}

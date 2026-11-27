import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { deferred } from '@/test-utils/deferred';
import { createQueueMessageHandler } from './queue-message.handler';

// The sandbox's `after-message-queued` crash point must be reached by every accepted message,
// whoever dispatches: a dispatch that runs while the message waits for admission cannot take it.

const ORIGINAL_ENV = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-crash-points-'));
  process.env.FF_SANDBOX_SCENARIO = 'echo';
  process.env.FF_SANDBOX_CRASH_POINT_DIR = dir;
  configService.reload();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  configService.reload();
  rmSync(dir, { recursive: true, force: true });
});

it('reaches after-message-queued even when a dispatch runs during admission', async () => {
  const domain = new SessionDomainService();
  const admission = deferred();
  const dispatched: unknown[] = [];
  const dispatch = (sessionId: string) => {
    dispatched.push(domain.dequeueNext(sessionId));
    return Promise.resolve();
  };
  const queuedAtCrash: string[][] = [];
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    queuedAtCrash.push(domain.getQueueSnapshot('session').map((message) => message.id));
    return true;
  });
  writeFileSync(join(dir, 'after-message-queued'), '');
  const handler = createQueueMessageHandler({
    domain,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: vi.fn().mockResolvedValue(undefined),
    },
    humanMessageAccepted: () => admission.promise,
    tryDispatchNextMessage: dispatch,
  });
  try {
    const accepted = handler(
      { sessionId: 'session', workingDir: '/tmp' },
      { type: 'queue_message', id: 'human', text: 'continue' }
    );
    // The runtime goes idle while the message waits for admission.
    await dispatch('session');
    expect(dispatched).toEqual([undefined]);
    admission.resolve();
    await accepted;
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGKILL');
    expect(queuedAtCrash).toEqual([['human']]);
  } finally {
    kill.mockRestore();
    domain.clearSession('session');
  }
});

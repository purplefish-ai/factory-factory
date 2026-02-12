import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RatchetSessionBridge } from './bridges';

vi.mock('./fixer-session.service', () => ({
  fixerSessionService: {
    acquireAndDispatch: vi.fn(),
    getActiveSession: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ciFixerService } from './ci-fixer.service';
import { fixerSessionService } from './fixer-session.service';

const mockSessionBridge: RatchetSessionBridge = {
  isSessionRunning: vi.fn(),
  isSessionWorking: vi.fn(),
  stopSession: vi.fn(),
  startSession: vi.fn(),
  getClient: vi.fn(),
  injectCommittedUserMessage: vi.fn(),
};

describe('CIFixerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ciFixerService.configure({ session: mockSessionBridge });
  });

  it('returns started when shared fixer service starts a session', async () => {
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 's1',
    });

    const result = await ciFixerService.triggerCIFix({
      workspaceId: 'w1',
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
    });

    expect(result).toEqual({ status: 'started', sessionId: 's1' });
  });

  it('returns already_fixing when shared fixer service returns already_active', async () => {
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'already_active',
      sessionId: 's1',
      reason: 'working',
    });

    const result = await ciFixerService.triggerCIFix({
      workspaceId: 'w1',
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
    });

    expect(result).toEqual({ status: 'already_fixing', sessionId: 's1' });
  });

  it('returns skipped when shared fixer service cannot acquire session', async () => {
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'skipped',
      reason: 'Workspace session limit reached',
    });

    const result = await ciFixerService.triggerCIFix({
      workspaceId: 'w1',
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'Workspace session limit reached' });
  });

  it('returns error when shared fixer service errors', async () => {
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'error',
      error: 'boom',
    });

    const result = await ciFixerService.triggerCIFix({
      workspaceId: 'w1',
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
    });

    expect(result).toEqual({ status: 'error', error: 'boom' });
  });

  it('checks active session working status', async () => {
    vi.mocked(fixerSessionService.getActiveSession).mockResolvedValue({
      id: 's1',
      status: SessionStatus.RUNNING,
    });
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(true);

    await expect(ciFixerService.isFixingInProgress('w1')).resolves.toBe(true);
  });

  it('notifies CI passed when running client exists', async () => {
    vi.mocked(fixerSessionService.getActiveSession).mockResolvedValue({
      id: 's1',
      status: SessionStatus.RUNNING,
    });

    const client = {
      isRunning: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(mockSessionBridge.getClient).mockReturnValue(client);

    await expect(ciFixerService.notifyCIPassed('w1')).resolves.toBe(true);
    expect(client.sendMessage).toHaveBeenCalled();
  });
});

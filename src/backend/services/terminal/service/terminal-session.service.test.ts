import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalSessionAccessor } from '@/backend/services/terminal/resources/terminal-session.accessor';
import { terminalSessionService } from './terminal-session.service';

vi.mock('@/backend/services/terminal/resources/terminal-session.accessor', () => ({
  terminalSessionAccessor: {
    findWithPid: vi.fn(),
    update: vi.fn(),
  },
}));

describe('terminalSessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks sessions idle and clears their pid when the process no longer exists', async () => {
    vi.mocked(terminalSessionAccessor.findWithPid).mockResolvedValue([
      { id: 'terminal-session-1', pid: 12_345 },
    ] as never);
    vi.mocked(terminalSessionAccessor.update).mockResolvedValue({} as never);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('No such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    await expect(terminalSessionService.recoverOrphanedSessions()).resolves.toBe(1);

    expect(terminalSessionAccessor.update).toHaveBeenCalledWith('terminal-session-1', {
      status: 'IDLE',
      pid: null,
    });
  });

  it('treats EPERM as an alive process and preserves the session', async () => {
    vi.mocked(terminalSessionAccessor.findWithPid).mockResolvedValue([
      { id: 'terminal-session-1', pid: 12_345 },
    ] as never);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('Operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    await expect(terminalSessionService.recoverOrphanedSessions()).resolves.toBe(0);

    expect(terminalSessionAccessor.update).not.toHaveBeenCalled();
  });
});

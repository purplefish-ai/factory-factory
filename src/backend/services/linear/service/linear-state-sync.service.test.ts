import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTransitionIssueState = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('./linear-client.service', () => ({
  linearClientService: {
    transitionIssueState: (...args: unknown[]) => mockTransitionIssueState(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    get info() {
      return vi.fn();
    },
    get debug() {
      return vi.fn();
    },
    get warn() {
      return mockLoggerWarn;
    },
    get error() {
      return vi.fn();
    },
  }),
}));

import { linearStateSyncService } from './linear-state-sync.service';

describe('LinearStateSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('markIssueStarted', () => {
    it('transitions issue to started state', async () => {
      mockTransitionIssueState.mockResolvedValue(undefined);

      await linearStateSyncService.markIssueStarted('linear-api-key', 'issue-1');

      expect(mockTransitionIssueState).toHaveBeenCalledWith('linear-api-key', 'issue-1', 'started');
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('logs warning when transition fails', async () => {
      mockTransitionIssueState.mockRejectedValue(new Error('Network error'));

      await linearStateSyncService.markIssueStarted('linear-api-key', 'issue-1');

      expect(mockLoggerWarn).toHaveBeenCalledWith('Failed to mark Linear issue as started', {
        issueId: 'issue-1',
        error: 'Network error',
      });
    });
  });

  describe('markIssueCompleted', () => {
    it('transitions issue to completed state', async () => {
      mockTransitionIssueState.mockResolvedValue(undefined);

      await linearStateSyncService.markIssueCompleted('linear-api-key', 'issue-2');

      expect(mockTransitionIssueState).toHaveBeenCalledWith(
        'linear-api-key',
        'issue-2',
        'completed'
      );
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('logs warning when transition fails', async () => {
      mockTransitionIssueState.mockRejectedValue(new Error('Timeout'));

      await linearStateSyncService.markIssueCompleted('linear-api-key', 'issue-2');

      expect(mockLoggerWarn).toHaveBeenCalledWith('Failed to mark Linear issue as completed', {
        issueId: 'issue-2',
        error: 'Timeout',
      });
    });
  });
});

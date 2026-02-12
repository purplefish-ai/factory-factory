import { describe, expect, it } from 'vitest';
import { computeKanbanColumn } from './kanban-state';

describe('computeKanbanColumn', () => {
  describe('archived workspaces', () => {
    it('should return null for ARCHIVED status (use cachedKanbanColumn instead)', () => {
      const result = computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBeNull();
    });

    it('should return null for ARCHIVED even with open PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: false,
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBeNull();
    });
  });

  describe('WORKING column - initializing states', () => {
    it('should return WORKING for NEW status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'NEW',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('WORKING');
    });

    it('should return WORKING for PROVISIONING status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'PROVISIONING',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('WORKING');
    });

    it('should return WORKING for FAILED status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'FAILED',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('WORKING');
    });

    it('should return WORKING for FAILED even if had sessions', () => {
      const result = computeKanbanColumn({
        lifecycle: 'FAILED',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: true,
      });
      expect(result).toBe('WORKING');
    });
  });

  describe('WORKING column - actively working', () => {
    it('should return WORKING when isWorking is true', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('WORKING');
    });

    it('should return WORKING when working, even with open PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBe('WORKING');
    });

    it('should return WORKING when working, even with approved PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'APPROVED',
        hasHadSessions: true,
      });
      expect(result).toBe('WORKING');
    });
  });

  describe('DONE column - merged PRs', () => {
    it('should return DONE for merged PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'MERGED',
        hasHadSessions: true,
      });
      expect(result).toBe('DONE');
    });

    it('should return DONE for merged PR even without prior sessions', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'MERGED',
        hasHadSessions: false,
      });
      expect(result).toBe('DONE');
    });
  });

  describe('hidden workspaces (return null)', () => {
    it('should return null if never had sessions (hidden from view)', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBeNull();
    });

    it('should return null if no sessions even with closed PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'CLOSED',
        hasHadSessions: false,
      });
      expect(result).toBeNull();
    });
  });

  describe('WAITING column - idle workspaces with sessions', () => {
    it('should return WAITING if had sessions but no PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: true,
      });
      expect(result).toBe('WAITING');
    });

    it('should return WAITING if had sessions and PR was closed', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'CLOSED',
        hasHadSessions: true,
      });
      expect(result).toBe('WAITING');
    });

    it('should return WAITING for approved PR (waiting for merge)', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'APPROVED',
        hasHadSessions: true,
      });
      expect(result).toBe('WAITING');
    });

    it('should return WAITING for draft PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'DRAFT',
        hasHadSessions: true,
      });
      expect(result).toBe('WAITING');
    });

    it('should return WAITING for open PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBe('WAITING');
    });

    it('should return WAITING for PR with changes requested', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'CHANGES_REQUESTED',
        hasHadSessions: true,
      });
      expect(result).toBe('WAITING');
    });
  });

  describe('edge cases', () => {
    it('should prioritize ARCHIVED over isWorking', () => {
      const result = computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: true, // Even if somehow working
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBeNull();
    });

    it('should return WORKING for NEW even if isWorking flag is set', () => {
      const result = computeKanbanColumn({
        lifecycle: 'NEW',
        isWorking: true,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('WORKING');
    });

    it('should prioritize isWorking over PR state for READY', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'MERGED', // Even with merged PR
        hasHadSessions: true,
      });
      expect(result).toBe('WORKING');
    });
  });
});

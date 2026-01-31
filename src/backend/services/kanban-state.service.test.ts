import { describe, expect, it } from 'vitest';
import { computeKanbanColumn } from './kanban-state.service';

describe('computeKanbanColumn', () => {
  describe('status-based routing (before PR logic)', () => {
    it('should return DONE for ARCHIVED status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('DONE');
    });

    it('should return DONE for ARCHIVED even with open PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: false,
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBe('DONE');
    });

    it('should return BACKLOG for NEW status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'NEW',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('BACKLOG');
    });

    it('should return BACKLOG for PROVISIONING status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'PROVISIONING',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('BACKLOG');
    });

    it('should return BACKLOG for FAILED status', () => {
      const result = computeKanbanColumn({
        lifecycle: 'FAILED',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('BACKLOG');
    });

    it('should return BACKLOG for FAILED even if had sessions', () => {
      const result = computeKanbanColumn({
        lifecycle: 'FAILED',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: true,
      });
      expect(result).toBe('BACKLOG');
    });
  });

  describe('READY status - activity-based routing', () => {
    it('should return IN_PROGRESS when isWorking is true', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('IN_PROGRESS');
    });

    it('should return IN_PROGRESS when working, even with open PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBe('IN_PROGRESS');
    });

    it('should return IN_PROGRESS when working, even with approved PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'APPROVED',
        hasHadSessions: true,
      });
      expect(result).toBe('IN_PROGRESS');
    });
  });

  describe('READY status - PR-based routing', () => {
    it('should return MERGED for merged PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'MERGED',
        hasHadSessions: true,
      });
      expect(result).toBe('MERGED');
    });

    it('should return APPROVED for approved PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'APPROVED',
        hasHadSessions: true,
      });
      expect(result).toBe('APPROVED');
    });

    it('should return PR_OPEN for draft PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'DRAFT',
        hasHadSessions: true,
      });
      expect(result).toBe('PR_OPEN');
    });

    it('should return PR_OPEN for open PR', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBe('PR_OPEN');
    });

    it('should return PR_OPEN for PR with changes requested', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'CHANGES_REQUESTED',
        hasHadSessions: true,
      });
      expect(result).toBe('PR_OPEN');
    });
  });

  describe('READY status - idle routing (no PR)', () => {
    it('should return BACKLOG if never had sessions', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('BACKLOG');
    });

    it('should return BACKLOG if had sessions but PR was closed', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: false,
        prState: 'CLOSED',
        hasHadSessions: false,
      });
      expect(result).toBe('BACKLOG');
    });

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
  });

  describe('edge cases', () => {
    it('should prioritize ARCHIVED over isWorking', () => {
      const result = computeKanbanColumn({
        lifecycle: 'ARCHIVED',
        isWorking: true, // Even if somehow working
        prState: 'OPEN',
        hasHadSessions: true,
      });
      expect(result).toBe('DONE');
    });

    it('should prioritize NEW/PROVISIONING/FAILED over isWorking', () => {
      // Even if isWorking is true for a NEW workspace (shouldn't happen in practice),
      // it should still be in BACKLOG
      const result = computeKanbanColumn({
        lifecycle: 'NEW',
        isWorking: true,
        prState: 'NONE',
        hasHadSessions: false,
      });
      expect(result).toBe('BACKLOG');
    });

    it('should prioritize isWorking over PR state for READY', () => {
      const result = computeKanbanColumn({
        lifecycle: 'READY',
        isWorking: true,
        prState: 'MERGED', // Even with merged PR
        hasHadSessions: true,
      });
      expect(result).toBe('IN_PROGRESS');
    });
  });
});

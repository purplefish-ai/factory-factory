import { describe, expect, it } from 'vitest';
import { getDefaultWorkflowForWorkspace, selectWorkflowForGitHubIssue } from './workflow-selection';

describe('workflow-selection', () => {
  describe('selectWorkflowForGitHubIssue', () => {
    it('should select bugfix-orchestrated for issues with bug label', () => {
      const labels = [{ name: 'bug' }, { name: 'high-priority' }];
      expect(selectWorkflowForGitHubIssue(labels)).toBe('bugfix-orchestrated');
    });

    it('should select bugfix-orchestrated for issues with Bug label (case-insensitive)', () => {
      const labels = [{ name: 'Bug' }, { name: 'frontend' }];
      expect(selectWorkflowForGitHubIssue(labels)).toBe('bugfix-orchestrated');
    });

    it('should select bugfix-orchestrated for issues with BUG label (uppercase)', () => {
      const labels = [{ name: 'BUG' }];
      expect(selectWorkflowForGitHubIssue(labels)).toBe('bugfix-orchestrated');
    });

    it('should select feature-orchestrated for issues without bug label', () => {
      const labels = [{ name: 'enhancement' }, { name: 'good first issue' }];
      expect(selectWorkflowForGitHubIssue(labels)).toBe('feature-orchestrated');
    });

    it('should select feature-orchestrated for issues with no labels', () => {
      const labels: Array<{ name: string }> = [];
      expect(selectWorkflowForGitHubIssue(labels)).toBe('feature-orchestrated');
    });

    it('should not match partial bug label names', () => {
      const labels = [{ name: 'bugfix' }, { name: 'debug' }];
      expect(selectWorkflowForGitHubIssue(labels)).toBe('feature-orchestrated');
    });
  });

  describe('getDefaultWorkflowForWorkspace', () => {
    it('should use bugfix-orchestrated for GitHub issue with bug label', () => {
      const labels = [{ name: 'bug' }];
      expect(getDefaultWorkflowForWorkspace('GITHUB_ISSUE', labels)).toBe('bugfix-orchestrated');
    });

    it('should use feature-orchestrated for GitHub issue without bug label', () => {
      const labels = [{ name: 'enhancement' }];
      expect(getDefaultWorkflowForWorkspace('GITHUB_ISSUE', labels)).toBe('feature-orchestrated');
    });

    it('should use feature-orchestrated for GitHub issue with no labels', () => {
      const labels: Array<{ name: string }> = [];
      expect(getDefaultWorkflowForWorkspace('GITHUB_ISSUE', labels)).toBe('feature-orchestrated');
    });

    it('should use feature-orchestrated for GitHub issue when labels are undefined', () => {
      expect(getDefaultWorkflowForWorkspace('GITHUB_ISSUE', undefined)).toBe(
        'feature-orchestrated'
      );
    });

    it('should use followup for manual workspace creation', () => {
      expect(getDefaultWorkflowForWorkspace('MANUAL')).toBe('followup');
    });

    it('should use followup for resumed branch workspace', () => {
      expect(getDefaultWorkflowForWorkspace('RESUME_BRANCH')).toBe('followup');
    });

    it('should ignore labels for manual workspace creation', () => {
      const labels = [{ name: 'bug' }];
      expect(getDefaultWorkflowForWorkspace('MANUAL', labels)).toBe('followup');
    });

    it('should ignore labels for resumed branch workspace', () => {
      const labels = [{ name: 'bug' }];
      expect(getDefaultWorkflowForWorkspace('RESUME_BRANCH', labels)).toBe('followup');
    });
  });
});

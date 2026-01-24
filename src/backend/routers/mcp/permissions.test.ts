import { AgentType } from '@prisma-gen/client';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_PERMISSIONS, checkToolPermissions, matchPattern } from './permissions';

describe('matchPattern', () => {
  describe('exact matches', () => {
    it('should match exact tool names', () => {
      expect(matchPattern('mcp__mail__send', 'mcp__mail__send')).toBe(true);
    });

    it('should not match different tool names', () => {
      expect(matchPattern('mcp__mail__send', 'mcp__mail__receive')).toBe(false);
    });
  });

  describe('wildcard matches', () => {
    it('should match wildcard at end', () => {
      expect(matchPattern('mcp__mail__send', 'mcp__mail__*')).toBe(true);
      expect(matchPattern('mcp__mail__receive', 'mcp__mail__*')).toBe(true);
      expect(matchPattern('mcp__mail__list_inbox', 'mcp__mail__*')).toBe(true);
    });

    it('should match all tools with single wildcard', () => {
      expect(matchPattern('mcp__mail__send', '*')).toBe(true);
      expect(matchPattern('mcp__task__create', '*')).toBe(true);
      expect(matchPattern('anything_at_all', '*')).toBe(true);
    });

    it('should not match wrong prefix with wildcard', () => {
      expect(matchPattern('mcp__task__create', 'mcp__mail__*')).toBe(false);
    });

    it('should handle middle wildcards', () => {
      expect(matchPattern('mcp__mail__send', 'mcp__*__send')).toBe(true);
      expect(matchPattern('mcp__task__send', 'mcp__*__send')).toBe(true);
      expect(matchPattern('mcp__mail__receive', 'mcp__*__send')).toBe(false);
    });
  });

  describe('special regex characters', () => {
    it('should escape special regex characters in pattern', () => {
      expect(matchPattern('mcp.mail.send', 'mcp.mail.send')).toBe(true);
      expect(matchPattern('mcp_mail_send', 'mcp.mail.send')).toBe(false);
    });
  });
});

describe('checkToolPermissions', () => {
  describe('SUPERVISOR permissions', () => {
    it('should allow all tools for supervisors', () => {
      const result = checkToolPermissions(AgentType.SUPERVISOR, 'mcp__task__create');
      expect(result.allowed).toBe(true);
    });

    it('should allow mail tools for supervisors', () => {
      const result = checkToolPermissions(AgentType.SUPERVISOR, 'mcp__mail__send');
      expect(result.allowed).toBe(true);
    });

    it('should allow orchestrator tools for supervisors', () => {
      const result = checkToolPermissions(AgentType.SUPERVISOR, 'mcp__orchestrator__restart');
      expect(result.allowed).toBe(true);
    });
  });

  describe('ORCHESTRATOR permissions', () => {
    // NOTE: Orchestrator-specific tools were removed - functionality moved to reconciler service

    it('should allow mail tools for orchestrators', () => {
      const result = checkToolPermissions(AgentType.ORCHESTRATOR, 'mcp__mail__send');
      expect(result.allowed).toBe(true);
    });

    it('should allow agent tools for orchestrators', () => {
      const result = checkToolPermissions(AgentType.ORCHESTRATOR, 'mcp__agent__get_status');
      expect(result.allowed).toBe(true);
    });

    it('should allow system tools for orchestrators', () => {
      const result = checkToolPermissions(AgentType.ORCHESTRATOR, 'mcp__system__log_decision');
      expect(result.allowed).toBe(true);
    });

    it('should deny task tools for orchestrators', () => {
      const result = checkToolPermissions(AgentType.ORCHESTRATOR, 'mcp__task__list');
      expect(result.allowed).toBe(false);
    });

    it('should deny git tools for orchestrators', () => {
      const result = checkToolPermissions(AgentType.ORCHESTRATOR, 'mcp__git__commit');
      expect(result.allowed).toBe(false);
    });
  });

  describe('WORKER permissions', () => {
    it('should allow mail tools for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__mail__send');
      expect(result.allowed).toBe(true);
    });

    it('should allow agent status tools for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__agent__get_status');
      expect(result.allowed).toBe(true);
    });

    it('should allow task update_state for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__task__update_state');
      expect(result.allowed).toBe(true);
    });

    it('should allow git tools for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__git__commit');
      expect(result.allowed).toBe(true);
    });

    it('should deny task create for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__task__create');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disallowed');
    });

    it('should deny task approve for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__task__approve');
      expect(result.allowed).toBe(false);
    });

    it('should deny task request_changes for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__task__request_changes');
      expect(result.allowed).toBe(false);
    });

    it('should deny unknown tools for workers', () => {
      // Orchestrator tools no longer exist, but any unknown tool should be denied
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__unknown__restart');
      expect(result.allowed).toBe(false);
    });

    it('should deny git read_worktree_file for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__git__read_worktree_file');
      expect(result.allowed).toBe(false);
    });
  });

  describe('disallow takes precedence', () => {
    it('should deny disallowed tool even if pattern would allow', () => {
      // Workers have mcp__git__* allowed but mcp__git__read_worktree_file disallowed
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__git__read_worktree_file');
      expect(result.allowed).toBe(false);
    });
  });

  describe('unknown tools', () => {
    it('should deny unknown tools for workers', () => {
      const result = checkToolPermissions(AgentType.WORKER, 'mcp__unknown__tool');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed list');
    });
  });
});

describe('AGENT_TOOL_PERMISSIONS configuration', () => {
  describe('SUPERVISOR', () => {
    it('should have wildcard allow', () => {
      expect(AGENT_TOOL_PERMISSIONS[AgentType.SUPERVISOR].allowed).toContain('*');
    });

    it('should have no disallowed tools', () => {
      expect(AGENT_TOOL_PERMISSIONS[AgentType.SUPERVISOR].disallowed).toHaveLength(0);
    });
  });

  describe('ORCHESTRATOR', () => {
    // NOTE: Orchestrator-specific tools were removed - functionality moved to reconciler service

    it('should have mail tools allowed', () => {
      expect(AGENT_TOOL_PERMISSIONS[AgentType.ORCHESTRATOR].allowed).toContain('mcp__mail__*');
    });

    it('should have agent tools allowed', () => {
      expect(AGENT_TOOL_PERMISSIONS[AgentType.ORCHESTRATOR].allowed).toContain('mcp__agent__*');
    });

    it('should have system tools allowed', () => {
      expect(AGENT_TOOL_PERMISSIONS[AgentType.ORCHESTRATOR].allowed).toContain('mcp__system__*');
    });
  });

  describe('WORKER', () => {
    it('should have limited allowed tools', () => {
      const allowed = AGENT_TOOL_PERMISSIONS[AgentType.WORKER].allowed;
      expect(allowed).toContain('mcp__mail__*');
      expect(allowed).toContain('mcp__git__*');
      expect(allowed).toContain('mcp__task__update_state');
    });

    it('should have supervisor-only tools disallowed', () => {
      const disallowed = AGENT_TOOL_PERMISSIONS[AgentType.WORKER].disallowed;
      expect(disallowed).toContain('mcp__task__create');
      expect(disallowed).toContain('mcp__task__approve');
      expect(disallowed).toContain('mcp__git__read_worktree_file');
    });
  });
});

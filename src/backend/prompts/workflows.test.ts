import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWorkflowCache,
  DEFAULT_FIRST_SESSION,
  DEFAULT_FOLLOWUP,
  getWorkflow,
  getWorkflowContent,
  listWorkflows,
} from './workflows';

// =============================================================================
// Test Setup
// =============================================================================

describe('workflows', () => {
  afterEach(() => {
    // Clear the cache between tests to ensure isolation
    clearWorkflowCache();
  });

  // ===========================================================================
  // listWorkflows Tests
  // ===========================================================================

  describe('listWorkflows', () => {
    it('should return an array of workflows', () => {
      const workflows = listWorkflows();
      expect(Array.isArray(workflows)).toBe(true);
    });

    it('should load all workflow files from prompts/workflows/', () => {
      const workflows = listWorkflows();
      // We know there are at least 4 workflow files: bugfix, explore, feature, followup
      expect(workflows.length).toBeGreaterThanOrEqual(4);
    });

    it('should include expected workflow IDs', () => {
      const workflows = listWorkflows();
      const ids = workflows.map((w) => w.id);

      expect(ids).toContain('feature');
      expect(ids).toContain('bugfix');
      expect(ids).toContain('explore');
      expect(ids).toContain('followup');
    });

    it('should parse workflow metadata correctly', () => {
      const workflows = listWorkflows();
      const feature = workflows.find((w) => w.id === 'feature');

      expect(feature).toBeDefined();
      expect(feature?.name).toBe('Feature');
      expect(feature?.description).toBe('End-to-end feature implementation with PR creation');
      expect(feature?.expectsPR).toBe(true);
    });

    it('should parse expectsPR as false when specified', () => {
      const workflows = listWorkflows();
      const explore = workflows.find((w) => w.id === 'explore');

      expect(explore).toBeDefined();
      expect(explore?.expectsPR).toBe(false);
    });

    it('should cache results after first call', () => {
      const workflows1 = listWorkflows();
      const workflows2 = listWorkflows();

      // Should return the same array instance (cached)
      expect(workflows1).toBe(workflows2);
    });
  });

  // ===========================================================================
  // getWorkflow Tests
  // ===========================================================================

  describe('getWorkflow', () => {
    it('should return a workflow by ID', () => {
      const workflow = getWorkflow('feature');

      expect(workflow).toBeDefined();
      expect(workflow?.id).toBe('feature');
      expect(workflow?.name).toBe('Feature');
    });

    it('should return null for non-existent workflow', () => {
      const workflow = getWorkflow('nonexistent-workflow-id');
      expect(workflow).toBeNull();
    });

    it('should return workflow with content', () => {
      const workflow = getWorkflow('feature');

      expect(workflow?.content).toBeDefined();
      expect(workflow?.content.length).toBeGreaterThan(0);
      expect(workflow?.content).toContain('Feature Implementation Workflow');
    });

    it('should strip frontmatter from content', () => {
      const workflow = getWorkflow('feature');

      // Content should not start with frontmatter delimiters or contain metadata keys
      expect(workflow?.content).not.toMatch(/^---/);
      expect(workflow?.content).not.toContain('expectsPR:');
    });
  });

  // ===========================================================================
  // getWorkflowContent Tests
  // ===========================================================================

  describe('getWorkflowContent', () => {
    it('should return content string for existing workflow', () => {
      const content = getWorkflowContent('feature');

      expect(content).toBeDefined();
      expect(typeof content).toBe('string');
      expect(content?.length).toBeGreaterThan(0);
    });

    it('should return null for non-existent workflow', () => {
      const content = getWorkflowContent('nonexistent-workflow-id');
      expect(content).toBeNull();
    });

    it('should return markdown content without frontmatter', () => {
      const content = getWorkflowContent('bugfix');

      expect(content).toContain('Bug Fix Workflow');
      expect(content).not.toMatch(/^---/);
      expect(content).not.toContain('expectsPR:');
    });
  });

  // ===========================================================================
  // Constants Tests
  // ===========================================================================

  describe('constants', () => {
    it('should have valid DEFAULT_FIRST_SESSION workflow', () => {
      const workflow = getWorkflow(DEFAULT_FIRST_SESSION);
      expect(workflow).toBeDefined();
      expect(workflow?.id).toBe('feature');
    });

    it('should have valid DEFAULT_FOLLOWUP workflow', () => {
      const workflow = getWorkflow(DEFAULT_FOLLOWUP);
      expect(workflow).toBeDefined();
      expect(workflow?.id).toBe('followup');
    });
  });

  // ===========================================================================
  // clearWorkflowCache Tests
  // ===========================================================================

  describe('clearWorkflowCache', () => {
    it('should clear the cache and allow fresh reload', () => {
      const workflows1 = listWorkflows();
      clearWorkflowCache();
      const workflows2 = listWorkflows();

      // After clearing cache, should be a new array instance
      expect(workflows1).not.toBe(workflows2);

      // But should have the same content
      expect(workflows1.length).toBe(workflows2.length);
    });
  });

  // ===========================================================================
  // Workflow Content Tests
  // ===========================================================================

  describe('workflow content', () => {
    it('should have meaningful content for all workflows', () => {
      const workflows = listWorkflows();

      for (const workflow of workflows) {
        expect(workflow.content.length).toBeGreaterThan(100);
        expect(workflow.content).toContain('#'); // Should have markdown headers
      }
    });

    it('should have descriptions for all workflows', () => {
      const workflows = listWorkflows();

      for (const workflow of workflows) {
        expect(workflow.description.length).toBeGreaterThan(10);
      }
    });

    it('should have proper names for all workflows', () => {
      const workflows = listWorkflows();

      for (const workflow of workflows) {
        // Name should be capitalized (first letter uppercase)
        expect(workflow.name[0]!).toBe(workflow.name[0]!.toUpperCase());
      }
    });
  });
});

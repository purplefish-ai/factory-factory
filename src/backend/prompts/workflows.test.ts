import { describe, expect, it } from 'vitest';
import { getWorkflow, getWorkflowContent } from './workflows';

// =============================================================================
// Test Setup
// =============================================================================

describe('workflows', () => {
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

      // Content should not contain the frontmatter delimiters or metadata
      expect(workflow?.content).not.toContain('---');
      expect(workflow?.content).not.toContain('expectsPR:');
    });

    it('should parse workflow metadata correctly', () => {
      const feature = getWorkflow('feature');

      expect(feature).toBeDefined();
      expect(feature?.name).toBe('Feature');
      expect(feature?.description).toBe('End-to-end feature implementation with PR creation');
      expect(feature?.expectsPR).toBe(true);
    });

    it('should parse expectsPR as false when specified', () => {
      const explore = getWorkflow('explore');

      expect(explore).toBeDefined();
      expect(explore?.expectsPR).toBe(false);
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
      expect(content).not.toContain('---');
    });
  });

  // ===========================================================================
  // Workflow Content Tests
  // ===========================================================================

  describe('workflow content', () => {
    it('should have meaningful content for known workflows', () => {
      const knownWorkflows = ['feature', 'bugfix', 'explore', 'followup'];

      for (const id of knownWorkflows) {
        const workflow = getWorkflow(id);
        expect(workflow).toBeDefined();
        expect(workflow?.content.length).toBeGreaterThan(100);
        expect(workflow?.content).toContain('#'); // Should have markdown headers
      }
    });

    it('should have descriptions for known workflows', () => {
      const knownWorkflows = ['feature', 'bugfix', 'explore', 'followup'];

      for (const id of knownWorkflows) {
        const workflow = getWorkflow(id);
        expect(workflow).toBeDefined();
        expect(workflow?.description.length).toBeGreaterThan(10);
      }
    });

    it('should have proper names for known workflows', () => {
      const knownWorkflows = ['feature', 'bugfix', 'explore', 'followup'];

      for (const id of knownWorkflows) {
        const workflow = getWorkflow(id);
        expect(workflow).toBeDefined();
        // Name should be capitalized (first letter uppercase)
        expect(workflow?.name[0]).toBe(workflow?.name[0].toUpperCase());
      }
    });
  });
});

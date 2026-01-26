import { describe, expect, it } from 'vitest';
import { PromptBuilder } from './builder';

describe('PromptBuilder', () => {
  describe('addFile', () => {
    it('should load markdown files from prompts directory', () => {
      const builder = new PromptBuilder();
      const prompt = builder.addFile('worker-role.md').build();

      expect(prompt).toContain('Worker Agent');
      expect(prompt).toContain('Core Responsibilities');
    });

    it('should support chaining multiple files', () => {
      const builder = new PromptBuilder();
      const prompt = builder.addFile('worker-role.md').addFile('self-verification.md').build();

      expect(prompt).toContain('Worker Agent');
      expect(prompt).toContain('Self-Verification');
    });

    it('should throw when file does not exist', () => {
      const builder = new PromptBuilder();
      expect(() => builder.addFile('nonexistent.md')).toThrow();
    });
  });

  describe('addRaw', () => {
    it('should add raw content', () => {
      const builder = new PromptBuilder();
      const prompt = builder.addRaw('# Custom Section\n\nSome content here.').build();

      expect(prompt).toBe('# Custom Section\n\nSome content here.');
    });

    it('should trim whitespace from raw content', () => {
      const builder = new PromptBuilder();
      const prompt = builder.addRaw('  content with whitespace  \n\n').build();

      expect(prompt).toBe('content with whitespace');
    });
  });

  describe('build', () => {
    it('should join sections with markdown separators', () => {
      const builder = new PromptBuilder();
      const prompt = builder.addRaw('Section 1').addRaw('Section 2').addRaw('Section 3').build();

      expect(prompt).toBe('Section 1\n\n---\n\nSection 2\n\n---\n\nSection 3');
    });

    it('should return empty string for empty builder', () => {
      const builder = new PromptBuilder();
      expect(builder.build()).toBe('');
    });

    it('should handle single section without separator', () => {
      const builder = new PromptBuilder();
      const prompt = builder.addRaw('Only section').build();

      expect(prompt).toBe('Only section');
    });
  });

  describe('applyReplacements', () => {
    it('should replace placeholders in prompt', () => {
      const prompt = 'Agent YOUR_AGENT_ID is assigned to task TASK_ID';
      const result = PromptBuilder.applyReplacements(prompt, {
        YOUR_AGENT_ID: 'agent-123',
        TASK_ID: 'task-456',
      });

      expect(result).toBe('Agent agent-123 is assigned to task task-456');
    });

    it('should replace all occurrences of a placeholder', () => {
      const prompt = 'ID: YOUR_AGENT_ID, again: YOUR_AGENT_ID';
      const result = PromptBuilder.applyReplacements(prompt, {
        YOUR_AGENT_ID: 'agent-abc',
      });

      expect(result).toBe('ID: agent-abc, again: agent-abc');
    });

    it('should handle empty replacements', () => {
      const prompt = 'No replacements here';
      const result = PromptBuilder.applyReplacements(prompt, {});

      expect(result).toBe('No replacements here');
    });
  });

  describe('integration', () => {
    it('should compose a complete worker prompt', () => {
      const builder = new PromptBuilder();
      const prompt = builder
        .addFile('worker-role.md')
        .addFile('worker-workflow.md')
        .addFile('self-verification.md')
        .addRaw('## Your Assignment\n\nAgent ID: YOUR_AGENT_ID')
        .build();

      // Verify sections are present
      expect(prompt).toContain('Worker Agent');
      expect(prompt).toContain('Phase 1: Orientation');
      expect(prompt).toContain('Self-Verification');
      expect(prompt).toContain('Your Assignment');

      // Verify separator between sections
      expect(prompt).toContain('---');

      // Apply replacements
      const finalPrompt = PromptBuilder.applyReplacements(prompt, {
        YOUR_AGENT_ID: 'worker-xyz',
      });
      expect(finalPrompt).toContain('Agent ID: worker-xyz');
    });
  });
});

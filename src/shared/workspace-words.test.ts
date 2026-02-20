import { describe, expect, it } from 'vitest';
import {
  generateUniqueWorkspaceName,
  generateWorkspaceNameFromPrompt,
  pickRandomWord,
  WORKSPACE_WORDS,
} from './workspace-words';

describe('workspace-words', () => {
  describe('WORKSPACE_WORDS', () => {
    it('should have at least 50 words', () => {
      expect(WORKSPACE_WORDS.length).toBeGreaterThanOrEqual(50);
    });

    it('should only contain lowercase alphanumeric words', () => {
      for (const word of WORKSPACE_WORDS) {
        expect(word).toMatch(/^[a-z]+$/);
      }
    });

    it('should not have duplicates', () => {
      const unique = new Set(WORKSPACE_WORDS);
      expect(unique.size).toBe(WORKSPACE_WORDS.length);
    });
  });

  describe('pickRandomWord', () => {
    it('should return a word from the list', () => {
      const word = pickRandomWord();
      expect(WORKSPACE_WORDS).toContain(word);
    });

    it('should return different words over multiple calls (with high probability)', () => {
      const words = new Set<string>();
      for (let i = 0; i < 20; i++) {
        words.add(pickRandomWord());
      }
      // With 50+ words and 20 picks, we should get at least 5 different ones
      expect(words.size).toBeGreaterThanOrEqual(5);
    });
  });

  describe('generateUniqueWorkspaceName', () => {
    it('should return a word from the list when no existing names', () => {
      const name = generateUniqueWorkspaceName([]);
      expect(WORKSPACE_WORDS).toContain(name);
    });

    it('should return a different word when base word is taken', () => {
      // Run multiple times since pickRandomWord is random
      let foundDifferent = false;
      for (let i = 0; i < 100; i++) {
        const name = generateUniqueWorkspaceName(['tiger']);
        if (name !== 'tiger' && !name.startsWith('tiger-')) {
          foundDifferent = true;
          break;
        }
      }
      // With 50+ words, we should eventually pick a different one
      expect(foundDifferent).toBe(true);
    });

    it('should append -2 when base word is taken and random picks the same word', () => {
      // Mock by using all words except the first one as existing
      const allButFirst = WORKSPACE_WORDS.slice(1);
      const name = generateUniqueWorkspaceName(allButFirst);
      // Either it's the first word (not taken) or it's word-N (numbered variant)
      const isValidName = WORKSPACE_WORDS.includes(name) || /^[a-z]+-\d+$/.test(name);
      expect(isValidName).toBe(true);
    });

    it('should append incrementing numbers for conflicts', () => {
      // Force the conflict scenario by using all words as existing
      // This ensures we get a numbered variant
      const existing = [...WORKSPACE_WORDS];
      const name = generateUniqueWorkspaceName(existing);
      // Should be word-2 for some word
      expect(name).toMatch(/^[a-z]+-2$/);
    });

    it('should handle the scenario where base name and numbered variants are taken', () => {
      const existing = ['wolf', 'wolf-2', 'wolf-3', 'wolf-4', 'wolf-5'];

      // Run multiple times and check we never get a conflict
      for (let i = 0; i < 20; i++) {
        const name = generateUniqueWorkspaceName(existing);
        expect(existing).not.toContain(name);
      }
    });
  });

  describe('generateWorkspaceNameFromPrompt', () => {
    it('builds a workspace name from prompt content', () => {
      const name = generateWorkspaceNameFromPrompt('Fix duplicate branch name before push', []);
      expect(name).toBe('fix-duplicate-branch-name-before-push');
    });

    it('drops generic stop words from prompts', () => {
      const name = generateWorkspaceNameFromPrompt('Please help me fix auth bug in login flow', []);
      expect(name).toBe('fix-auth-bug-login-flow');
    });

    it('adds numeric suffix when generated prompt name already exists', () => {
      const name = generateWorkspaceNameFromPrompt('Fix auth bug in login flow', [
        'fix-auth-bug-login-flow',
      ]);
      expect(name).toBe('fix-auth-bug-login-flow-2');
    });

    it('falls back to random name when prompt has no usable text', () => {
      const name = generateWorkspaceNameFromPrompt('   ', []);
      const isValidName = WORKSPACE_WORDS.includes(name) || /^[a-z]+-\d+$/.test(name);
      expect(isValidName).toBe(true);
    });

    it('keeps incrementing suffix after 1000 collisions', () => {
      const baseName = 'fix-auth-bug-login-flow';
      const existing = [
        baseName,
        ...Array.from({ length: 999 }, (_, index) => `${baseName}-${index + 2}`),
      ];
      const name = generateWorkspaceNameFromPrompt('Fix auth bug in login flow', existing);
      expect(name).toBe(`${baseName}-1001`);
    });
  });
});

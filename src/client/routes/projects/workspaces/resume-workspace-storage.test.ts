import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetResumeWorkspace,
  isResumeWorkspace,
  readResumeWorkspaceIds,
  rememberResumeWorkspace,
} from './resume-workspace-storage';

describe('resume-workspace-storage', () => {
  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      clear: () => {
        store = {};
      },
    };
  })();

  beforeEach(() => {
    // Clear localStorage and reset mocks
    localStorageMock.clear();
    vi.clearAllMocks();

    // Set up window.localStorage
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
    });
  });

  describe('readResumeWorkspaceIds', () => {
    it('returns empty array when localStorage is empty', () => {
      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('returns parsed array from localStorage', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual(['ws-1', 'ws-2']);
    });

    it('handles malformed JSON gracefully', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', '{invalid json');

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('handles non-array JSON gracefully', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify({ not: 'array' }));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('handles array with non-string elements gracefully', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify([1, 2, 3]));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('handles mixed-type array gracefully', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1', 123, 'ws-2']));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });
  });

  describe('rememberResumeWorkspace', () => {
    it('adds workspace ID to empty list', () => {
      rememberResumeWorkspace('ws-1');

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1'])
      );
    });

    it('adds workspace ID to existing list', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1']));

      rememberResumeWorkspace('ws-2');

      expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1', 'ws-2'])
      );
    });

    it('does not add duplicate workspace IDs', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1']));

      rememberResumeWorkspace('ws-1');

      expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1'])
      );
    });

    it('trims list to last 200 entries', () => {
      const ids = Array.from({ length: 205 }, (_, i) => `ws-${i}`);
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(ids));

      rememberResumeWorkspace('ws-new');

      const savedValue = localStorageMock.setItem.mock.calls[
        localStorageMock.setItem.mock.calls.length - 1
      ]![1] as string;
      const savedIds = JSON.parse(savedValue) as string[];
      expect(savedIds).toHaveLength(200);
      expect(savedIds[savedIds.length - 1]).toBe('ws-new');
    });
  });

  describe('forgetResumeWorkspace', () => {
    it('removes workspace ID from list', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      forgetResumeWorkspace('ws-1');

      expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-2'])
      );
    });

    it('handles removing non-existent ID', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1']));

      forgetResumeWorkspace('ws-2');

      expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1'])
      );
    });
  });

  describe('isResumeWorkspace', () => {
    it('returns true for remembered workspace', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      expect(isResumeWorkspace('ws-1')).toBe(true);
    });

    it('returns false for non-remembered workspace', () => {
      localStorageMock.setItem('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      expect(isResumeWorkspace('ws-3')).toBe(false);
    });

    it('returns false when localStorage is empty', () => {
      expect(isResumeWorkspace('ws-1')).toBe(false);
    });
  });
});

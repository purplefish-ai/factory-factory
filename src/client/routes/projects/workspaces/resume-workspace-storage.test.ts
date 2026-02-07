import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeWorkspaceIdsSchema } from '@/shared/schemas/persisted-stores.schema';
import {
  forgetResumeWorkspace,
  isResumeWorkspace,
  readResumeWorkspaceIds,
  rememberResumeWorkspace,
} from './resume-workspace-storage';

const mockStorage = new Map<string, string>();

const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => mockStorage.set(key, value)),
  removeItem: vi.fn((key: string) => mockStorage.delete(key)),
  clear: vi.fn(() => mockStorage.clear()),
  get length() {
    return mockStorage.size;
  },
  key: vi.fn((index: number) => {
    const keys = Array.from(mockStorage.keys());
    return keys[index] ?? null;
  }),
};

describe('resume-workspace-storage', () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', mockLocalStorage);
    vi.stubGlobal('window', { localStorage: mockLocalStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockStorage.clear();
  });

  describe('readResumeWorkspaceIds', () => {
    it('returns empty array when localStorage is empty', () => {
      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('returns parsed array from localStorage', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual(['ws-1', 'ws-2']);
    });

    it('handles malformed JSON gracefully', () => {
      mockStorage.set('ff_resume_workspace_ids', '{invalid json');

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('handles non-array JSON gracefully', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify({ not: 'array' }));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('handles array with non-string elements gracefully', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify([1, 2, 3]));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });

    it('handles mixed-type array gracefully', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1', 123, 'ws-2']));

      const result = readResumeWorkspaceIds();
      expect(result).toEqual([]);
    });
  });

  describe('rememberResumeWorkspace', () => {
    it('adds workspace ID to empty list', () => {
      rememberResumeWorkspace('ws-1');

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1'])
      );
    });

    it('adds workspace ID to existing list', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1']));

      rememberResumeWorkspace('ws-2');

      expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1', 'ws-2'])
      );
    });

    it('does not add duplicate workspace IDs', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1']));

      rememberResumeWorkspace('ws-1');

      expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1'])
      );
    });

    it('trims list to last 200 entries', () => {
      const ids = Array.from({ length: 205 }, (_, i) => `ws-${i}`);
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(ids));

      rememberResumeWorkspace('ws-new');

      const savedValue = mockLocalStorage.setItem.mock.calls[
        mockLocalStorage.setItem.mock.calls.length - 1
      ]![1] as string;
      const parsed = JSON.parse(savedValue);
      const savedIds = resumeWorkspaceIdsSchema.parse(parsed);
      expect(savedIds).toHaveLength(200);
      expect(savedIds[savedIds.length - 1]).toBe('ws-new');
    });
  });

  describe('forgetResumeWorkspace', () => {
    it('removes workspace ID from list', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      forgetResumeWorkspace('ws-1');

      expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-2'])
      );
    });

    it('handles removing non-existent ID', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1']));

      forgetResumeWorkspace('ws-2');

      expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith(
        'ff_resume_workspace_ids',
        JSON.stringify(['ws-1'])
      );
    });
  });

  describe('isResumeWorkspace', () => {
    it('returns true for remembered workspace', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      expect(isResumeWorkspace('ws-1')).toBe(true);
    });

    it('returns false for non-remembered workspace', () => {
      mockStorage.set('ff_resume_workspace_ids', JSON.stringify(['ws-1', 'ws-2']));

      expect(isResumeWorkspace('ws-3')).toBe(false);
    });

    it('returns false when localStorage is empty', () => {
      expect(isResumeWorkspace('ws-1')).toBe(false);
    });
  });
});

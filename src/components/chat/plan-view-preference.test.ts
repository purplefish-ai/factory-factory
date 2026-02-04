import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPlanViewMode, persistPlanViewMode } from './plan-view-preference';

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

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('localStorage', mockLocalStorage);
  vi.stubGlobal('window', { localStorage: mockLocalStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockStorage.clear();
  vi.clearAllMocks();
});

describe('loadPlanViewMode', () => {
  it('should return rendered when no stored preference exists', () => {
    const result = loadPlanViewMode();
    expect(result).toBe('rendered');
  });

  it('should return stored preference when valid', () => {
    mockStorage.set('ff:plan-view-mode', 'raw');
    const result = loadPlanViewMode();
    expect(result).toBe('raw');
  });

  it('should fall back to rendered for invalid stored values', () => {
    mockStorage.set('ff:plan-view-mode', 'invalid');
    const result = loadPlanViewMode();
    expect(result).toBe('rendered');
  });

  it('should return rendered on storage errors', () => {
    mockLocalStorage.getItem.mockImplementationOnce(() => {
      throw new Error('Storage error');
    });
    const result = loadPlanViewMode();
    expect(result).toBe('rendered');
  });
});

describe('persistPlanViewMode', () => {
  it('should store the preference', () => {
    persistPlanViewMode('raw');
    expect(mockStorage.get('ff:plan-view-mode')).toBe('raw');
  });

  it('should silently handle storage errors', () => {
    mockLocalStorage.setItem.mockImplementationOnce(() => {
      throw new Error('Storage full');
    });
    expect(() => persistPlanViewMode('rendered')).not.toThrow();
  });
});

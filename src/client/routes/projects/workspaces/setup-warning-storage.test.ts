import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSetupWarningDismissed,
  isSetupWarningDismissed,
  rememberSetupWarningDismissed,
} from './setup-warning-storage';

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

describe('setup-warning-storage', () => {
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

  it('remembers a dismissed setup warning for the same workspace and error', () => {
    rememberSetupWarningDismissed('ws-1', 'npm install failed');

    expect(isSetupWarningDismissed('ws-1', 'npm install failed')).toBe(true);
  });

  it('does not reuse dismissal for a different error message', () => {
    rememberSetupWarningDismissed('ws-1', 'npm install failed');

    expect(isSetupWarningDismissed('ws-1', 'pnpm install failed')).toBe(false);
  });

  it('does not reuse dismissal for a different workspace', () => {
    rememberSetupWarningDismissed('ws-1', 'npm install failed');

    expect(isSetupWarningDismissed('ws-2', 'npm install failed')).toBe(false);
  });

  it('forgets dismissal when the setup warning clears', () => {
    rememberSetupWarningDismissed('ws-1', 'npm install failed');

    forgetSetupWarningDismissed('ws-1');

    expect(isSetupWarningDismissed('ws-1', 'npm install failed')).toBe(false);
  });
});

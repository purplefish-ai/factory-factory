import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIHealthBannerContent,
  collectIssues,
  forgetDismissedCLIHealthWarning,
  getCLIHealthWarningFingerprint,
  isCLIHealthWarningDismissed,
  readDismissedCLIHealthWarningFingerprint,
  rememberDismissedCLIHealthWarning,
} from './cli-health-banner';

const mockStorage = new Map<string, string>();

const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    mockStorage.delete(key);
  }),
  clear: vi.fn(() => {
    mockStorage.clear();
  }),
  get length() {
    return mockStorage.size;
  },
  key: vi.fn((index: number) => {
    const keys = Array.from(mockStorage.keys());
    return keys[index] ?? null;
  }),
};

describe('collectIssues', () => {
  it('leaves both bundled runtime upgrades to the app', () => {
    const issues = collectIssues({
      claude: {
        isInstalled: true,
        isOutdated: true,
        version: '0.1.0',
        latestVersion: '0.2.0',
      },
      codex: {
        isInstalled: true,
        isAuthenticated: true,
        isOutdated: true,
        version: '1.0.0',
        latestVersion: '1.1.0',
      },
      github: {
        isInstalled: false,
        isAuthenticated: false,
      },
    });

    expect(issues.map((issue) => issue.title)).toEqual(['GitHub CLI not installed']);
  });

  it('shows managed Claude sign-in and runtime repair instructions', () => {
    const health = {
      claude: { isInstalled: true, isAuthenticated: false },
      codex: { isInstalled: true },
      github: { isInstalled: true, isAuthenticated: true },
    };
    expect(collectIssues(health)[0]?.description).toContain('setup terminal in Settings');
    expect(collectIssues(health)[0]?.description).toContain('If ff is installed');
    expect(collectIssues(health)).toContainEqual(
      expect.objectContaining({ description: expect.stringContaining('ff claude auth login') })
    );
    expect(
      collectIssues({ ...health, claude: { isInstalled: false, isAuthenticated: false } })
    ).toEqual([
      expect.objectContaining({
        title: 'Claude runtime unavailable',
        description: expect.stringContaining('Update or reinstall Factory Factory'),
      }),
    ]);
  });

  it('does not report codex outdated when codex auth is missing', () => {
    const issues = collectIssues({
      claude: {
        isInstalled: true,
      },
      codex: {
        isInstalled: true,
        isAuthenticated: false,
        isOutdated: true,
      },
      github: {
        isInstalled: true,
        isAuthenticated: true,
      },
    });

    expect(issues).toHaveLength(0);
  });

  it('tells users how to refresh expired GitHub CLI credentials', () => {
    const issues = collectIssues({
      claude: {
        isInstalled: true,
      },
      codex: {
        isInstalled: true,
        isAuthenticated: true,
      },
      github: {
        isInstalled: true,
        isAuthenticated: false,
      },
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        title: 'GitHub sign-in required',
        description: expect.stringContaining('gh auth refresh -h github.com'),
      })
    );
  });
});

describe('CLI health warning dismissal storage', () => {
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

  it('remembers a dismissed warning for the same warning fingerprint', () => {
    const issues = collectIssues({
      claude: { isInstalled: true },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: false, isAuthenticated: false },
    });
    const fingerprint = getCLIHealthWarningFingerprint(issues);

    rememberDismissedCLIHealthWarning(fingerprint);

    expect(isCLIHealthWarningDismissed(fingerprint)).toBe(true);
  });

  it('does not reuse dismissal when the runtime issue changes', () => {
    const health = {
      claude: { isInstalled: true, isAuthenticated: false },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: false, isAuthenticated: false },
    };
    rememberDismissedCLIHealthWarning(getCLIHealthWarningFingerprint(collectIssues(health)));
    const changed = collectIssues({
      ...health,
      claude: { isInstalled: false, isAuthenticated: false },
    });
    expect(isCLIHealthWarningDismissed(getCLIHealthWarningFingerprint(changed))).toBe(false);
  });

  it('forgets a dismissed warning after warnings clear', () => {
    const issues = collectIssues({
      claude: { isInstalled: true },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: false, isAuthenticated: false },
    });

    rememberDismissedCLIHealthWarning(getCLIHealthWarningFingerprint(issues));
    forgetDismissedCLIHealthWarning();

    expect(readDismissedCLIHealthWarningFingerprint()).toBeNull();
  });

  it('ignores localStorage failures', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error('blocked');
        }),
        setItem: vi.fn(() => {
          throw new Error('blocked');
        }),
        removeItem: vi.fn(() => {
          throw new Error('blocked');
        }),
      },
    });

    expect(readDismissedCLIHealthWarningFingerprint()).toBeNull();
    expect(() => rememberDismissedCLIHealthWarning('fingerprint')).not.toThrow();
    expect(() => forgetDismissedCLIHealthWarning()).not.toThrow();
    expect(isCLIHealthWarningDismissed('fingerprint')).toBe(false);
  });
});

describe('CLIHealthBannerContent', () => {
  const callbacks = { isRefetching: false, onRecheck: vi.fn(), onDismiss: vi.fn() };
  const warning = {
    title: 'Claude sign-in required',
    description: 'Run "ff claude auth login" in your terminal to authenticate.',
  };

  it('shows managed login instructions with recheck and dismiss actions', () => {
    const markup = renderToStaticMarkup(
      <CLIHealthBannerContent {...callbacks} issues={[warning]} />
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('ff claude auth login');
    expect(markup).toContain('Recheck');
    expect(markup).toContain('Dismiss');
    expect(markup).not.toContain('Update Claude');
    expect(markup).not.toContain('<a');
  });

  it('disables recheck while a refresh is running', () => {
    const markup = renderToStaticMarkup(
      <CLIHealthBannerContent {...callbacks} issues={[warning]} isRefetching />
    );
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it('renders nothing when all issues have cleared', () => {
    expect(renderToStaticMarkup(<CLIHealthBannerContent {...callbacks} issues={[]} />)).toBe('');
  });
});

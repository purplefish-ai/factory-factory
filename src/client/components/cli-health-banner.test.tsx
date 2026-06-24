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
  it('collects outdated and missing CLI issues', () => {
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

    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.title)).toEqual([
      'Claude CLI out of date',
      'GitHub CLI not installed',
      'Codex CLI out of date',
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
        title: 'GitHub CLI not authenticated',
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

  it('does not reuse dismissal when the latest version changes', () => {
    const dismissedIssues = collectIssues({
      claude: {
        isInstalled: true,
        isOutdated: true,
        version: '0.1.0',
        latestVersion: '0.2.0',
      },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: true },
    });
    const updatedIssues = collectIssues({
      claude: {
        isInstalled: true,
        isOutdated: true,
        version: '0.1.0',
        latestVersion: '0.3.0',
      },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: true },
    });

    rememberDismissedCLIHealthWarning(getCLIHealthWarningFingerprint(dismissedIssues));

    expect(isCLIHealthWarningDismissed(getCLIHealthWarningFingerprint(updatedIssues))).toBe(false);
  });

  it('does not reuse dismissal when the issue set changes', () => {
    const dismissedIssues = collectIssues({
      claude: { isInstalled: true },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: false, isAuthenticated: false },
    });
    const updatedIssues = collectIssues({
      claude: {
        isInstalled: true,
        isOutdated: true,
        version: '0.1.0',
        latestVersion: '0.2.0',
      },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: false, isAuthenticated: false },
    });

    rememberDismissedCLIHealthWarning(getCLIHealthWarningFingerprint(dismissedIssues));

    expect(isCLIHealthWarningDismissed(getCLIHealthWarningFingerprint(updatedIssues))).toBe(false);
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
  it('renders compact mobile-first structure with accessible actions', () => {
    const markup = renderToStaticMarkup(
      <CLIHealthBannerContent
        issues={[
          {
            title: 'Codex CLI out of date',
            description: 'Installed 1.0.0; latest is 1.1.0.',
            link: 'https://developers.openai.com/codex/app-server/',
            linkLabel: 'Upgrade',
            upgradeProvider: 'CODEX',
          },
        ]}
        isRefetching={false}
        isUpgrading={false}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onUpgrade={vi.fn()}
      />
    );

    expect(markup).toContain('sm:flex-row');
    expect(markup).toContain('hidden sm:inline');
    expect(markup).toContain('sm:hidden');
    expect(markup).toContain('hidden items-center gap-2 self-start sm:flex');
    expect(markup).toContain('Recheck');
    expect(markup).toContain('Dismiss');
    expect(markup).toContain('Upgrade now');
  });
});

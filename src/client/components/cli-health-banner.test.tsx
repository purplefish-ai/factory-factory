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
  it('reports Claude freshness while leaving bundled Codex upgrades to the app', () => {
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

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.title)).toEqual([
      'Claude update available',
      'GitHub CLI not installed',
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
  const callbacks = {
    isRefetching: false,
    isUpgrading: false,
    onRecheck: vi.fn(),
    onDismiss: vi.fn(),
    onUpgrade: vi.fn(),
  };
  const update = {
    title: 'Claude update available',
    description: 'Installed 1.0.0; latest is 1.1.0.',
    link: 'https://claude.ai/download',
    linkLabel: 'Upgrade',
    upgradeProvider: 'CLAUDE' as const,
  };
  const warning = {
    title: 'GitHub sign-in required',
    description: 'Run "gh auth login" in your terminal to enable PR management.',
  };

  it('offers one update action without presenting optional updates as warnings', () => {
    const markup = renderToStaticMarkup(
      <CLIHealthBannerContent {...callbacks} issues={[update]} />
    );

    expect(markup).toContain('Update Claude');
    expect(markup.match(/<button[^>]*aria-label="Update Claude"/g)).toHaveLength(1);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('bg-warning');
    expect(markup).not.toContain('Some features require additional setup');
    expect(markup).not.toContain('<a');
    expect(markup).toContain('Dismiss');
  });

  it('keeps a sign-in warning separate from the optional update action', () => {
    const markup = renderToStaticMarkup(
      <CLIHealthBannerContent {...callbacks} issues={[update, warning]} />
    );

    expect(markup.match(/role="alert"/g)).toHaveLength(1);
    const alert = markup.slice(markup.indexOf('role="alert"'), markup.indexOf('</li>'));
    expect(alert).toContain('GitHub sign-in required');
    expect(alert).toContain('gh auth login');
    expect(alert).not.toContain('Update Claude');
    expect(markup).toContain('Update Claude');
    expect(markup).toContain('Recheck');
  });

  it('disables updates and rechecks while an update is running', () => {
    const markup = renderToStaticMarkup(
      <CLIHealthBannerContent {...callbacks} issues={[update, warning]} isUpgrading />
    );

    expect(markup).toContain('Updating Claude');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('aria-busy="true"');
  });

  it('renders nothing when all issues have cleared', () => {
    expect(renderToStaticMarkup(<CLIHealthBannerContent {...callbacks} issues={[]} />)).toBe('');
  });
});

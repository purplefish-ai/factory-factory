import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CLIHealthBannerContent, collectIssues } from './cli-health-banner';

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
    expect(markup).toContain('sr-only sm:not-sr-only');
    expect(markup).toContain('Recheck');
    expect(markup).toContain('Dismiss');
    expect(markup).toContain('Upgrade now');
  });
});

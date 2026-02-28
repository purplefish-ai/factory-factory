import { describe, expect, it } from 'vitest';
import {
  getProviderBlockingIssue,
  getProviderUnavailableMessage,
} from './provider-cli-availability';

describe('provider-cli-availability', () => {
  it('returns null when provider requirements are met', () => {
    const health = {
      claude: { isInstalled: true },
      codex: { isInstalled: true, isAuthenticated: true },
      opencode: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: true,
    };

    expect(getProviderBlockingIssue('CLAUDE', health)).toBeNull();
    expect(getProviderBlockingIssue('CODEX', health)).toBeNull();
    expect(getProviderBlockingIssue('OPENCODE', health)).toBeNull();
  });

  it('reports missing claude install', () => {
    const health = {
      claude: { isInstalled: false, error: 'Claude CLI is not installed.' },
      codex: { isInstalled: true, isAuthenticated: true },
      opencode: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: false,
    };

    expect(getProviderBlockingIssue('CLAUDE', health)).toContain('not installed');
    expect(getProviderUnavailableMessage('CLAUDE', health)).toContain(
      'Claude provider is unavailable'
    );
  });

  it('reports codex auth as blocking', () => {
    const health = {
      claude: { isInstalled: true },
      codex: {
        isInstalled: true,
        isAuthenticated: false,
        error: 'Codex CLI is not authenticated.',
      },
      opencode: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: true,
    };

    expect(getProviderBlockingIssue('CODEX', health)).toContain('not authenticated');
    expect(getProviderUnavailableMessage('CODEX', health)).toContain(
      'Codex provider is unavailable'
    );
  });

  it('reports opencode auth as blocking', () => {
    const health = {
      claude: { isInstalled: true },
      codex: { isInstalled: true, isAuthenticated: true },
      opencode: {
        isInstalled: true,
        isAuthenticated: false,
        error: 'Opencode CLI is not authenticated.',
      },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: true,
    };

    expect(getProviderBlockingIssue('OPENCODE', health)).toContain('not authenticated');
    expect(getProviderUnavailableMessage('OPENCODE', health)).toContain(
      'Opencode provider is unavailable'
    );
  });
});

import { describe, expect, it } from 'vitest';
import { getWarning } from './provider-cli-warning';

const healthyClaudeCodex = {
  claude: { isInstalled: true, isOutdated: false },
  codex: { isInstalled: true, isAuthenticated: true, isOutdated: false },
};

describe('getWarning', () => {
  it('warns when Claude CLI is not installed', () => {
    const warning = getWarning('CLAUDE', {
      ...healthyClaudeCodex,
      claude: { isInstalled: false },
    });
    expect(warning).not.toBeNull();
    expect(warning?.title).toContain('not installed');
  });

  it('warns when Codex CLI is not authenticated', () => {
    const warning = getWarning('CODEX', {
      ...healthyClaudeCodex,
      codex: { isInstalled: true, isAuthenticated: false },
    });
    expect(warning).not.toBeNull();
    expect(warning?.title).toContain('not authenticated');
  });

  it('never warns for OPENHANDS regardless of CLI health', () => {
    const fullyUnhealthy = {
      claude: { isInstalled: false, isOutdated: true },
      codex: { isInstalled: false, isAuthenticated: false, isOutdated: true },
    };
    // OpenHands is spawned server-side via `openhands acp` with no local CLI,
    // so it is never subject to CLI install/auth warnings.
    expect(getWarning('OPENHANDS', fullyUnhealthy)).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    checkHealth: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { githubCLIService } from '@/backend/domains/github';
import { cliHealthService } from './cli-health.service';

describe('cliHealthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliHealthService.clearCache();
  });

  it('treats Codex CLI as optional for allHealthy', async () => {
    vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: 'claude 1.2.3',
    });
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue({
      isInstalled: false,
      isAuthenticated: false,
      error: 'Codex not installed',
    });
    vi.mocked(githubCLIService.checkHealth).mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: '2.0.0',
    });

    const status = await cliHealthService.checkHealth(true);

    expect(status.codex.isInstalled).toBe(false);
    expect(status.allHealthy).toBe(true);
  });

  it('reports Codex as installed but unauthenticated', async () => {
    vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: 'claude 1.2.3',
    });
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: false,
      version: 'codex-cli 0.99.0',
      error: 'Codex CLI is not authenticated. Run `codex login` to authenticate.',
    });
    vi.mocked(githubCLIService.checkHealth).mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: '2.0.0',
    });

    const status = await cliHealthService.checkHealth(true);

    expect(status.codex.isInstalled).toBe(true);
    expect(status.codex.isAuthenticated).toBe(false);
    expect(status.allHealthy).toBe(true); // Codex auth is optional for allHealthy
  });

  it('reports unhealthy when required GitHub auth is missing', async () => {
    vi.spyOn(cliHealthService, 'checkClaudeCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: 'claude 1.2.3',
    });
    vi.spyOn(cliHealthService, 'checkCodexCLI').mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: 'codex-cli 0.99.0',
    });
    vi.mocked(githubCLIService.checkHealth).mockResolvedValue({
      isInstalled: true,
      isAuthenticated: false,
      version: '2.0.0',
    });

    const status = await cliHealthService.checkHealth(true);

    expect(status.allHealthy).toBe(false);
  });
});

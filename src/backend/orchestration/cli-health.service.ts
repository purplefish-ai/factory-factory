import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getBundledClaudeCommand } from '@/backend/lib/claude-cli-command';
import { getBundledCodexCommand } from '@/backend/lib/codex-cli-command';
import { SERVICE_CACHE_TTL_MS, SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { type GitHubCLIHealthStatus, githubCLIService } from '@/backend/services/github';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('cli-health');

export interface ClaudeCLIHealthStatus {
  isInstalled: boolean;
  isAuthenticated?: boolean;
  version?: string;
  latestVersion?: string;
  isOutdated?: boolean;
  error?: string;
}

export interface CodexCLIHealthStatus {
  isInstalled: boolean;
  isAuthenticated?: boolean;
  version?: string;
  latestVersion?: string;
  isOutdated?: boolean;
  error?: string;
}

export interface CLIHealthStatus {
  claude: ClaudeCLIHealthStatus;
  codex: CodexCLIHealthStatus;
  github: GitHubCLIHealthStatus;
  allHealthy: boolean;
}

export interface CLIUpgradeResult {
  provider: 'CLAUDE' | 'CODEX';
  packageName: string;
  command: string;
  output: string;
  health: CLIHealthStatus;
}

/**
 * Service for checking CLI dependencies health.
 * Checks that the managed Claude runtime and GitHub CLI are available and configured.
 * Codex is reported separately as an optional capability.
 */
class CLIHealthService {
  private cachedStatus: CLIHealthStatus | null = null;
  private cacheTimestamp = 0;
  private refreshInFlight: Promise<CLIHealthStatus> | null = null;

  /** Kept for older clients; provider runtimes are updated with the app. */
  upgradeProviderCLI(provider: 'CLAUDE' | 'CODEX'): Promise<CLIUpgradeResult> {
    const label = provider === 'CLAUDE' ? 'Claude' : 'Codex';
    return Promise.reject(
      new Error(
        `${label} is managed by Factory Factory. Update Factory Factory to update its ${label} runtime.`
      )
    );
  }

  /** Check the same bundled Claude executable used by ACP sessions. */
  async checkClaudeCLI(): Promise<ClaudeCLIHealthStatus> {
    try {
      const versionCommand = getBundledClaudeCommand(['--version']);
      const env = { ...getCurrentProcessEnv(), ELECTRON_RUN_AS_NODE: '1' };
      const { stdout } = await execFileAsync(versionCommand.command, versionCommand.args, {
        env,
        timeout: SERVICE_TIMEOUT_MS.claudeCliVersionCheck,
      });
      const version = stdout.trim().split('\n')[0];
      let isAuthenticated = false;
      try {
        const authCommand = getBundledClaudeCommand(['auth', 'status', '--json']);
        const { stdout: authStdout } = await execFileAsync(authCommand.command, authCommand.args, {
          env,
          timeout: SERVICE_TIMEOUT_MS.claudeCliAuthCheck,
        });
        const parsed = z.object({ loggedIn: z.boolean() }).safeParse(JSON.parse(authStdout));
        isAuthenticated = parsed.success && parsed.data.loggedIn;
      } catch {
        // A failed auth probe does not make the runtime unavailable.
      }
      return {
        isInstalled: true,
        isAuthenticated,
        version,
        ...(!isAuthenticated
          ? { error: 'Claude is not authenticated. Run `ff claude auth login` to authenticate.' }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isInstalled: false,
        isAuthenticated: false,
        error: `Bundled Claude runtime is unavailable. Update or reinstall Factory Factory. ${message}`,
      };
    }
  }

  /** Check the same bundled Codex executable used by ACP sessions. */
  async checkCodexCLI(): Promise<CodexCLIHealthStatus> {
    try {
      const versionCommand = getBundledCodexCommand(['--version']);
      const env = { ...getCurrentProcessEnv(), ELECTRON_RUN_AS_NODE: '1' };
      const { stdout } = await execFileAsync(versionCommand.command, versionCommand.args, {
        env,
        timeout: SERVICE_TIMEOUT_MS.codexCliVersionCheck,
      });
      const version = stdout.trim().split('\n')[0];
      try {
        const authCommand = getBundledCodexCommand(['login', 'status']);
        await execFileAsync(authCommand.command, authCommand.args, {
          env,
          timeout: SERVICE_TIMEOUT_MS.codexCliAuthCheck,
        });
        return { isInstalled: true, isAuthenticated: true, version };
      } catch {
        return {
          isInstalled: true,
          isAuthenticated: false,
          version,
          error: 'Codex is not authenticated. Run `ff codex login` to authenticate.',
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isInstalled: false,
        isAuthenticated: false,
        error: `Bundled Codex runtime is unavailable. Update or reinstall Factory Factory. ${message}`,
      };
    }
  }

  /**
   * Check health of all required CLIs.
   * Results are cached for CACHE_TTL_MS to avoid excessive process spawning.
   * Stale-while-revalidate: returns cached value immediately when stale,
   * firing a background refresh. forceRefresh bypasses this and blocks.
   */
  async checkHealth(forceRefresh = false): Promise<CLIHealthStatus> {
    // Serialize forced refreshes after older checks so they cannot overwrite new auth.
    if (forceRefresh && this.refreshInFlight) {
      await this.refreshInFlight.catch(() => undefined);
    }
    const cached = this.cachedStatus;
    if (
      !forceRefresh &&
      cached &&
      Date.now() - this.cacheTimestamp < SERVICE_CACHE_TTL_MS.cliHealth
    ) {
      return cached;
    }
    if (!this.refreshInFlight) {
      const refresh = this.runHealthCheck(forceRefresh)
        .then((status) => {
          // A cleared refresh can finish after the post-upgrade check.
          if (this.refreshInFlight === refresh) {
            this.cachedStatus = status;
            this.cacheTimestamp = Date.now();
          }
          return status;
        })
        .finally(() => {
          if (this.refreshInFlight === refresh) {
            this.refreshInFlight = null;
          }
        });
      this.refreshInFlight = refresh;
    }
    if (!forceRefresh && cached) {
      void this.refreshInFlight.catch(() => undefined);
      return cached;
    }
    return this.refreshInFlight;
  }

  private async runHealthCheck(forceRefresh = false): Promise<CLIHealthStatus> {
    logger.debug('Checking CLI health...');

    // Run checks in parallel
    const [claude, codex, github] = await Promise.all([
      this.checkClaudeCLI(),
      this.checkCodexCLI(),
      githubCLIService.checkHealth(forceRefresh),
    ]);

    const status: CLIHealthStatus = {
      claude,
      codex,
      github,
      allHealthy:
        claude.isInstalled &&
        claude.isAuthenticated === true &&
        github.isInstalled &&
        github.isAuthenticated,
    };

    if (!status.allHealthy) {
      logger.warn('CLI health check found issues', {
        claudeInstalled: claude.isInstalled,
        codexInstalled: codex.isInstalled,
        githubInstalled: github.isInstalled,
        githubAuthenticated: github.isAuthenticated,
      });
    }

    return status;
  }

  /**
   * Clear the cached health status.
   */
  clearCache(): void {
    this.cachedStatus = null;
    this.cacheTimestamp = 0;
    this.refreshInFlight = null;
  }
}

export const cliHealthService = new CLIHealthService();

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getBundledCodexCommand } from '@/backend/lib/codex-cli-command';
import { toError } from '@/backend/lib/error-utils';
import { SERVICE_CACHE_TTL_MS, SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { type GitHubCLIHealthStatus, githubCLIService } from '@/backend/services/github';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('cli-health');
const CLAUDE_CLI_NPM_PACKAGE = '@anthropic-ai/claude-code';

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
 * Checks that required CLIs (Claude, GitHub) are installed and configured.
 * Codex is reported separately as an optional capability.
 */
class CLIHealthService {
  private cachedStatus: CLIHealthStatus | null = null;
  private cacheTimestamp = 0;
  private refreshInFlight: Promise<CLIHealthStatus> | null = null;

  private extractSemver(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
    return match?.[0];
  }

  private compareSemver(left: string, right: string): number {
    const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
    const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));

    for (let idx = 0; idx < 3; idx += 1) {
      const l = leftParts[idx] ?? 0;
      const r = rightParts[idx] ?? 0;
      if (l !== r) {
        return l - r;
      }
    }

    return 0;
  }

  private async fetchLatestNpmVersion(packageName: string): Promise<string | undefined> {
    try {
      const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS.cliLatestVersionCheck),
      });
      if (!response.ok) {
        return undefined;
      }

      const payload = (await response.json()) as { version?: unknown };
      return typeof payload.version === 'string' ? payload.version : undefined;
    } catch {
      return undefined;
    }
  }

  private async buildVersionFreshness(input: {
    installedVersion: string | undefined;
    packageName: string;
  }): Promise<{ latestVersion?: string; isOutdated?: boolean }> {
    const latestRaw = await this.fetchLatestNpmVersion(input.packageName);
    const latestVersion = this.extractSemver(latestRaw) ?? latestRaw;
    const installedVersion = this.extractSemver(input.installedVersion) ?? input.installedVersion;

    if (!(installedVersion && latestVersion)) {
      return { latestVersion };
    }

    return {
      latestVersion,
      isOutdated: this.compareSemver(installedVersion, latestVersion) < 0,
    };
  }

  async upgradeProviderCLI(provider: 'CLAUDE' | 'CODEX'): Promise<CLIUpgradeResult> {
    if (provider === 'CODEX') {
      throw new Error(
        'Codex is managed by Factory Factory. Update Factory Factory to update its Codex runtime.'
      );
    }
    const packageName = CLAUDE_CLI_NPM_PACKAGE;
    const args = ['update'];

    try {
      // Use the same executable as the health check; a global npm install may
      // update a different installation from the Claude resolved on PATH.
      const { stdout, stderr } = await execFileAsync('claude', args, {
        timeout: SERVICE_TIMEOUT_MS.cliUpgrade,
      });
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

      // Invalidate cache and return refreshed health so callers can update UI immediately.
      this.clearCache();
      const health = await this.checkHealth(true);
      if (health.claude.isOutdated) {
        throw new Error(
          `Claude CLI is still outdated (installed ${health.claude.version}; latest ${health.claude.latestVersion}).\n${output}`
        );
      }

      return {
        provider,
        packageName,
        command: `claude ${args.join(' ')}`,
        output,
        health,
      };
    } catch (error) {
      const normalizedError = toError(error);
      const output =
        typeof error === 'object' && error !== null
          ? (error as { stderr?: unknown; stdout?: unknown })
          : {};
      const stderr = typeof output.stderr === 'string' ? output.stderr : undefined;
      const stdout = typeof output.stdout === 'string' ? output.stdout : undefined;
      const details = [normalizedError.message, stderr, stdout].filter(Boolean).join('\n');
      throw new Error(`Failed to upgrade Claude CLI via claude update: ${details}`);
    }
  }

  /**
   * Check if Claude CLI is installed and authenticated.
   * Uses `claude --version` for installation and `claude auth status --json` for auth.
   */
  async checkClaudeCLI(): Promise<ClaudeCLIHealthStatus> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], {
        timeout: SERVICE_TIMEOUT_MS.claudeCliVersionCheck,
      });
      const versionMatch = stdout.match(/claude[- ]?(?:code[- ]?)?(?:v?(\d+\.\d+\.\d+))?/i);
      const version = versionMatch?.[1] || stdout.trim().split('\n')[0];
      const versionFreshnessPromise = this.buildVersionFreshness({
        installedVersion: version,
        packageName: CLAUDE_CLI_NPM_PACKAGE,
      });

      let isAuthenticated = false;
      try {
        const { stdout: authStdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
          timeout: SERVICE_TIMEOUT_MS.claudeCliAuthCheck,
        });
        const parsed = z
          .object({ loggedIn: z.boolean().optional() })
          .safeParse(JSON.parse(authStdout));
        isAuthenticated = parsed.success && parsed.data.loggedIn === true;
      } catch {
        // Auth check failed — treat as unauthenticated
      }

      const versionFreshness = await versionFreshnessPromise;
      return { isInstalled: true, isAuthenticated, version, ...versionFreshness };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.toLowerCase().includes('enoent') || message.includes('not found');

      return {
        isInstalled: false,
        isAuthenticated: false,
        error: isNotFound
          ? 'Claude CLI is not installed. Install from https://claude.ai/download'
          : `Failed to check Claude CLI: ${message}`,
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { type GitHubCLIHealthStatus, githubCLIService } from '@/backend/domains/github';
import { toError } from '@/backend/lib/error-utils';
import { SERVICE_CACHE_TTL_MS, SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('cli-health');
const CLAUDE_CLI_NPM_PACKAGE = '@anthropic-ai/claude-code';
const CODEX_CLI_NPM_PACKAGE = '@openai/codex';

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

  private getProviderUpgradePackage(provider: 'CLAUDE' | 'CODEX'): string {
    return provider === 'CLAUDE' ? CLAUDE_CLI_NPM_PACKAGE : CODEX_CLI_NPM_PACKAGE;
  }

  async upgradeProviderCLI(provider: 'CLAUDE' | 'CODEX'): Promise<CLIUpgradeResult> {
    const packageName = this.getProviderUpgradePackage(provider);
    const args = ['install', '-g', packageName];

    try {
      const { stdout, stderr } = await execFileAsync('npm', args, {
        timeout: SERVICE_TIMEOUT_MS.cliUpgrade,
      });

      // Invalidate cache and return refreshed health so callers can update UI immediately.
      this.clearCache();
      const health = await this.checkHealth(true);

      return {
        provider,
        packageName,
        command: `npm ${args.join(' ')}`,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
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
      throw new Error(
        `Failed to upgrade ${provider === 'CLAUDE' ? 'Claude' : 'Codex'} CLI via npm: ${details}`
      );
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

  /**
   * Check if Codex CLI is installed and authenticated.
   * Uses `codex --version` for installation and `codex login status` for auth.
   */
  async checkCodexCLI(): Promise<CodexCLIHealthStatus> {
    try {
      const { stdout } = await execFileAsync('codex', ['--version'], {
        timeout: SERVICE_TIMEOUT_MS.codexCliVersionCheck,
      });
      const version = stdout.trim().split('\n')[0];
      const versionFreshnessPromise = this.buildVersionFreshness({
        installedVersion: version,
        packageName: CODEX_CLI_NPM_PACKAGE,
      });

      try {
        await execFileAsync('codex', ['login', 'status'], {
          timeout: SERVICE_TIMEOUT_MS.codexCliAuthCheck,
        });
        const versionFreshness = await versionFreshnessPromise;
        return { isInstalled: true, isAuthenticated: true, version, ...versionFreshness };
      } catch {
        const versionFreshness = await versionFreshnessPromise;
        return {
          isInstalled: true,
          isAuthenticated: false,
          version,
          ...versionFreshness,
          error: 'Codex CLI is not authenticated. Run `codex login` to authenticate.',
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.toLowerCase().includes('enoent') || message.includes('not found');

      return {
        isInstalled: false,
        isAuthenticated: false,
        error: isNotFound
          ? 'Codex CLI is not installed. Install from https://developers.openai.com/codex/app-server/'
          : `Failed to check Codex CLI: ${message}`,
      };
    }
  }

  /**
   * Check health of all required CLIs.
   * Results are cached for CACHE_TTL_MS to avoid excessive process spawning.
   */
  async checkHealth(forceRefresh = false): Promise<CLIHealthStatus> {
    const now = Date.now();

    // Return cached result if still valid
    if (
      !forceRefresh &&
      this.cachedStatus &&
      now - this.cacheTimestamp < SERVICE_CACHE_TTL_MS.cliHealth
    ) {
      return this.cachedStatus;
    }

    logger.debug('Checking CLI health...');

    // Run checks in parallel
    const [claude, codex, github] = await Promise.all([
      this.checkClaudeCLI(),
      this.checkCodexCLI(),
      githubCLIService.checkHealth(),
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

    // Cache the result
    this.cachedStatus = status;
    this.cacheTimestamp = now;

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
  }
}

export const cliHealthService = new CLIHealthService();

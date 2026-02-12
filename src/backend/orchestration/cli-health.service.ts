import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type GitHubCLIHealthStatus, githubCLIService } from '@/backend/domains/github';
import { SERVICE_CACHE_TTL_MS, SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';

const execFileAsync = promisify(execFile);
const logger = createLogger('cli-health');

export interface ClaudeCLIHealthStatus {
  isInstalled: boolean;
  version?: string;
  error?: string;
}

export interface CodexCLIHealthStatus {
  isInstalled: boolean;
  version?: string;
  error?: string;
}

export interface CLIHealthStatus {
  claude: ClaudeCLIHealthStatus;
  codex: CodexCLIHealthStatus;
  github: GitHubCLIHealthStatus;
  allHealthy: boolean;
}

/**
 * Service for checking CLI dependencies health.
 * Checks that required CLIs (Claude, GitHub) are installed and configured.
 */
class CLIHealthService {
  private cachedStatus: CLIHealthStatus | null = null;
  private cacheTimestamp = 0;

  /**
   * Check if Claude CLI is installed.
   */
  async checkClaudeCLI(): Promise<ClaudeCLIHealthStatus> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], {
        timeout: SERVICE_TIMEOUT_MS.claudeCliVersionCheck,
      });
      const versionMatch = stdout.match(/claude[- ]?(?:code[- ]?)?(?:v?(\d+\.\d+\.\d+))?/i);
      const version = versionMatch?.[1] || stdout.trim().split('\n')[0];

      return { isInstalled: true, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.toLowerCase().includes('enoent') || message.includes('not found');

      return {
        isInstalled: false,
        error: isNotFound
          ? 'Claude CLI is not installed. Install from https://claude.ai/download'
          : `Failed to check Claude CLI: ${message}`,
      };
    }
  }

  /**
   * Check if Codex CLI is installed and exposes app-server support.
   */
  async checkCodexCLI(): Promise<CodexCLIHealthStatus> {
    try {
      const { stdout } = await execFileAsync('codex', ['--version'], {
        timeout: SERVICE_TIMEOUT_MS.claudeCliVersionCheck,
      });
      return { isInstalled: true, version: stdout.trim().split('\n')[0] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.toLowerCase().includes('enoent') || message.includes('not found');

      return {
        isInstalled: false,
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
        claude.isInstalled && codex.isInstalled && github.isInstalled && github.isAuthenticated,
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

import { execCommand } from '../lib/shell.js';

export interface PRInfo {
  url: string;
  number: number;
  state: string;
  title: string;
}

export interface PRStatus {
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
}

/**
 * Execute a gh CLI command with consistent error handling
 */
async function runGhCommand(args: string[], operation: string, repoPath?: string): Promise<string> {
  const fullArgs = repoPath ? ['-C', repoPath, ...args] : args;

  try {
    const { stdout, code } = await execCommand('gh', fullArgs);
    if (code !== 0) {
      throw new Error(`gh ${args[0]} exited with code ${code}`);
    }
    return stdout;
  } catch (error) {
    throw new Error(
      `Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

class GitHubClient {
  async checkInstalled(): Promise<boolean> {
    try {
      await execCommand('gh', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async checkAuthenticated(): Promise<boolean> {
    try {
      const { stdout } = await execCommand('gh', ['auth', 'status']);
      return stdout.includes('Logged in');
    } catch {
      return false;
    }
  }

  async createPR(
    from: string,
    to: string,
    title: string,
    description: string,
    repoPath?: string
  ): Promise<PRInfo> {
    const args = [
      'pr',
      'create',
      '--base',
      to,
      '--head',
      from,
      '--title',
      title,
      '--body',
      description,
    ];
    const stdout = await runGhCommand(args, 'create PR', repoPath);
    const url = stdout.trim();

    return {
      url,
      number: this.extractPRNumber(url),
      state: 'OPEN',
      title,
    };
  }

  async getPRStatus(prUrl: string, repoPath?: string): Promise<PRStatus> {
    const args = ['pr', 'view', prUrl, '--json', 'state,isDraft,mergeable,reviewDecision'];
    const stdout = await runGhCommand(args, 'get PR status', repoPath);
    const data = JSON.parse(stdout);

    return {
      state: data.state,
      isDraft: data.isDraft,
      mergeable: data.mergeable,
      reviewDecision: data.reviewDecision,
    };
  }

  async mergePR(prUrl: string, repoPath?: string): Promise<string> {
    const args = ['pr', 'merge', prUrl, '--squash', '--auto'];
    const stdout = await runGhCommand(args, 'merge PR', repoPath);
    return stdout.trim();
  }

  async getPRInfo(prUrl: string, repoPath?: string): Promise<PRInfo> {
    const args = ['pr', 'view', prUrl, '--json', 'number,state,title,url'];
    const stdout = await runGhCommand(args, 'get PR info', repoPath);
    const data = JSON.parse(stdout);

    return {
      url: data.url,
      number: data.number,
      state: data.state,
      title: data.title,
    };
  }

  private extractPRNumber(url: string): number {
    const match = url.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Could not extract PR number from URL: ${url}`);
    }
    return Number.parseInt(match[1], 10);
  }
}

export const githubClient = new GitHubClient();

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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

export class GitHubClient {
  async checkInstalled(): Promise<boolean> {
    try {
      await execAsync('gh --version');
      return true;
    } catch {
      return false;
    }
  }

  async checkAuthenticated(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('gh auth status');
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
    const cwd = repoPath ? `-C "${repoPath}"` : '';
    const command = `gh ${cwd} pr create --base "${to}" --head "${from}" --title "${this.escapeShellArg(
      title
    )}" --body "${this.escapeShellArg(description)}"`;

    try {
      const { stdout } = await execAsync(command, repoPath ? { cwd: repoPath } : undefined);
      const url = stdout.toString().trim();

      const prNumber = this.extractPRNumber(url);

      return {
        url,
        number: prNumber,
        state: 'OPEN',
        title,
      };
    } catch (error) {
      throw new Error(
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getPRStatus(prUrl: string, repoPath?: string): Promise<PRStatus> {
    const cwd = repoPath ? `-C "${repoPath}"` : '';
    const command = `gh ${cwd} pr view "${prUrl}" --json state,isDraft,mergeable,reviewDecision`;

    try {
      const { stdout } = await execAsync(command, repoPath ? { cwd: repoPath } : undefined);
      const data = JSON.parse(stdout.toString());

      return {
        state: data.state,
        isDraft: data.isDraft,
        mergeable: data.mergeable,
        reviewDecision: data.reviewDecision,
      };
    } catch (error) {
      throw new Error(
        `Failed to get PR status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async mergePR(prUrl: string, repoPath?: string): Promise<string> {
    const cwd = repoPath ? `-C "${repoPath}"` : '';
    const command = `gh ${cwd} pr merge "${prUrl}" --squash --auto`;

    try {
      const { stdout } = await execAsync(command, repoPath ? { cwd: repoPath } : undefined);
      return stdout.toString().trim();
    } catch (error) {
      throw new Error(
        `Failed to merge PR: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getPRInfo(prUrl: string, repoPath?: string): Promise<PRInfo> {
    const cwd = repoPath ? `-C "${repoPath}"` : '';
    const command = `gh ${cwd} pr view "${prUrl}" --json number,state,title,url`;

    try {
      const { stdout } = await execAsync(command, repoPath ? { cwd: repoPath } : undefined);
      const data = JSON.parse(stdout.toString());

      return {
        url: data.url,
        number: data.number,
        state: data.state,
        title: data.title,
      };
    } catch (error) {
      throw new Error(
        `Failed to get PR info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private extractPRNumber(url: string): number {
    const match = url.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Could not extract PR number from URL: ${url}`);
    }
    return Number.parseInt(match[1], 10);
  }

  private escapeShellArg(arg: string): string {
    return arg.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  }
}

export const githubClient = new GitHubClient();

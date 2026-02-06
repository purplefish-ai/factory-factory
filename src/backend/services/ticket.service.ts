/**
 * Ticket Service
 *
 * Abstracts ticket creation behind a common interface.
 * Initial implementation uses GitHub Issues via the gh CLI.
 * Designed for easy extensibility to Linear, Jira, etc.
 */

import { createLogger } from './logger.service';

const logger = createLogger('ticket');

// =============================================================================
// Interface
// =============================================================================

export interface CreateIssueParams {
  /** GitHub owner/repo or project identifier */
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface TicketProvider {
  createIssue(params: CreateIssueParams): Promise<CreatedIssue>;
}

// =============================================================================
// GitHub Implementation
// =============================================================================

class GitHubTicketProvider implements TicketProvider {
  async createIssue(params: CreateIssueParams): Promise<CreatedIssue> {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const execFileAsync = promisify(execFile);

    const args = [
      'issue',
      'create',
      '--repo',
      `${params.owner}/${params.repo}`,
      '--title',
      params.title,
      '--body',
      params.body,
    ];

    if (params.labels && params.labels.length > 0) {
      for (const label of params.labels) {
        args.push('--label', label);
      }
    }

    logger.info('Creating GitHub issue', {
      owner: params.owner,
      repo: params.repo,
      title: params.title,
    });

    const { stdout } = await execFileAsync('gh', args, {
      timeout: 30_000,
    });

    // gh issue create returns the issue URL
    const url = stdout.trim();
    const numberMatch = url.match(/\/issues\/(\d+)/);
    const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : 0;

    logger.info('Created GitHub issue', { number, url });
    return { number, url };
  }
}

// =============================================================================
// Service
// =============================================================================

class TicketService {
  private provider: TicketProvider;

  constructor(provider?: TicketProvider) {
    this.provider = provider ?? new GitHubTicketProvider();
  }

  createIssue(params: CreateIssueParams): Promise<CreatedIssue> {
    return this.provider.createIssue(params);
  }
}

export const ticketService = new TicketService();

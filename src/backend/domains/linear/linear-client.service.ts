/**
 * Linear Client Service
 *
 * Wraps the @linear/sdk to provide typed methods for interacting with the Linear API.
 * All methods accept an API key parameter because keys are stored per-project.
 * The service is encryption-unaware — callers provide plain-text keys.
 */

import { LinearClient } from '@linear/sdk';
import { createLogger } from '@/backend/services/logger.service';

/** Normalized Linear team for UI display and selection. */
export interface LinearTeam {
  id: string;
  name: string;
  key: string; // e.g. "ENG"
}

/** Normalized Linear issue for Kanban display and workspace creation. */
export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "ENG-123"
  title: string;
  description: string;
  url: string;
  state: string; // Workflow state name, e.g. "Todo"
  createdAt: string;
  assigneeName: string | null;
}

/** Normalized Linear workflow state for state transitions. */
export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string; // 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
}

/** Result of validating a Linear API key. */
export interface LinearValidationResult {
  valid: boolean;
  viewerName?: string;
  error?: string;
}

const logger = createLogger('linear-client');

class LinearClientService {
  /** Create a LinearClient instance for the given API key. */
  private createClient(apiKey: string): LinearClient {
    return new LinearClient({ apiKey });
  }

  /** Validate an API key by fetching the authenticated viewer. */
  async validateApiKey(apiKey: string): Promise<LinearValidationResult> {
    try {
      const client = this.createClient(apiKey);
      const viewer = await client.viewer;
      return { valid: true, viewerName: viewer.displayName ?? viewer.name };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Linear API key validation failed', { error: message });
      return { valid: false, error: message };
    }
  }

  /** List teams accessible to the authenticated user. */
  async listTeams(apiKey: string): Promise<LinearTeam[]> {
    const client = this.createClient(apiKey);
    const connection = await client.teams();
    return connection.nodes.map((team) => ({
      id: team.id,
      name: team.name,
      key: team.key,
    }));
  }

  /**
   * List issues assigned to the authenticated user for a given team.
   * Filters to active cycle + unstarted state type by default.
   */
  async listMyIssues(apiKey: string, teamId: string): Promise<LinearIssue[]> {
    const client = this.createClient(apiKey);
    const viewer = await client.viewer;
    const issues = await viewer.assignedIssues({
      filter: {
        team: { id: { eq: teamId } },
        cycle: { isActive: { eq: true } },
        state: { type: { eq: 'unstarted' } },
      },
      first: 50,
    });

    const results: LinearIssue[] = [];
    for (const issue of issues.nodes) {
      const state = await issue.state;
      const assignee = await issue.assignee;
      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        url: issue.url,
        state: state?.name ?? 'Unknown',
        createdAt: issue.createdAt.toISOString(),
        assigneeName: assignee?.displayName ?? assignee?.name ?? null,
      });
    }

    return results;
  }

  /** Fetch a single issue by ID. */
  async getIssue(apiKey: string, issueId: string): Promise<LinearIssue | null> {
    try {
      const client = this.createClient(apiKey);
      const issue = await client.issue(issueId);
      const state = await issue.state;
      const assignee = await issue.assignee;
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        url: issue.url,
        state: state?.name ?? 'Unknown',
        createdAt: issue.createdAt.toISOString(),
        assigneeName: assignee?.displayName ?? assignee?.name ?? null,
      };
    } catch (error) {
      logger.warn('Failed to fetch Linear issue', {
        issueId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Find a workflow state for a team by state type.
   * Returns the first matching state, or null if none found.
   */
  async findWorkflowState(
    apiKey: string,
    teamId: string,
    stateType: 'unstarted' | 'started' | 'completed' | 'cancelled'
  ): Promise<LinearWorkflowState | null> {
    const client = this.createClient(apiKey);
    const states = await client.workflowStates({
      filter: {
        team: { id: { eq: teamId } },
        type: { eq: stateType },
      },
      first: 1,
    });

    const state = states.nodes[0];
    if (!state) {
      return null;
    }

    return {
      id: state.id,
      name: state.name,
      type: state.type,
    };
  }

  /**
   * Transition an issue to a new workflow state by state type.
   * Looks up the team's workflow state matching the target type, then updates the issue.
   */
  async transitionIssueState(
    apiKey: string,
    issueId: string,
    targetStateType: 'started' | 'completed' | 'cancelled'
  ): Promise<void> {
    const client = this.createClient(apiKey);

    // Get the issue to find its team
    const issue = await client.issue(issueId);
    const team = await issue.team;
    if (!team) {
      logger.warn('Cannot transition issue: no team found', { issueId });
      return;
    }

    // Find the target workflow state
    const targetState = await this.findWorkflowState(apiKey, team.id, targetStateType);
    if (!targetState) {
      logger.warn('Cannot transition issue: no workflow state found', {
        issueId,
        teamId: team.id,
        targetStateType,
      });
      return;
    }

    await client.updateIssue(issueId, { stateId: targetState.id });
    logger.info('Transitioned Linear issue state', {
      issueId,
      targetState: targetState.name,
      targetStateType,
    });
  }
}

export const linearClientService = new LinearClientService();

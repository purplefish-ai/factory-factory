import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    get info() {
      return mockLoggerInfo;
    },
    get debug() {
      return vi.fn();
    },
    get warn() {
      return mockLoggerWarn;
    },
    get error() {
      return vi.fn();
    },
  }),
}));

import { LinearClient } from '@linear/sdk';
import { linearClientService } from './linear-client.service';

const mockedLinearClient = vi.mocked(LinearClient);

const setMockClient = (client: unknown) => {
  mockedLinearClient.mockImplementation(function mockLinearClientConstructor() {
    return client as never;
  } as never);
};

describe('LinearClientService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLinearClient.mockReset();
  });

  describe('validateApiKey', () => {
    it('returns valid response with viewer display name', async () => {
      setMockClient({
        viewer: Promise.resolve({ displayName: 'Jane Doe', name: 'Jane' }),
      });

      const result = await linearClientService.validateApiKey('linear-api-key');

      expect(result).toEqual({ valid: true, viewerName: 'Jane Doe' });
      expect(mockedLinearClient).toHaveBeenCalledWith({ apiKey: 'linear-api-key' });
    });

    it('returns invalid response and logs warning on SDK error', async () => {
      setMockClient({
        viewer: Promise.reject(new Error('Invalid API key')),
      });

      const result = await linearClientService.validateApiKey('bad-key');

      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
      expect(mockLoggerWarn).toHaveBeenCalledWith('Linear API key validation failed', {
        error: 'Invalid API key',
      });
    });
  });

  describe('listTeams', () => {
    it('maps teams from Linear response', async () => {
      const teams = vi.fn().mockResolvedValue({
        nodes: [
          { id: 'team-1', name: 'Engineering', key: 'ENG' },
          { id: 'team-2', name: 'Product', key: 'PROD' },
        ],
      });
      setMockClient({ teams });

      const result = await linearClientService.listTeams('linear-api-key');

      expect(result).toEqual([
        { id: 'team-1', name: 'Engineering', key: 'ENG' },
        { id: 'team-2', name: 'Product', key: 'PROD' },
      ]);
      expect(teams).toHaveBeenCalledTimes(1);
    });
  });

  describe('validateKeyAndListTeams', () => {
    it('returns validation response with teams on success', async () => {
      const teams = vi.fn().mockResolvedValue({
        nodes: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }],
      });
      setMockClient({
        viewer: Promise.resolve({ displayName: null, name: 'Jane' }),
        teams,
      });

      const result = await linearClientService.validateKeyAndListTeams('linear-api-key');

      expect(result).toEqual({
        valid: true,
        viewerName: 'Jane',
        teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }],
      });
      expect(mockedLinearClient).toHaveBeenCalledTimes(2);
    });

    it('returns validation failure without listing teams', async () => {
      setMockClient({
        viewer: Promise.reject(new Error('Forbidden')),
      });

      const result = await linearClientService.validateKeyAndListTeams('bad-key');

      expect(result).toEqual({ valid: false, error: 'Forbidden' });
      expect(mockedLinearClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMyIssues', () => {
    it('returns normalized issues with fallbacks', async () => {
      const assignedIssues = vi.fn().mockResolvedValue({
        nodes: [
          {
            id: 'issue-1',
            identifier: 'ENG-1',
            title: 'First issue',
            description: null,
            url: 'https://linear.app/example/issue/ENG-1',
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
            state: Promise.resolve({ name: 'Todo' }),
            assignee: Promise.resolve({ displayName: 'Alice', name: 'Alice A.' }),
          },
          {
            id: 'issue-2',
            identifier: 'ENG-2',
            title: 'Second issue',
            description: 'Has details',
            url: 'https://linear.app/example/issue/ENG-2',
            createdAt: new Date('2024-01-02T00:00:00.000Z'),
            state: Promise.resolve(null),
            assignee: Promise.resolve({ displayName: null, name: 'Bob' }),
          },
        ],
      });
      setMockClient({
        viewer: Promise.resolve({ assignedIssues }),
      });

      const result = await linearClientService.listMyIssues('linear-api-key', 'team-1');

      expect(assignedIssues).toHaveBeenCalledWith({
        filter: {
          team: { id: { eq: 'team-1' } },
          state: { type: { eq: 'unstarted' } },
        },
        first: 50,
      });
      expect(result).toEqual([
        {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'First issue',
          description: '',
          url: 'https://linear.app/example/issue/ENG-1',
          state: 'Todo',
          createdAt: '2024-01-01T00:00:00.000Z',
          assigneeName: 'Alice',
        },
        {
          id: 'issue-2',
          identifier: 'ENG-2',
          title: 'Second issue',
          description: 'Has details',
          url: 'https://linear.app/example/issue/ENG-2',
          state: 'Unknown',
          createdAt: '2024-01-02T00:00:00.000Z',
          assigneeName: 'Bob',
        },
      ]);
    });
  });

  describe('getIssue', () => {
    it('returns normalized issue when found', async () => {
      const issue = {
        id: 'issue-1',
        identifier: 'ENG-1',
        title: 'Issue title',
        description: null,
        url: 'https://linear.app/example/issue/ENG-1',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        state: Promise.resolve({ name: 'In Progress' }),
        assignee: Promise.resolve({ displayName: null, name: 'Alice' }),
      };
      const getIssue = vi.fn().mockResolvedValue(issue);
      setMockClient({ issue: getIssue });

      const result = await linearClientService.getIssue('linear-api-key', 'issue-1');

      expect(getIssue).toHaveBeenCalledWith('issue-1');
      expect(result).toEqual({
        id: 'issue-1',
        identifier: 'ENG-1',
        title: 'Issue title',
        description: '',
        url: 'https://linear.app/example/issue/ENG-1',
        state: 'In Progress',
        createdAt: '2024-01-01T00:00:00.000Z',
        assigneeName: 'Alice',
      });
    });

    it('returns null and logs warning when fetch fails', async () => {
      const getIssue = vi.fn().mockRejectedValue(new Error('Issue not found'));
      setMockClient({ issue: getIssue });

      const result = await linearClientService.getIssue('linear-api-key', 'missing-issue');

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith('Failed to fetch Linear issue', {
        issueId: 'missing-issue',
        error: 'Issue not found',
      });
    });
  });

  describe('findWorkflowState', () => {
    it('returns null when no states are found', async () => {
      const workflowStates = vi.fn().mockResolvedValue({ nodes: [] });
      setMockClient({ workflowStates });

      const result = await linearClientService.findWorkflowState(
        'linear-api-key',
        'team-1',
        'started'
      );

      expect(result).toBeNull();
    });

    it('returns the earliest state by position for the requested type', async () => {
      const workflowStates = vi.fn().mockResolvedValue({
        nodes: [
          { id: 'state-2', name: 'In Progress', type: 'started', position: 20 },
          { id: 'state-1', name: 'Doing', type: 'started', position: 10 },
        ],
      });
      setMockClient({ workflowStates });

      const result = await linearClientService.findWorkflowState(
        'linear-api-key',
        'team-1',
        'started'
      );

      expect(result).toEqual({ id: 'state-1', name: 'Doing', type: 'started' });
    });
  });

  describe('transitionIssueState', () => {
    it('returns early when issue has no team', async () => {
      const getIssue = vi.fn().mockResolvedValue({
        team: Promise.resolve(null),
      });
      const updateIssue = vi.fn();
      setMockClient({
        issue: getIssue,
        updateIssue,
      });

      await linearClientService.transitionIssueState('linear-api-key', 'issue-1', 'started');

      expect(updateIssue).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith('Cannot transition issue: no team found', {
        issueId: 'issue-1',
      });
    });

    it('returns early when no matching workflow state exists', async () => {
      const getIssue = vi.fn().mockResolvedValue({
        team: Promise.resolve({ id: 'team-1' }),
      });
      const updateIssue = vi.fn();
      const workflowStates = vi.fn().mockResolvedValue({ nodes: [] });
      setMockClient({
        issue: getIssue,
        workflowStates,
        updateIssue,
      });

      await linearClientService.transitionIssueState('linear-api-key', 'issue-1', 'completed');

      expect(workflowStates).toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Cannot transition issue: no workflow state found',
        {
          issueId: 'issue-1',
          teamId: 'team-1',
          targetStateType: 'completed',
        }
      );
    });

    it('updates issue state when matching workflow state exists', async () => {
      const getIssue = vi.fn().mockResolvedValue({
        team: Promise.resolve({ id: 'team-1' }),
      });
      const updateIssue = vi.fn().mockResolvedValue(undefined);
      const workflowStates = vi.fn().mockResolvedValue({
        nodes: [{ id: 'state-1', name: 'Done', type: 'completed', position: 1 }],
      });
      setMockClient({
        issue: getIssue,
        workflowStates,
        updateIssue,
      });

      await linearClientService.transitionIssueState('linear-api-key', 'issue-1', 'completed');

      expect(updateIssue).toHaveBeenCalledWith('issue-1', { stateId: 'state-1' });
      expect(mockLoggerInfo).toHaveBeenCalledWith('Transitioned Linear issue state', {
        issueId: 'issue-1',
        targetState: 'Done',
        targetStateType: 'completed',
      });
    });
  });
});

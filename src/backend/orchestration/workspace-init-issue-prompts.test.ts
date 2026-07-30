import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    getIssue: vi.fn(),
  },
}));

vi.mock('@/backend/services/linear', () => ({
  linearClientService: {
    getIssue: vi.fn(),
  },
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {
    findByIdWithProject: vi.fn(),
  },
}));

vi.mock('./linear-config.helper', () => ({
  getDecryptedLinearConfig: vi.fn(),
}));

import { linearClientService } from '@/backend/services/linear';
import { workspaceDataService } from '@/backend/services/workspace';
import { getDecryptedLinearConfig } from './linear-config.helper';
import { buildInitialPromptFromLinearIssue } from './workspace-init-issue-prompts';

const logger = unsafeCoerce<Parameters<typeof buildInitialPromptFromLinearIssue>[1]>({
  info: vi.fn(),
  warn: vi.fn(),
});

function mockLinearIssueWorkspace(githubOwner: string | null, githubRepo: string | null) {
  vi.mocked(workspaceDataService.findByIdWithProject).mockResolvedValue(
    unsafeCoerce({
      id: 'workspace-1',
      linearIssueId: 'linear-issue-1',
      project: {
        githubOwner,
        githubRepo,
        issueTrackerConfig: {},
      },
    })
  );
}

describe('buildInitialPromptFromLinearIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDecryptedLinearConfig).mockReturnValue({
      apiKey: 'linear-api-key',
      teamId: 'linear-team-1',
    });
    vi.mocked(linearClientService.getIssue).mockResolvedValue({
      id: 'linear-issue-1',
      identifier: 'ENG-123',
      title: 'Fix screenshot instructions',
      description: 'Keep screenshot links usable without GitHub metadata.',
      url: 'https://linear.app/acme/issue/ENG-123',
      state: 'Todo',
      createdAt: '2026-07-30T00:00:00.000Z',
      creatorName: 'Test User',
    });
  });

  it.each([
    { githubOwner: null, githubRepo: null },
    { githubOwner: 'purplefish-ai', githubRepo: null },
    { githubOwner: null, githubRepo: 'factory-factory' },
  ])('uses a relative screenshot path when GitHub metadata is incomplete', async ({
    githubOwner,
    githubRepo,
  }) => {
    mockLinearIssueWorkspace(githubOwner, githubRepo);

    const prompt = await buildInitialPromptFromLinearIssue('workspace-1', logger);

    expect(prompt).toContain('# Linear Issue ENG-123');
    expect(prompt).toContain(
      `![Description](\${branch}/.factory-factory/screenshots/filename.png)`
    );
    expect(prompt).not.toContain('raw.githubusercontent.com');
  });

  it('uses the configured GitHub repository for screenshot paths', async () => {
    mockLinearIssueWorkspace('purplefish-ai', 'factory-factory');

    const prompt = await buildInitialPromptFromLinearIssue('workspace-1', logger);

    expect(prompt).toContain(
      `![Description](https://raw.githubusercontent.com/purplefish-ai/factory-factory/\${branch}/.factory-factory/screenshots/filename.png)`
    );
  });
});
